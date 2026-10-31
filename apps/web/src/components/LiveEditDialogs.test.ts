import { describe, expect, it } from "vitest";
import { pointsImpactOf } from "#src/components/LiveEditDialogs.tsx";

const impact = {
  eligible: true,
  completions: 4,
  players: 3,
  raise: 4,
  lower: 0,
  clamped: 0,
  prizesHanded: 1,
};

describe("pointsImpactOf (T-604)", () => {
  it("reads the impact answer", () => {
    expect(pointsImpactOf(impact)).toEqual(impact);
  });

  it("refuses anything else", () => {
    expect(pointsImpactOf(null)).toBeUndefined();
    expect(pointsImpactOf({ ...impact, eligible: "yes" })).toBeUndefined();
    expect(pointsImpactOf({ ...impact, clamped: "2" })).toBeUndefined();
  });
});
