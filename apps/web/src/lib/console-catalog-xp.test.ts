import { MESSAGES, type ItemAdmin, type XpTableAdmin } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { CATALOG_TABS } from "#src/lib/console-catalog.ts";
import {
  canRemoveTop,
  checkNewItem,
  checkXpTable,
  isBusy,
  isItemDirty,
  isXpTableDirty,
  itemDraftOf,
  newItemDraft,
  readItems,
  readPreview,
  readXpTable,
  rewardChoices,
  sourceOf,
  withKind,
  withLevelAdded,
  xpDraftOf,
  xpLoweringOf,
} from "#src/lib/console-catalog-xp.ts";

const TABLE: XpTableAdmin = {
  levels: [
    { level: 1, xpFrom: 0, itemId: null, reached: false },
    { level: 2, xpFrom: 200, itemId: "level-2", reached: true },
    { level: 3, xpFrom: 500, itemId: "level-3", reached: false },
  ],
  revertible: false,
};
const item = (id: string, source: ItemAdmin["source"]): ItemAdmin => ({
  id,
  kind: "frame",
  name: { ar: "إطار", en: "Frame" },
  visualKey: "frame-01",
  source,
  locked: { art: null },
  revertible: false,
});

describe("the XP table editor (T-709d)", () => {
  it("reads the table, the preview and a lowering refusal, and nothing else", () => {
    expect(readXpTable(TABLE)).toEqual(TABLE);
    expect(readXpTable({ levels: "x" })).toBeUndefined();
    expect(readPreview({ up: 1, down: 0, levels: 1, gems: 20, levelUp: 20 })).toMatchObject({
      up: 1,
    });
    expect(readPreview({ up: -1 })).toBeUndefined();
    expect(
      xpLoweringOf({ code: "confirmation_required", details: { levels: [3], levelUp: 20 } }),
    ).toEqual({ levels: [3], levelUp: 20 });
    expect(xpLoweringOf({ code: "confirmation_required", details: { gems: {} } })).toBeUndefined();
    expect(xpLoweringOf({ code: "stale" })).toBeUndefined();
    expect(xpLoweringOf(null)).toBeUndefined();
  });

  it("checks the typed table against the shared schema and knows when it changed", () => {
    const rows = xpDraftOf(TABLE);
    expect(checkXpTable(rows).ok).toBe(true);
    expect(isXpTableDirty(TABLE, rows)).toBe(false);
    const lowered = rows.map((row) => (row.level === 3 ? { ...row, xpFrom: " 300 " } : row));
    expect(isXpTableDirty(TABLE, lowered)).toBe(true);
    const falling = rows.map((row) => (row.level === 3 ? { ...row, xpFrom: "150" } : row));
    const refused = checkXpTable(falling);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : [...refused.fields]).toContain("levels.2.xpFrom");
    const added = withLevelAdded(rows);
    expect(added.at(-1)).toEqual({ level: 4, xpFrom: "", itemId: null, reached: false });
    expect(checkXpTable(added).ok).toBe(false);
  });

  it("removes only an unreached top level, and never below two levels", () => {
    const rows = xpDraftOf(TABLE);
    expect(canRemoveTop(rows)).toBe(true);
    expect(canRemoveTop(rows.slice(0, 2))).toBe(false);
    expect(canRemoveTop([...rows, { level: 4, xpFrom: "900", itemId: "x", reached: true }])).toBe(
      false,
    );
  });

  it("offers a level its own item and every free one, never a shop item or another level's", () => {
    const items = [
      item("level-2", { level: 2 }),
      item("level-3", { level: 3 }),
      item("loose", null),
      item("shop-ring", { shop: { status: "active" } }),
    ];
    const rows = xpDraftOf(TABLE);
    expect(rewardChoices(items, rows, "level-3").map((one) => one.id)).toEqual([
      "level-3",
      "loose",
    ]);
    const freed = rows.map((row) => (row.level === 3 ? { ...row, itemId: "loose" } : row));
    expect(rewardChoices(items, freed, "loose").map((one) => one.id)).toEqual(["level-3", "loose"]);
  });

  it("tells a busy answer from any other", () => {
    expect(isBusy(503, {})).toBe(true);
    expect(isBusy(undefined, { code: "busy" })).toBe(true);
    expect(isBusy(409, { code: "stale" })).toBe(false);
  });
});

describe("the items editor (T-709d)", () => {
  it("reads the list and names each item's source", () => {
    const list = [item("loose", null), item("level-2", { level: 2 })];
    expect(readItems({ items: list })).toEqual(list);
    expect(readItems({ items: [{ id: 1 }] })).toBeUndefined();
    expect(sourceOf(item("a", null))).toEqual({ kind: "none" });
    expect(sourceOf(item("a", { level: 4 }))).toEqual({ kind: "level", level: 4 });
    expect(sourceOf(item("a", { shop: { status: "retired" } }))).toEqual({ kind: "shop" });
  });

  it("knows when an item's names or art changed", () => {
    const one = item("a", null);
    const draft = itemDraftOf(one);
    expect(isItemDirty(one, draft)).toBe(false);
    expect(isItemDirty(one, { ...draft, name: { ...draft.name, en: "Frame " } })).toBe(false);
    expect(isItemDirty(one, { ...draft, visualKey: "frame-02" })).toBe(true);
  });

  it("checks a new item: the art of its kind, a shop listing when on sale, never a souvenir- id", () => {
    const base = {
      ...newItemDraft(),
      id: "dawn-frame",
      name: { ar: "إطار الفجر", en: "Dawn frame" },
    };
    expect(checkNewItem(base)).toMatchObject({ ok: true, doc: { visualKey: "frame-01" } });
    expect(checkNewItem({ ...base, id: "souvenir-x" }).ok).toBe(false);
    const title = withKind(base, "title");
    expect(title.visualKey).toBeNull();
    expect(checkNewItem(title).ok).toBe(true);
    expect(checkNewItem({ ...title, visualKey: "frame-01" }).ok).toBe(false);
    expect(withKind(base, "character").visualKey).toBe("chest");
    const onSale = { ...base, onSale: true, price: "90", position: "40" };
    expect(checkNewItem(onSale)).toMatchObject({
      ok: true,
      doc: { shop: { price: 90, position: 40, status: "active" } },
    });
    expect(checkNewItem({ ...onSale, price: "0" }).ok).toBe(false);
  });

  it("has words for every tab and every item lock and source in both languages", () => {
    for (const tab of CATALOG_TABS) {
      expect(MESSAGES[`console.catalog.tab.${tab}`], tab).toBeDefined();
    }
    for (const key of [
      "console.catalog.items.lock.onSale",
      "console.catalog.items.lock.owned",
      "console.catalog.items.source.none",
      "console.catalog.items.source.shop",
      "console.catalog.xp.busy",
    ] as const) {
      expect(MESSAGES[key].ar.length, key).toBeGreaterThan(0);
      expect(MESSAGES[key].en.length, key).toBeGreaterThan(0);
    }
  });
});
