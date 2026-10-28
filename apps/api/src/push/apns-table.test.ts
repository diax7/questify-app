import { describe, expect, it } from "vitest";

/**
 * apns.ts builds Apple's reason table when it loads. The import sits inside the test so that a table that cannot be
 * built fails a test: a module that throws at load only stops the files that import it from loading, which Stryker's
 * vitest runner does not count as a failed test (mutation run 40628312029).
 */
describe("Apple's reason table", () => {
  it("is built when apns.ts loads, one outcome per kind of reason", async () => {
    const { APNS_HOLD_MS, apnsResult } = await import("#src/push/apns");
    const at400 = (reason: string) =>
      apnsResult({ kind: "answer", status: 400, headers: {}, body: JSON.stringify({ reason }) });
    expect(at400("ExpiredToken")).toEqual({
      kind: "invalid_token",
      code: "ExpiredToken",
      ambiguous: false,
    });
    expect(at400("BadDeviceToken")).toEqual({
      kind: "invalid_token",
      code: "BadDeviceToken",
      ambiguous: true,
    });
    expect(at400("Shutdown")).toEqual({ kind: "requeue", code: "Shutdown", written: false });
    expect(at400("Forbidden")).toEqual({ kind: "hold", code: "Forbidden", holdMs: APNS_HOLD_MS });
  });
});
