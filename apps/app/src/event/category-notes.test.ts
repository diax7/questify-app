import { describe, expect, it } from "vitest";
import { categoryNotes, type Category, type Quest } from "#src/event/quests-api.ts";

const quest = (id: string, fields: Partial<Quest> = {}): Quest => ({
  id,
  title: { ar: null, en: id },
  description: { ar: null, en: null },
  type: "enter_code",
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  done: 0,
  earned: 0,
  state: "open",
  lock: null,
  steps: null,
  item: null,
  place: null,
  meet: null,
  game: null,
  submission: null,
  verification: [],
  communityLock: null,
  flash: null,
  boost: null,
  firstBonus: null,
  ...fields,
});

const category = (id: string, quests: Quest[]): Category => ({
  id,
  name: { ar: null, en: id },
  orderMode: "any",
  opensAt: null,
  unlockAfter: null,
  bonus: { points: 0, earned: 0, settled: false, item: null },
  refresh: "none",
  resetsAt: null,
  communityLock: null,
  boost: null,
  quests,
});

const SHUT = [
  quest("a", { state: "locked", lock: "category_not_started" }),
  quest("b", { state: "locked", lock: "category_locked" }),
];

describe("categoryNotes, all together", () => {
  it("says everything in its order: community, opens, unlock, in order, resets, bonus, item", () => {
    const lock = {
      goalId: "g",
      title: { ar: null, en: "Goal" },
      measure: "points" as const,
      threshold: 100,
      state: "waiting" as const,
      startsAt: "2030-01-01T00:00:00.000Z",
    };
    const all: Category = {
      ...category("c", SHUT),
      communityLock: lock,
      orderMode: "in_order",
      opensAt: "2030-01-01T10:00:00.000Z",
      unlockAfter: { id: "z", name: { ar: null, en: "Zed" } },
      refresh: "daily",
      resetsAt: "2030-01-02T01:00:00.000Z",
      bonus: { points: 50, earned: 20, settled: false, item: { ar: null, en: "Cap" } },
    };
    expect(categoryNotes(all)).toEqual([
      { kind: "community", note: lock },
      { kind: "opens", at: "2030-01-01T10:00:00.000Z" },
      { kind: "unlockAfter", name: { ar: null, en: "Zed" } },
      { kind: "inOrder" },
      { kind: "resets", refresh: "daily", at: "2030-01-02T01:00:00.000Z" },
      { kind: "bonusEarned", points: 20 },
      { kind: "bonusItem", name: { ar: null, en: "Cap" } },
    ]);
  });

  it("leaves out an opening or unlock note whose date is missing or whose quests are open", () => {
    expect(categoryNotes({ ...category("c", SHUT), opensAt: null, unlockAfter: null })).toEqual([]);
    const open: Category = {
      ...category("c", [quest("a")]),
      opensAt: "2030-01-01T10:00:00.000Z",
      unlockAfter: { id: "z", name: { ar: null, en: "Zed" } },
    };
    expect(categoryNotes(open)).toEqual([]);
  });

  it("promises a bonus only while it has points and is not settled", () => {
    const base = category("c", [quest("a")]);
    const bonus = (fields: Partial<Category["bonus"]>): Category => ({
      ...base,
      bonus: { points: 0, earned: 0, settled: false, item: null, ...fields },
    });
    expect(categoryNotes(bonus({}))).toEqual([]);
    expect(categoryNotes(bonus({ points: 10 }))).toEqual([{ kind: "bonus", points: 10 }]);
    expect(categoryNotes(bonus({ points: 10, settled: true }))).toEqual([]);
    expect(categoryNotes(bonus({ points: 10, earned: 4 }))).toEqual([
      { kind: "bonusEarned", points: 4 },
    ]);
    expect(categoryNotes(bonus({ earned: 4, settled: true }))).toEqual([
      { kind: "bonusEarned", points: 4 },
    ]);
  });
});
