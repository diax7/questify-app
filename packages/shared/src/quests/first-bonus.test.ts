import { describe, expect, it } from "vitest";
import { FIRST_BONUS_LIMITS, firstBonusProblem } from "#src/quests/first-bonus";

describe("firstBonusProblem (T-313)", () => {
  it("accepts off, stop and every value inside the limits, the edges included", () => {
    expect(firstBonusProblem(null)).toBeNull();
    expect(firstBonusProblem({ stop: true })).toBeNull();
    expect(firstBonusProblem({ points: 1, slots: 1 })).toBeNull();
    expect(firstBonusProblem({ points: 100_000, slots: 1000 })).toBeNull();
    expect(FIRST_BONUS_LIMITS).toEqual({
      points: { min: 1, max: 100_000 },
      slots: { min: 1, max: 1000 },
    });
  });

  it("names the points first, then the slots", () => {
    expect(firstBonusProblem({ points: 0, slots: 0 })).toBe("points");
    expect(firstBonusProblem({ points: 100_001, slots: 5 })).toBe("points");
    expect(firstBonusProblem({ points: 2.5, slots: 5 })).toBe("points");
    expect(firstBonusProblem({ points: 5, slots: 0 })).toBe("slots");
    expect(firstBonusProblem({ points: 5, slots: 1001 })).toBe("slots");
    expect(firstBonusProblem({ points: 5, slots: 1.5 })).toBe("slots");
  });
});
