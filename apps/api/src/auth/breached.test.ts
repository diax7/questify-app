import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BreachCheckUnavailable, createBreachCheck } from "#src/auth/breached";

const PASSWORD = "correct horse battery staple";
const SHA1 = createHash("sha1").update(PASSWORD).digest("hex").toUpperCase();
const PREFIX = SHA1.slice(0, 5);
const SUFFIX = SHA1.slice(5);
const OTHER = "0".repeat(35);

type Call = Readonly<{ url: string; init: RequestInit }>;

/** A fake range API that answers each call with the next item: a body, a status, or a thrown error. */
function fakeApi(answers: Array<string | number | Error>, clock?: { t: number; step: number }) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (clock !== undefined) {
      clock.t += clock.step;
    }
    const next = answers.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "number") {
      return new Response("", { status: next });
    }
    return new Response(next ?? "", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFake };
}

describe("createBreachCheck", () => {
  it("sends only the first five hex characters of the SHA-1, with padding asked for", async () => {
    const api = fakeApi([`${OTHER}:3\r\n`]);
    await createBreachCheck({ fetch: api.fetch })(PASSWORD);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toBe(`https://api.pwnedpasswords.com/range/${PREFIX}`);
    const headers = api.calls[0]?.init.headers as Record<string, string>;
    expect(headers["add-padding"]).toBe("true");
    expect(headers["user-agent"]).toBe("Questify-API");
    expect(api.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(api.calls[0]?.url).not.toContain(SUFFIX);
  });

  it("says breached when the suffix is listed with a count", async () => {
    const api = fakeApi([`${OTHER}:3\r\n${SUFFIX}:12\r\n`]);
    expect(await createBreachCheck({ fetch: api.fetch })(PASSWORD)).toBe(true);
  });

  it("says clean when the suffix is missing, or listed only as padding (count 0)", async () => {
    expect(await createBreachCheck({ fetch: fakeApi([`${OTHER}:3`]).fetch })(PASSWORD)).toBe(false);
    expect(await createBreachCheck({ fetch: fakeApi([`${SUFFIX}:0`]).fetch })(PASSWORD)).toBe(
      false,
    );
  });

  it("hashes the NFKC form, so the same password typed two ways gives one answer", async () => {
    const api = fakeApi(["", ""]);
    const check = createBreachCheck({ fetch: api.fetch });
    await check("ﬁve fine words here");
    await check("five fine words here");
    expect(api.calls[0]?.url).toBe(api.calls[1]?.url);
  });

  it.each([
    ["a network error", new TypeError("fetch failed")],
    ["a server error", 503],
    ["a rate limit", 429],
  ])("retries once after %s and uses the second answer", async (_label, first) => {
    const api = fakeApi([first, `${SUFFIX}:5`]);
    expect(await createBreachCheck({ fetch: api.fetch })(PASSWORD)).toBe(true);
    expect(api.calls).toHaveLength(2);
  });

  it("does not retry a client error, and fails closed", async () => {
    const api = fakeApi([404, `${SUFFIX}:5`]);
    await expect(createBreachCheck({ fetch: api.fetch })(PASSWORD)).rejects.toThrow(
      new BreachCheckUnavailable("The breached-password check did not answer (status 404)."),
    );
    expect(api.calls).toHaveLength(1);
  });

  it("fails closed when the retry fails too", async () => {
    const api = fakeApi([500, new TypeError("fetch failed")]);
    await expect(createBreachCheck({ fetch: api.fetch })(PASSWORD)).rejects.toThrow(
      "The breached-password check did not answer (TypeError).",
    );
    expect(api.calls).toHaveLength(2);
  });

  it("retries only when at least one second of the deadline is left", async () => {
    const late = { t: 0, step: 2001 };
    const lateApi = fakeApi([500, ""], late);
    await expect(
      createBreachCheck({ fetch: lateApi.fetch, now: () => late.t })(PASSWORD),
    ).rejects.toBeInstanceOf(BreachCheckUnavailable);
    expect(lateApi.calls).toHaveLength(1);

    const justInTime = { t: 0, step: 2000 };
    const okApi = fakeApi([500, ""], justInTime);
    await createBreachCheck({ fetch: okApi.fetch, now: () => justInTime.t })(PASSWORD);
    expect(okApi.calls).toHaveLength(2);
  });

  it("gives up at the deadline instead of waiting for a stuck service", async () => {
    const stuck = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(createBreachCheck({ fetch: stuck, deadlineMs: 50 })(PASSWORD)).rejects.toThrow(
      BreachCheckUnavailable,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("fails closed when the body cannot be read", async () => {
    const broken = (async () =>
      ({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error("reset")),
      }) as unknown as Response) as unknown as typeof fetch;
    const error = await createBreachCheck({ fetch: broken })(PASSWORD).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BreachCheckUnavailable);
    expect(error).toMatchObject({
      message: "The breached-password check did not answer (body).",
      cause: new Error("reset"),
    });
  });
});
