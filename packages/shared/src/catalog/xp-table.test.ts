import { describe, expect, it } from "vitest";
import {
  FRAME_VISUALS,
  XP_FROM_MAX,
  XP_LEVELS_MAX,
  itemAdminAnswerSchema,
  itemAdminSchema,
  itemCreateSchema,
  itemDocSchema,
  itemsAdminListSchema,
  visualsOf,
  xpTableAdminSchema,
  xpTableDocSchema,
  xpTableLoweringSchema,
  xpTablePreviewSchema,
  type XpLevel,
} from "#src/catalog/xp-table";

type Parsed = Readonly<{
  success: boolean;
  error?: { issues: readonly { code: string; path: PropertyKey[]; message: string }[] };
}>;

const issuesOf = (result: Parsed) =>
  (result.error?.issues ?? []).map(({ code, path, message }) => ({ code, path, message }));

/** A table whose level `n` starts at `starts[n - 1]`; level 1 gives nothing, level n gives `item-n`. */
const levelsAt = (starts: readonly number[]): XpLevel[] =>
  starts.map((xpFrom, index) => ({
    level: index + 1,
    xpFrom,
    itemId: index === 0 ? null : `item-${index + 1}`,
  }));
const tableOf = (levels: readonly XpLevel[]) => xpTableDocSchema.safeParse({ levels });
const startIssue = (index: number) => ({
  code: "custom",
  path: ["levels", index, "xpFrom"],
  message: "each level starts above the level before it",
});
const withLevel = (levels: readonly XpLevel[], index: number, change: Partial<XpLevel>) =>
  levels.map((row, at) => (at === index ? { ...row, ...change } : row));

describe("the shipped art of each item kind", () => {
  it("has twenty frames named frame-01 to frame-20", () => {
    expect(FRAME_VISUALS).toHaveLength(20);
    expect(FRAME_VISUALS[0]).toBe("frame-01");
    expect(FRAME_VISUALS[8]).toBe("frame-09");
    expect(FRAME_VISUALS[19]).toBe("frame-20");
  });

  it("gives a frame the frames, a character the chest, and a title no art", () => {
    expect(visualsOf("frame")).toEqual(FRAME_VISUALS);
    expect(visualsOf("character")).toEqual(["chest"]);
    expect(visualsOf("title")).toEqual([null]);
  });
});

