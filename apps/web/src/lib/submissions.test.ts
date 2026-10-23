import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { FILTERS, canGiveReason, statusKey } from "#src/lib/submissions.ts";

describe("the submissions queue", () => {
  it("names each status and each tab in both languages", () => {
    for (const status of ["pending", "approved", "rejected", "removed"] as const) {
      expect(MESSAGES[statusKey(status)].en).not.toBe("");
    }
    expect(statusKey("removed")).toBe("submissions.status.removed");
    for (const filter of FILTERS) {
      expect(MESSAGES[`submissions.filter.${filter}`].ar).not.toBe("");
    }
    expect(FILTERS).toEqual(["pending", "unseen", "marked", "done"]);
  });

  it("needs a reason of 1 to 300 characters", () => {
    expect(canGiveReason("   ")).toBe(false);
    expect(canGiveReason("Off topic")).toBe(true);
    expect(canGiveReason("x".repeat(300))).toBe(true);
    expect(canGiveReason("x".repeat(301))).toBe(false);
  });
});
