import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostResult } from "#src/lib/post-json.ts";
import {
  createRequestKey,
  createRequestKeys,
  isFinalAnswer,
  keyedRequest,
} from "#src/lib/use-request-key.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status });

/** Stubs fetch with these answers in order (an Error is a dropped connection) and lists the keys it was sent. */
function answers(...replies: (Response | Error)[]): string[] {
  const keys: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("idempotency-key") ?? "");
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no reply left");
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  );
  return keys;
}

const apply = (keys: ReturnType<typeof createRequestKey>, ids: string[] = ["a"]) =>
  keyedRequest(keys, `apply ${JSON.stringify({ itemIds: ids })}`, {
    method: "POST",
    path: "/v1/x/apply",
    payload: { itemIds: ids },
  });

describe("isFinalAnswer", () => {
  it.each<[string, PostResult, boolean]>([
    ["a 2xx", { ok: true, body: {}, status: 200 }, true],
    ["a 204", { ok: true, body: undefined, status: 204 }, true],
    ["a refusal", { ok: false, body: { code: "change_set_finished" }, status: 409 }, true],
    ["a 422", { ok: false, body: { code: "invalid_change_set" }, status: 422 }, true],
    ["a 4xx with no body", { ok: false, body: undefined, status: 403 }, true],
    [
      "busy, stored under the key, so final",
      { ok: false, body: { code: "change_set_busy" }, status: 409 },
      true,
    ],
    [
      "the same request running",
      { ok: false, body: { code: "request_in_progress" }, status: 409 },
      false,
    ],
    ["a 502", { ok: false, body: undefined, status: 502 }, false],
    ["a 503", { ok: false, body: { code: "busy" }, status: 503 }, false],
    ["a timeout or dropped connection", { ok: false, body: undefined, status: 0 }, false],
    ["a result built by hand", { ok: false, body: undefined }, false],
  ])("reads %s", (_name, result, final) => {
    expect(isFinalAnswer(result)).toBe(final);
  });
});

describe("keyedRequest", () => {
  it("keeps the key across a 502, a timeout and the same request still running, so the retry gets the stored answer", async () => {
    const sent = answers(
      json(502, {}),
      new Error("timed out"),
      json(409, { code: "request_in_progress" }),
      json(200, { ok: true }),
    );
    const keys = createRequestKey();
    for (let i = 0; i < 4; i++) await apply(keys);
    expect(sent).toHaveLength(4);
    expect(new Set(sent).size).toBe(1);
  });

  // `change_set_busy` is stored under its key (conventions.ts onSend keeps every answer below 500), so a kept key would
  // replay busy until the page reloads, even after the set is free.
  it("takes a new key after a busy answer", async () => {
    const sent = answers(json(409, { code: "change_set_busy" }), json(200, { ok: true }));
    const keys = createRequestKey();
    await apply(keys);
    await apply(keys);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
  });

  it("takes a new key after a 2xx and after a refusal", async () => {
    const sent = answers(
      json(200, {}),
      json(200, {}),
      json(409, { code: "change_set_finished" }),
      json(200, {}),
    );
    const keys = createRequestKey();
    for (let i = 0; i < 4; i++) await apply(keys);
    expect(new Set(sent).size).toBe(4);
  });

  it("takes a new key when the selection changes, even before a final answer", async () => {
    const sent = answers(json(502, {}), json(502, {}), json(200, {}));
    const keys = createRequestKey();
    await apply(keys, ["a"]);
    await apply(keys, ["a", "b"]);
    await apply(keys, ["a", "b"]);
    expect(sent[0]).not.toBe(sent[1]);
    expect(sent[1]).toBe(sent[2]);
  });
});

const close = (keys: ReturnType<typeof createRequestKey>) =>
  keyedRequest(keys, "close {}", { method: "POST", path: "/v1/x/close", payload: {} });

describe("createRequestKeys", () => {
  it("keeps an apply's key across a close, so the apply's retry replays instead of answering busy", async () => {
    const sent = answers(json(502, {}), json(200, {}), json(200, {}));
    const keys = createRequestKeys(["apply", "close"]);
    await apply(keys.apply);
    await close(keys.close);
    await apply(keys.apply);
    expect(sent[2]).toBe(sent[0]);
    expect(sent[1]).not.toBe(sent[0]);
  });

  it("gives each name its own slot", () => {
    const keys = createRequestKeys(["apply", "close"]);
    expect(keys.apply).not.toBe(keys.close);
    expect(keys.apply.keyFor("x")).not.toBe(keys.close.keyFor("x"));
  });
});