describe("the XP table document", () => {
  const good = levelsAt([0, 100, 250]);

  it("takes a table of 2 to 100 rising levels, level 1 at 0 with no item", () => {
    expect(tableOf(good)).toMatchObject({ success: true, data: { levels: good } });
    expect(tableOf(levelsAt([0, 1])).success).toBe(true);
    const longest = levelsAt(Array.from({ length: XP_LEVELS_MAX }, (_, index) => index * 10));
    expect(tableOf(longest).success).toBe(true);
    expect(tableOf(withLevel(good, 2, { xpFrom: XP_FROM_MAX })).success).toBe(true);
  });

  it("refuses fewer than 2 or more than 100 levels, and anything but the levels", () => {
    expect(tableOf(levelsAt([0])).success).toBe(false);
    const tooMany = levelsAt(Array.from({ length: XP_LEVELS_MAX + 1 }, (_, index) => index * 10));
    expect(tableOf(tooMany).success).toBe(false);
    expect(xpTableDocSchema.safeParse({ levels: good, confirmed: true }).success).toBe(false);
    expect(xpTableDocSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a row out of bounds or with an extra field", () => {
    for (const change of [
      { xpFrom: XP_FROM_MAX + 1 },
      { xpFrom: 250.5 },
      { level: XP_LEVELS_MAX + 1 },
      { itemId: "Item" },
      { itemId: "9-lives" },
      { itemId: "a_b" },
      { itemId: `a${"b".repeat(64)}` },
      { extra: 1 },
    ]) {
      expect(tableOf(withLevel(good, 2, change)).success, JSON.stringify(change)).toBe(false);
    }
    expect(tableOf(withLevel(good, 0, { level: 0 })).success).toBe(false);
    expect(tableOf(withLevel(good, 0, { xpFrom: -1 })).success).toBe(false);
  });

  it("takes item ids of one letter or 64 characters with digits and dashes", () => {
    expect(tableOf(withLevel(good, 1, { itemId: "a" })).success).toBe(true);
    const longest = `a${"b-9".repeat(21)}`;
    expect(longest).toHaveLength(64);
    expect(tableOf(withLevel(good, 1, { itemId: longest })).success).toBe(true);
  });

  it("says level 1 starts at 0, on its xpFrom", () => {
    expect(issuesOf(tableOf(withLevel(good, 0, { xpFrom: 5 })))).toEqual([
      { code: "custom", path: ["levels", 0, "xpFrom"], message: "level 1 starts at 0" },
    ]);
  });

  it("says each level starts above the one before, naming the level", () => {
    expect(issuesOf(tableOf(levelsAt([0, 100, 50])))).toEqual([startIssue(2)]);
    expect(issuesOf(tableOf(levelsAt([0, 100, 100])))).toEqual([startIssue(2)]);
    expect(issuesOf(tableOf(levelsAt([0, 0, 50])))).toEqual([startIssue(1)]);
  });

  it("checks a start against the level just before it, not the one after", () => {
    expect(tableOf(levelsAt([0, 300, 200, 400])).success).toBe(false);
    expect(tableOf(levelsAt([0, 1, 2, 3])).success).toBe(true);
  });

  it("says level 1 gives no item and every other level gives one, on its itemId", () => {
    expect(issuesOf(tableOf(withLevel(good, 0, { itemId: "a-frame" })))).toEqual([
      { code: "custom", path: ["levels", 0, "itemId"], message: "level 1 gives no item" },
    ]);
    expect(issuesOf(tableOf(withLevel(good, 2, { itemId: null })))).toEqual([
      {
        code: "custom",
        path: ["levels", 2, "itemId"],
        message: "every level above 1 gives an item",
      },
    ]);
  });

  it("says the levels must run in order, naming the row", () => {
    expect(issuesOf(tableOf(withLevel(good, 1, { level: 3 })))).toEqual([
      { code: "custom", path: ["levels", 1, "level"], message: "levels must run 1, 2, 3 in order" },
    ]);
  });

  it("says an item is on two levels, once, on the levels", () => {
    expect(issuesOf(tableOf(withLevel(good, 2, { itemId: "item-2" })))).toEqual([
      { code: "custom", path: ["levels"], message: "an item is on two levels" },
    ]);
  });

  it("reports every broken row, not only the first", () => {
    const broken = withLevel(withLevel(good, 0, { xpFrom: 1 }), 2, { itemId: null });
    expect(issuesOf(tableOf(broken)).map((issue) => issue.path)).toEqual([
      ["levels", 0, "xpFrom"],
      ["levels", 2, "itemId"],
    ]);
  });
});

describe("the XP table as the console reads it", () => {
  const listed = levelsAt([0, 100]).map((row, index) => ({ ...row, reached: index === 0 }));

  it("lists each level with whether anyone reached it, and whether the table can be reverted", () => {
    expect(xpTableAdminSchema.parse({ levels: listed, revertible: true })).toEqual({
      levels: listed,
      revertible: true,
    });
    expect(xpTableAdminSchema.safeParse({ levels: listed }).success).toBe(false);
    const unmarked = listed.map(({ reached: _reached, ...row }) => row);
    expect(xpTableAdminSchema.safeParse({ levels: unmarked, revertible: true }).success).toBe(
      false,
    );
  });

  it("previews counts of 0 or more and a level gem amount of 1 or more", () => {
    const preview = { up: 0, down: 0, levels: 0, gems: 0, levelUp: 1 };
    expect(xpTablePreviewSchema.parse(preview)).toEqual(preview);
    const busy = { up: 4, down: 2, levels: 7, gems: 140, levelUp: 20 };
    expect(xpTablePreviewSchema.parse(busy)).toEqual(busy);
    for (const field of ["up", "down", "levels", "gems"] as const) {
      expect(xpTablePreviewSchema.safeParse({ ...preview, [field]: -1 }).success, field).toBe(
        false,
      );
    }
    expect(xpTablePreviewSchema.safeParse({ ...preview, levelUp: 0 }).success).toBe(false);
    expect(xpTablePreviewSchema.safeParse({ ...preview, extra: 1 }).success).toBe(false);
  });

  it("reads a refused lowering: one or more levels from 2, and the level gems", () => {
    expect(xpTableLoweringSchema.parse({ levels: [2, 5], levelUp: 20 })).toEqual({
      levels: [2, 5],
      levelUp: 20,
    });
    expect(xpTableLoweringSchema.safeParse({ levels: [], levelUp: 20 }).success).toBe(false);
    expect(xpTableLoweringSchema.safeParse({ levels: [1], levelUp: 20 }).success).toBe(false);
    expect(xpTableLoweringSchema.safeParse({ levels: [3], levelUp: 0 }).success).toBe(false);
    expect(xpTableLoweringSchema.safeParse({ levels: [3] }).success).toBe(false);
  });
});

describe("an item's edit and creation", () => {
  const name = { ar: "إطار الذهب", en: "Gold frame" };
  const created = { id: "gold-frame", kind: "frame", name, visualKey: "frame-03" } as const;
  const shop = { price: 100, position: 1, status: "active" } as const;

  it("edits names and art of up to 20 characters, or no art", () => {
    expect(itemDocSchema.parse({ name, visualKey: "chest" })).toEqual({ name, visualKey: "chest" });
    expect(itemDocSchema.safeParse({ name, visualKey: null }).success).toBe(true);
    expect(itemDocSchema.safeParse({ name, visualKey: "x".repeat(20) }).success).toBe(true);
    expect(itemDocSchema.safeParse({ name, visualKey: "x".repeat(21) }).success).toBe(false);
    expect(itemDocSchema.safeParse({ visualKey: null }).success).toBe(false);
    expect(itemDocSchema.safeParse({ name: { ar: "إطار" }, visualKey: null }).success).toBe(false);
  });

  it("makes an item of each kind with its own art, on sale or not", () => {
    expect(itemCreateSchema.parse(created)).toEqual(created);
    expect(itemCreateSchema.parse({ ...created, shop })).toEqual({ ...created, shop });
    expect(
      itemCreateSchema.safeParse({ ...created, kind: "character", visualKey: "chest" }).success,
    ).toBe(true);
    expect(itemCreateSchema.safeParse({ ...created, kind: "title", visualKey: null }).success).toBe(
      true,
    );
    expect(itemCreateSchema.safeParse({ ...created, kind: "badge" }).success).toBe(false);
    expect(itemCreateSchema.safeParse({ ...created, extra: 1 }).success).toBe(false);
  });

  it("says to pick the shipped art when the art is not this kind's, on the visualKey", () => {
    for (const visualKey of ["chest", "frame-21", null]) {
      expect(
        issuesOf(itemCreateSchema.safeParse({ ...created, visualKey })),
        String(visualKey),
      ).toEqual([
        { code: "custom", path: ["visualKey"], message: "pick the art shipped for this kind" },
      ]);
    }
    expect(
      itemCreateSchema.safeParse({ ...created, kind: "title", visualKey: "frame-03" }).success,
    ).toBe(false);
  });

  it("refuses an id an organizer's souvenirs use, saying so, and any malformed id", () => {
    expect(issuesOf(itemCreateSchema.safeParse({ ...created, id: "souvenir-cup" }))).toEqual([
      { code: "custom", path: ["id"], message: "souvenir- ids belong to organizers" },
    ]);
    expect(itemCreateSchema.safeParse({ ...created, id: "cup-souvenir-" }).success).toBe(true);
    expect(itemCreateSchema.safeParse({ ...created, id: "souvenir" }).success).toBe(true);
    for (const id of ["Gold", "-gold", "gold frame", ""]) {
      expect(itemCreateSchema.safeParse({ ...created, id }).success, id).toBe(false);
    }
  });

  it("puts an item on sale at a price of 1 to 100,000 and a place of 1 to 1,000", () => {
    for (const listing of [
      { ...shop, price: 1, position: 1 },
      { ...shop, price: 100_000, position: 1000, status: "retired" },
    ]) {
      expect(itemCreateSchema.safeParse({ ...created, shop: listing }).success).toBe(true);
    }
    for (const listing of [
      { ...shop, price: 0 },
      { ...shop, price: 100_001 },
      { ...shop, position: 0 },
      { ...shop, position: 1001 },
      { ...shop, status: "hidden" },
      { price: 100, position: 1 },
      { ...shop, extra: 1 },
    ]) {
      expect(
        itemCreateSchema.safeParse({ ...created, shop: listing }).success,
        JSON.stringify(listing),
      ).toBe(false);
    }
  });
});

describe("an item as the console reads it", () => {
  const row = {
    id: "gold-frame",
    kind: "frame",
    name: { ar: "إطار", en: "Frame" },
    visualKey: "frame-03",
    source: { level: 2 },
    locked: { art: null },
    revertible: false,
  } as const;

  it("reads its source as a level from 2, a shop listing, or none", () => {
    expect(itemAdminSchema.parse(row)).toEqual(row);
    expect(itemAdminSchema.parse({ ...row, source: { level: 40 } }).source).toEqual({ level: 40 });
    for (const status of ["active", "retired"]) {
      const shop = { ...row, source: { shop: { status } } };
      expect(itemAdminSchema.parse(shop)).toEqual(shop);
    }
    expect(itemAdminSchema.safeParse({ ...row, source: null }).success).toBe(true);
    for (const source of [{ level: 1 }, { shop: { status: "hidden" } }, { shop: {} }, {}]) {
      expect(itemAdminSchema.safeParse({ ...row, source }).success, JSON.stringify(source)).toBe(
        false,
      );
    }
  });

  it("reads why its art is locked, and refuses a malformed row", () => {
    for (const art of ["on_sale", "owned", null]) {
      expect(itemAdminSchema.safeParse({ ...row, locked: { art } }).success, String(art)).toBe(
        true,
      );
    }
    expect(itemAdminSchema.safeParse({ ...row, locked: { art: "sold" } }).success).toBe(false);
    expect(itemAdminSchema.safeParse({ ...row, locked: {} }).success).toBe(false);
    expect(itemAdminSchema.safeParse({ ...row, name: { ar: "إطار" } }).success).toBe(false);
    expect(itemAdminSchema.safeParse({ ...row, revertible: undefined }).success).toBe(false);
  });

  it("lists items and answers one", () => {
    expect(itemsAdminListSchema.parse({ items: [row] })).toEqual({ items: [row] });
    expect(itemsAdminListSchema.safeParse({}).success).toBe(false);
    expect(itemAdminAnswerSchema.parse({ item: row })).toEqual({ item: row });
    expect(itemAdminAnswerSchema.safeParse({}).success).toBe(false);
  });
});
