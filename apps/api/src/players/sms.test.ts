import { describe, expect, it, vi } from "vitest";
import { createMsegatSender } from "#src/players/sms";

const OPTIONS = { userName: "nafes", apiKey: "test-key", sender: "Questify" } as const;
const MESSAGE = { to: "+966551234567", text: "رمز الدخول إلى Questify: 123456" } as const;

const answer = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const networkError = (code: string) =>
  Object.assign(new TypeError("fetch failed"), { cause: { code } });

describe("the Msegat sender", () => {
  it("sends the number without its plus, the services sender and the text in UTF-8", async () => {
    const fetch = vi.fn(async () => answer({ code: "1", message: "Success" }));
    const sender = createMsegatSender({ ...OPTIONS, fetch });
    expect(await sender.send(MESSAGE)).toEqual({ kind: "sent" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.msegat.com/gw/sendsms.php");
    expect(JSON.parse(String(init.body))).toEqual({
      userName: "nafes",
      apiKey: "test-key",
      numbers: "966551234567",
      userSender: "Questify",
      msg: MESSAGE.text,
      msgEncoding: "UTF8",
    });
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(sender.name).toBe("msegat");
  });

  it.each([["M0000"], [1]])("counts code %j as sent", async (code) => {
    const sender = createMsegatSender({ ...OPTIONS, fetch: async () => answer({ code }) });
    expect(await sender.send(MESSAGE)).toEqual({ kind: "sent" });
  });

  it.each(["1060", "1110", "1120", "M0037", "1061"])(
    "reports Msegat's refusal %s by its code",
    async (code) => {
      const sender = createMsegatSender({
        ...OPTIONS,
        fetch: async () => answer({ code, message: "x" }),
      });
      expect(await sender.send(MESSAGE)).toEqual({ kind: "refused", reason: code });
    },
  );

  it("calls an unreadable answer unknown: the code may still arrive", async () => {
    const sender = createMsegatSender({
      ...OPTIONS,
      fetch: async () => answer("<html>busy</html>", 502),
    });
    expect(await sender.send(MESSAGE)).toEqual({ kind: "unknown", reason: "http_502" });
  });

  it("calls a timeout unknown and never retries it (a retry could send the code twice)", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
      return answer({});
    });
    const sender = createMsegatSender({ ...OPTIONS, fetch, timeoutMs: 20 });
    expect(await sender.send(MESSAGE)).toEqual({ kind: "unknown", reason: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("calls any other network failure unknown, once", async () => {
    const fetch = vi.fn(async () => {
      throw networkError("ECONNRESET");
    });
    const sender = createMsegatSender({ ...OPTIONS, fetch });
    expect(await sender.send(MESSAGE)).toEqual({ kind: "unknown", reason: "network" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries once when the request never left, and then gives a definite refusal", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      const fetch = vi.fn(async () => {
        throw networkError(code);
      });
      const sender = createMsegatSender({ ...OPTIONS, fetch });
      expect(await sender.send(MESSAGE)).toEqual({ kind: "refused", reason: "unreachable" });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("succeeds on the retry when the first try never left", async () => {
    let calls = 0;
    const sender = createMsegatSender({
      ...OPTIONS,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          throw networkError("ECONNREFUSED");
        }
        return answer({ code: "1" });
      },
    });
    expect(await sender.send(MESSAGE)).toEqual({ kind: "sent" });
  });
});
