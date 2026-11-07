import { describe, expect, it } from "vitest";
import { closedKey } from "#src/components/ConsoleOwnerEmail.tsx";

describe("closedKey", () => {
  it("says the old address could not be told when a held change failed", () => {
    expect(closedKey({ state: "send_failed", appliesAt: "2026-11-07T10:00:00.000Z" })).toBe(
      "console.ownerEmail.last.noticeFailed",
    );
  });

  it("keeps the code's words for a change that never reached a hold", () => {
    expect(closedKey({ state: "send_failed", appliesAt: null })).toBe(
      "console.ownerEmail.last.sendFailed",
    );
  });

  it("reads other closed states from their own words, and falls back to cancelled", () => {
    expect(closedKey({ state: "stopped", appliesAt: "2026-11-07T10:00:00.000Z" })).toBe(
      "console.ownerEmail.last.stopped",
    );
    expect(closedKey({ state: "unknown", appliesAt: null })).toBe(
      "console.ownerEmail.last.cancelled",
    );
  });
});
