import { describe, expect, it } from "vitest";
import { levelOf, levelProgress, levelUpOf, type QuestifyLevel } from "#src/questify/level.ts";

const title = { ar: "مستكشف", en: "Explorer" };
const level: QuestifyLevel = { xp: 350, level: 2, levelFrom: 200, nextLevelAt: 500, title };

describe("levelOf", () => {
  it("reads the level from the profile", () => {
    expect(levelOf({ ...level, extra: true })).toEqual(level);
    expect(levelOf({ ...level, nextLevelAt: null })).toEqual({ ...level, nextLevelAt: null });
  });

  it.each([
    undefined,
    null,
    [],
    { ...level, xp: -1 },
    { ...level, xp: 1.5 },
    { ...level, level: "2" },
    { ...level, levelFrom: undefined },
    { ...level, nextLevelAt: "500" },
    { ...level, title: { ar: "مستكشف" } },
    { ...level, title: null },
  ])("gives no level for a malformed answer: %j", (value) => {
    expect(levelOf(value)).toBeUndefined();
  });
});

describe("levelUpOf", () => {
  it("reads a level-up, and null for none or a malformed one", () => {
    expect(levelUpOf({ level: 3, title })).toEqual({ level: 3, title });
    expect(levelUpOf(null)).toBeNull();
    expect(levelUpOf(undefined)).toBeNull();
    expect(levelUpOf({ level: 3 })).toBeNull();
    expect(levelUpOf({ title })).toBeNull();
  });
});

describe("levelProgress", () => {
  it("is the share of the way to the next level", () => {
    expect(levelProgress(level)).toBe(0.5);
    expect(levelProgress({ ...level, xp: 200 })).toBe(0);
    expect(levelProgress({ ...level, xp: 499 })).toBeCloseTo(0.9967, 3);
  });

  it("is full at the top, and stays between 0 and 1 when the curve moved", () => {
    expect(levelProgress({ ...level, nextLevelAt: null })).toBe(1);
    expect(levelProgress({ ...level, nextLevelAt: 200 })).toBe(1);
    expect(levelProgress({ ...level, xp: 900 })).toBe(1);
    expect(levelProgress({ ...level, xp: 100 })).toBe(0);
  });
});
