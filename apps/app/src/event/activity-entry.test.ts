import { describe, expect, it } from "vitest";
import { readActivity } from "#src/event/activity-api.ts";

const ENTRY = {
  id: "41",
  at: "2026-11-01T12:00:00.000Z",
  kind: "quest",
  scoreDelta: 10,
  balanceDelta: 10,
  reason: { type: "quest", questId: "q1", title: { ar: null, en: "Find the word" } },
};

const entryOf = (fields: Record<string, unknown>) =>
  readActivity({ entries: [{ ...ENTRY, ...fields }], nextCursor: null })?.entries[0];

describe("readActivity, field by field", () => {
  it("fails the page when any required field is missing or of another type", () => {
    for (const field of ["id", "at", "kind", "scoreDelta", "balanceDelta", "reason"]) {
      expect(entryOf({ [field]: undefined }), field).toBeUndefined();
    }
    expect(entryOf({ id: 41 })).toBeUndefined();
    expect(entryOf({ at: 5 })).toBeUndefined();
    expect(entryOf({ kind: null })).toBeUndefined();
    expect(entryOf({ balanceDelta: "10" })).toBeUndefined();
    expect(entryOf({ reason: "quest" })).toBeUndefined();
    expect(readActivity({ entries: [null], nextCursor: null })).toBeUndefined();
    expect(readActivity({ entries: [ENTRY, 3], nextCursor: null })).toBeUndefined();
  });

  it("reads the boost only above 1, and the bonus numbers only when numbers", () => {
    expect(entryOf({ multiplier: 2 })?.multiplier).toBe(2);
    expect(entryOf({ multiplier: 1.5 })?.multiplier).toBe(1.5);
    expect(entryOf({ multiplier: 1 })?.multiplier).toBeNull();
    expect(entryOf({ multiplier: 0 })?.multiplier).toBeNull();
    expect(entryOf({ multiplier: "2" })?.multiplier).toBeNull();
    expect(entryOf({ bonusSlots: 3 })?.bonusSlots).toBe(3);
    expect(entryOf({ bonusSlots: 0 })?.bonusSlots).toBe(0);
    expect(entryOf({ bonusSlots: "3" })?.bonusSlots).toBeNull();
    expect(entryOf({ streakDays: 0 })?.streakDays).toBe(0);
    expect(entryOf({ streakDays: null })?.streakDays).toBeNull();
  });

  it("gives a title only for a quest reason with a well-formed title", () => {
    const title = { ar: "س", en: null };
    expect(entryOf({ reason: { type: "quest", title } })?.title).toEqual(title);
    expect(entryOf({ reason: { type: "quest", title: { ar: null, en: null } } })?.title).toEqual({
      ar: null,
      en: null,
    });
    expect(entryOf({ reason: { type: "quest", title: { ar: 1, en: null } } })?.title).toBeNull();
    expect(entryOf({ reason: { type: "quest", title: { en: "x" } } })?.title).toBeNull();
    expect(entryOf({ reason: { type: "quest", title: "x" } })?.title).toBeNull();
    expect(entryOf({ reason: { type: "quest" } })?.title).toBeNull();
    expect(entryOf({ reason: { type: "reward", title } })?.title).toBeNull();
  });
});
