import { afterEach, describe, expect, it, vi } from "vitest";
import { saveExport } from "#src/components/AnalyticsExports.tsx";
import { EXPORT_TIMEOUT_MS } from "#src/lib/forward-timeout.ts";
import { EXPORT_REQUEST_TIMEOUT_MS } from "#src/lib/post-json.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const API = "/v1/organizers/o1/events/e1";

describe("saveExport timeout", () => {
  it("waits longer than the forwarder's 180 s", () => {
    expect(EXPORT_TIMEOUT_MS).toBe(180_000);
    expect(EXPORT_REQUEST_TIMEOUT_MS).toBeGreaterThan(180_000);
    expect(EXPORT_REQUEST_TIMEOUT_MS).toBeGreaterThan(EXPORT_TIMEOUT_MS);
  });

  it("limits the call to the export's timeout and answers failed when it runs out", async () => {
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = saveExport(API, "players", "en", "");
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(timeout).toHaveBeenCalledExactlyOnceWith(EXPORT_REQUEST_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(clock.signal);
    expect(settled).toBe(false);
    clock.abort();
    expect(await pending).toBe("failed");
  });
});
