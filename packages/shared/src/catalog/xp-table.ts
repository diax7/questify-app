import { z } from "zod";
import { ITEM_KINDS } from "#src/players/items";
import { arabicText, englishText } from "#src/text/bilingual";

/**
 * The console's XP table and item catalog (T-709d, FR-1403, ADR-440, ADR-441). The XP table is one document: the start
 * of every level and the item each level above 1 gives. A save that lowers a start (or adds a level within someone's XP)
 * pays level items and gems at each player's next sync, which no revert takes back, so the API refuses it until the admin
 * confirms (409 `confirmation_required`). The database checks the same rules again (migration 0124).
 */
export const XP_LEVELS_MIN = 2;
export const XP_LEVELS_MAX = 100;
export const XP_FROM_MAX = 100_000_000;
export type ItemKind = (typeof ITEM_KINDS)[number];

const ITEM_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SOUVENIR_PREFIX = "souvenir-";

/** The shipped art of each kind: twenty frame designs, the chest for a character, none for a title. */
export const FRAME_VISUALS = Array.from(
  { length: 20 },
  (_, index) => `frame-${String(index + 1).padStart(2, "0")}`,
);
export function visualsOf(kind: ItemKind): readonly (string | null)[] {
  if (kind === "frame") return FRAME_VISUALS;
  return kind === "character" ? ["chest"] : [null];
}

const levelRow = z.strictObject({
  level: z.number().int().min(1).max(XP_LEVELS_MAX),
  xpFrom: z.number().int().min(0).max(XP_FROM_MAX),
  itemId: z.string().regex(ITEM_ID_PATTERN).nullable(),
});
export type XpLevel = z.infer<typeof levelRow>;

type Issue = Readonly<{ path: (string | number)[]; message: string }>;

/** What is wrong with one level of a table: its place, its start against the level before, its item. */
function levelIssues(row: XpLevel, index: number, before: XpLevel | undefined): Issue[] {
  const issues: Issue[] = [];
  if (row.level !== index + 1) {
    issues.push({ path: ["levels", index, "level"], message: "levels must run 1, 2, 3 in order" });
  }
  const startOk =
    index === 0 ? row.xpFrom === 0 : row.xpFrom >= 1 && row.xpFrom > (before?.xpFrom ?? -1);
  if (!startOk) {
    issues.push({
      path: ["levels", index, "xpFrom"],
      message: index === 0 ? "level 1 starts at 0" : "each level starts above the level before it",
    });
  }
  if ((index === 0) !== (row.itemId === null)) {
    issues.push({
      path: ["levels", index, "itemId"],
      message: index === 0 ? "level 1 gives no item" : "every level above 1 gives an item",
    });
  }
  return issues;
}

/** The whole XP table as a save sends it, an audit entry holds it and a revert puts it back. */
export const xpTableDocSchema = z
  .strictObject({ levels: z.array(levelRow).min(XP_LEVELS_MIN).max(XP_LEVELS_MAX) })
  .superRefine((doc, context) => {
    doc.levels.forEach((row, index) => {
      for (const issue of levelIssues(row, index, doc.levels[index - 1])) {
        context.addIssue({ code: "custom", ...issue });
      }
    });
    const items = doc.levels.flatMap((row) => (row.itemId === null ? [] : [row.itemId]));
    if (new Set(items).size !== items.length) {
      context.addIssue({ code: "custom", path: ["levels"], message: "an item is on two levels" });
    }
  });
export type XpTableDoc = z.infer<typeof xpTableDocSchema>;

/** The table as the console lists it: per level whether anyone reached it (its reward is then locked). */
export const xpTableAdminSchema = z.strictObject({
  levels: z.array(levelRow.extend({ reached: z.boolean() })),
  revertible: z.boolean(),
});
export type XpTableAdmin = z.infer<typeof xpTableAdminSchema>;

/** What a table would do to active players now (advisory, "about"). */
export const xpTablePreviewSchema = z.strictObject({
  up: z.number().int().min(0),
  down: z.number().int().min(0),
  levels: z.number().int().min(0),
  gems: z.number().int().min(0),
  levelUp: z.number().int().min(1),
});
export type XpTablePreview = z.infer<typeof xpTablePreviewSchema>;

/** The `details` of a refused lowering: the levels it pays and the gems each pays now. */
export const xpTableLoweringSchema = z.strictObject({
  levels: z.array(z.number().int().min(2)).min(1),
  levelUp: z.number().int().min(1),
});
export type XpTableLowering = z.infer<typeof xpTableLoweringSchema>;

const pair = z.strictObject({ ar: arabicText(60), en: englishText(60) });

/** What an admin edits of an item: its names always, its art while it is not on sale and nobody owns it. */
export const itemDocSchema = z.strictObject({
  name: pair,
  visualKey: z.string().max(20).nullable(),
});
export type ItemDoc = z.infer<typeof itemDocSchema>;

const shopListing = z.strictObject({
  price: z.number().int().min(1).max(100_000),
  position: z.number().int().min(1).max(1000),
  status: z.enum(["active", "retired"]),
});

/** A new item: its id (never `souvenir-`, an organizer's), kind, names, shipped art, and optionally on sale. */
export const itemCreateSchema = z
  .strictObject({
    id: z
      .string()
      .regex(ITEM_ID_PATTERN)
      .refine((id) => !id.startsWith(SOUVENIR_PREFIX), "souvenir- ids belong to organizers"),
    kind: z.enum(ITEM_KINDS),
    name: pair,
    visualKey: z.string().nullable(),
    shop: shopListing.optional(),
  })
  .superRefine((doc, context) => {
    if (!visualsOf(doc.kind).includes(doc.visualKey)) {
      context.addIssue({
        code: "custom",
        path: ["visualKey"],
        message: "pick the art shipped for this kind",
      });
    }
  });
export type ItemCreate = z.infer<typeof itemCreateSchema>;

/** Why an item's art cannot change: it is in the shop, or a level anyone reached gives it. */
export const ITEM_ART_LOCKS = ["on_sale", "owned"] as const;

export const itemAdminSchema = z.strictObject({
  id: z.string().regex(ITEM_ID_PATTERN),
  kind: z.enum(ITEM_KINDS),
  name: z.strictObject({ ar: z.string(), en: z.string() }),
  visualKey: z.string().nullable(),
  source: z
    .union([
      z.strictObject({ level: z.number().int().min(2) }),
      z.strictObject({ shop: z.strictObject({ status: z.enum(["active", "retired"]) }) }),
    ])
    .nullable(),
  locked: z.strictObject({ art: z.enum(ITEM_ART_LOCKS).nullable() }),
  revertible: z.boolean(),
});
export type ItemAdmin = z.infer<typeof itemAdminSchema>;

export const itemsAdminListSchema = z.strictObject({ items: z.array(itemAdminSchema) });
export const itemAdminAnswerSchema = z.strictObject({ item: itemAdminSchema });
