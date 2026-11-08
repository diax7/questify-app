import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPLY_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isTransientFailure,
  requestJson,
} from "#src/lib/post-json.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A promise that rejects when the call's signal aborts, like a hung connection or a stalled body. */
function rejectOnAbort<T>(init: RequestInit): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

describe("requestJson timeout", () => {
  it("answers status 0 when nothing arrives within the default 30 s, not before", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init: RequestInit) => rejectOnAbort<Response>(init)),
    );
    const pending = requestJson("GET", "/v1/x");
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toEqual({ ok: false, body: undefined, status: 0 });
    expect(isTransientFailure(result)).toBe(true);
  });

  it("waits as long as the call's own limit says, and gives up at it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init: RequestInit) => rejectOnAbort<Response>(init)),
    );
    const pending = requestJson("POST", "/v1/x", {}, {}, { timeoutMs: APPLY_REQUEST_TIMEOUT_MS });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS * 2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(APPLY_REQUEST_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, body: undefined, status: 0 });
  });

  it("answers status 0 when the body stalls after the headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: string, init: RequestInit) => {
        return { ok: true, status: 200, json: () => rejectOnAbort<unknown>(init) } as Response;
      }),
    );
    const pending = requestJson("GET", "/v1/x");
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, body: undefined, status: 0 });
  });

  it("hands fetch the abort signal and clears the timer once answered", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => {
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestJson("GET", "/v1/x")).toEqual({ ok: true, body: {}, status: 200 });
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
