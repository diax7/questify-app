import { describe, expect, it } from "vitest";
import { levelRewardsSchema } from "#src/questify/rewards";

const item = { id: "frame-a", kind: "frame", name: { ar: "ا", en: "A" }, visualKey: "frame-01" };
const answer = {
  level: { number: 2, title: { ar: "ا", en: "A" }, xp: 150, levelFrom: 100, nextLevelAt: 300 },
  levels: [
    { level: 1, xpFrom: 0, item: null, owned: false },
    { level: 2, xpFrom: 100, item, owned: true },
  ],
  achievements: [
    {
      id: "top-ten",
      name: { ar: "ا", en: "A" },
      visualKey: "ach-summit",
      tier: "gold",
      item,
      owned: false,
      earned: false,
    },
  ],
};

describe("the level rewards answer (T-404c)", () => {
  it("reads the level, the curve and the achievement items", () => {
    expect(levelRewardsSchema.parse(answer)).toEqual(answer);
  });

  it("reads the top level, with no next level", () => {
    const top = { ...answer, level: { ...answer.level, nextLevelAt: null } };
    expect(levelRewardsSchema.parse(top)).toEqual(top);
  });

  it("refuses a field it does not know, at every level of the answer", () => {
    for (const wider of [
      { ...answer, gems: 5 },
      { ...answer, level: { ...answer.level, gems: 5 } },
      { ...answer, levels: [{ ...answer.levels[0], price: 5 }] },
      { ...answer, achievements: [{ ...answer.achievements[0], price: 5 }] },
    ]) {
      expect(levelRewardsSchema.safeParse(wider).success, JSON.stringify(wider)).toBe(false);
    }
  });

  it("refuses more than 100 levels, a missing part and an unknown tier", () => {
    const many = Array.from({ length: 101 }, () => answer.levels[0]);
    expect(levelRewardsSchema.safeParse({ ...answer, levels: many }).success).toBe(false);
    const { levels: _levels, ...withoutLevels } = answer;
    expect(levelRewardsSchema.safeParse(withoutLevels).success).toBe(false);
    expect(
      levelRewardsSchema.safeParse({
        ...answer,
        achievements: [{ ...answer.achievements[0], tier: "platinum" }],
      }).success,
    ).toBe(false);
  });
});
