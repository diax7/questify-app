import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isTransientFailure", () => {
  it.each([
    ["a dropped connection", { ok: false, body: undefined, status: 0 }],
    ["a server fault", { ok: false, body: undefined, status: 500 }],
    ["a bad gateway", { ok: false, body: undefined, status: 502 }],
    ["a failure with no status", { ok: false, body: undefined }],
  ] as const)("keeps the key after %s", (_name, result) => {
    expect(isTransientFailure(result)).toBe(true);
  });

  it.each([
    ["a validation refusal", { ok: false, body: {}, status: 422 }],
    ["a conflict", { ok: false, body: {}, status: 409 }],
    ["a missing page", { ok: false, body: {}, status: 404 }],
    ["a rate limit", { ok: false, body: {}, status: 429 }],
  ] as const)("ends the key after %s", (_name, result) => {
    expect(isTransientFailure(result)).toBe(false);
  });

  it("is false for a success", () => {
    expect(isTransientFailure({ ok: true, body: {}, status: 200 })).toBe(false);
  });
});

describe("requestJson", () => {
  it("answers the HTTP status with the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "daily_content_conflict" }), { status: 409 }),
      ),
    );
    expect(await requestJson("PUT", "/v1/x", { a: 1 })).toEqual({
      ok: false,
      body: { code: "daily_content_conflict" },
      status: 409,
    });
  });

  it("answers status 0 and no body when the connection drops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const result = await requestJson("GET", "/v1/x");
    expect(result).toEqual({ ok: false, body: undefined, status: 0 });
    expect(isTransientFailure(result)).toBe(true);
  });
});
