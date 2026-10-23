import { describe, expect, it } from "vitest";
import {
  itemChoice,
  linked,
  questItemMissesOf,
  questItemsOf,
  ranOut,
  type QuestItem,
} from "#src/lib/quest-items.ts";

const item = (fields: Partial<QuestItem> = {}): QuestItem => ({
  id: "i1",
  name: { ar: "قميص", en: "T-shirt" },
  description: { ar: null, en: null },
  stockTotal: 10,
  unitsOut: 10,
  stockLeft: 0,
  missed: 12,
  quests: [{ id: "q1", name: { ar: null, en: "Lion" } }],
  categories: [],
  ...fields,
});

describe("quest items (T-304d)", () => {
  it("reads the lists, and nothing that is not one", () => {
    expect(questItemsOf({ items: [item()] })).toHaveLength(1);
    expect(questItemsOf({ items: "x" })).toBeUndefined();
    expect(questItemsOf(null)).toBeUndefined();
    expect(questItemMissesOf({ misses: [] })).toEqual([]);
    expect(questItemMissesOf({})).toBeUndefined();
  });

  it("warns of an item that ran out while a quest or category still gives it (FR-1617)", () => {
    const unlinked = item({ id: "i2", quests: [] });
    const left = item({ id: "i3", stockLeft: 1 });
    const grouped = item({
      id: "i4",
      quests: [],
      categories: [{ id: "c", name: { ar: null, en: "S" } }],
    });
    expect(ranOut([item(), unlinked, left, grouped]).map((one) => one.id)).toEqual(["i1", "i4"]);
    expect(linked(unlinked)).toBe(false);
  });

  it("sends an empty choice as no item", () => {
    expect(itemChoice("")).toBeNull();
    expect(itemChoice("i1")).toBe("i1");
  });
});
