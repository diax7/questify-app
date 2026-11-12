import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { createImageUrls } from "#src/event/organizer-images.ts";

const EVENT = "11111111-2222-4333-8444-555555555555";
const IMAGE = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const AT = Date.parse("2026-11-12T10:00:00Z");

const ok = (body: unknown): AuthedResult =>
  ({ kind: "ok", status: 200, body, headers: new Headers() }) as AuthedResult;

/** The app's organizer images (ADR-829): one read per image while its URL lasts, and Questify's art on any refusal. */
describe("the signed image URLs", () => {
  it("asks the event's image door for JSON once and keeps the URL until 30 seconds before it ends", async () => {
    const asked: string[] = [];
    let clock = AT;
    const urls = createImageUrls(
      async (request) => {
        asked.push(request.path);
        return ok({
          url: `https://bucket.example/${asked.length}`,
          expiresAt: new Date(AT + 300_000).toISOString(),
        });
      },
      () => clock,
    );
    expect(await urls.read(EVENT, IMAGE)).toMatchObject({ url: "https://bucket.example/1" });
    expect(await urls.read(EVENT, IMAGE)).toMatchObject({ url: "https://bucket.example/1" });
    expect(asked).toEqual([`/v1/events/${EVENT}/images/${IMAGE}`]);
    expect(urls.known(EVENT, IMAGE)?.url).toBe("https://bucket.example/1");
    clock = AT + 271_000;
    expect(urls.known(EVENT, IMAGE)).toBeUndefined();
    expect(await urls.read(EVENT, IMAGE)).toMatchObject({ url: "https://bucket.example/2" });
  });

  it("shares one read between screens that ask at once", async () => {
    let calls = 0;
    const urls = createImageUrls(
      async () => {
        calls += 1;
        return ok({
          url: "https://bucket.example/x",
          expiresAt: new Date(AT + 300_000).toISOString(),
        });
      },
      () => AT,
    );
    await Promise.all([urls.read(EVENT, IMAGE), urls.read(EVENT, IMAGE)]);
    expect(calls).toBe(1);
  });

  it("gives no URL for a refusal, no network, a sign-out, a broken answer or a URL that is not https", async () => {
    for (const result of [
      { kind: "error", status: 404, code: "not_found", body: undefined },
      { kind: "network" },
      { kind: "signed_out" },
      ok({ url: 42 }),
      ok({ url: "http://bucket.example/x", expiresAt: new Date(AT).toISOString() }),
      ok({ url: "https://bucket.example/x", expiresAt: "soon" }),
    ] as AuthedResult[]) {
      const urls = createImageUrls(
        async () => result,
        () => AT,
      );
      expect(await urls.read(EVENT, IMAGE)).toBeNull();
    }
    const failing = createImageUrls(
      () => Promise.reject(new Error("down")),
      () => AT,
    );
    expect(await failing.read(EVENT, IMAGE)).toBeNull();
  });
});
