import { describe, expect, it } from "vitest";
import { numberFieldPatch } from "#src/lib/number-field.ts";

describe("numberFieldPatch", () => {
  it("keeps the last value for an emptied field", () => {
    expect(numberFieldPatch("dayStartHour", "")).toBeNull();
  });

  it("turns typed text into a number under the key", () => {
    expect(numberFieldPatch("dayStartHour", "6")).toEqual({ dayStartHour: 6 });
    expect(numberFieldPatch("firstBonusSlots", "0")).toEqual({ firstBonusSlots: 0 });
    expect(numberFieldPatch("firstBonusPoints", "12.5")).toEqual({ firstBonusPoints: 12.5 });
  });
});
