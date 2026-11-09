import { describe, expect, it } from "vitest";
import { firstBonusMin, firstBonusNotes } from "#src/lib/first-bonus-fields.ts";
import type { SavedFirstBonus } from "#src/lib/quests.ts";

const saved = (patch: Partial<SavedFirstBonus>): SavedFirstBonus => ({
  points: 10,
  slots: 5,
  given: 0,
  left: 5,
  locked: false,
  ...patch,
});

describe("firstBonusMin", () => {
  it("keeps the limit for points, whatever was given", () => {
    expect(firstBonusMin("firstBonusPoints", 1, saved({ given: 9 }))).toBe(1);
    expect(firstBonusMin("firstBonusPoints", 1, null)).toBe(1);
  });

  it("raises the slots floor to the number given", () => {
    expect(firstBonusMin("firstBonusSlots", 1, saved({ given: 3 }))).toBe(3);
    expect(firstBonusMin("firstBonusSlots", 2, saved({ given: 1 }))).toBe(2);
    expect(firstBonusMin("firstBonusSlots", 2, null)).toBe(2);
  });
});

describe("firstBonusNotes", () => {
  it("shows nothing for an unsaved bonus", () => {
    expect(firstBonusNotes(null)).toEqual({ locked: false, belowGiven: false, canStop: false });
  });

  it("shows only the stop button before anyone got it", () => {
    expect(firstBonusNotes(saved({}))).toEqual({ locked: false, belowGiven: false, canStop: true });
  });

  it("locks and warns once given, and stops offering Stop when none is left", () => {
    expect(firstBonusNotes(saved({ given: 2, left: 3, locked: true }))).toEqual({
      locked: true,
      belowGiven: true,
      canStop: true,
    });
    expect(firstBonusNotes(saved({ given: 5, left: 0, locked: true }))).toEqual({
      locked: true,
      belowGiven: true,
      canStop: false,
    });
  });
});
