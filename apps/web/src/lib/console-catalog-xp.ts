import {
  itemCreateSchema,
  itemDocSchema,
  itemsAdminListSchema,
  visualsOf,
  xpTableAdminSchema,
  xpTableDocSchema,
  xpTableLoweringSchema,
  xpTablePreviewSchema,
  type ItemAdmin,
  type ItemKind,
  type XpTableAdmin,
  type XpTableLowering,
  type XpTablePreview,
} from "@questify/shared";
import { CATALOG_API, checked, wholeNumber, type Pair } from "#src/lib/console-catalog.ts";

/** The XP table with its level rewards, and Questify's items (T-709d, FR-1403, ADR-440, ADR-441). */
export const XP_TABLE_API = `${CATALOG_API}/xp-table`;
export const XP_PREVIEW_API = `${XP_TABLE_API}/preview`;
export const ITEMS_API = `${CATALOG_API}/items`;

export function readXpTable(body: unknown): XpTableAdmin | undefined {
  const parsed = xpTableAdminSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
export function readItems(body: unknown): ItemAdmin[] | undefined {
  const parsed = itemsAdminListSchema.safeParse(body);
  return parsed.success ? parsed.data.items : undefined;
}
export function readPreview(body: unknown): XpTablePreview | undefined {
  const parsed = xpTablePreviewSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The levels and gems a refused lowering pays (409 `confirmation_required`), or undefined for any other answer. */
export function xpLoweringOf(body: unknown): XpTableLowering | undefined {
  const answer = body as { code?: unknown; details?: unknown } | null | undefined;
  if (answer?.code !== "confirmation_required") {
    return undefined;
  }
  const parsed = xpTableLoweringSchema.safeParse(answer.details);
  return parsed.success ? parsed.data : undefined;
}

/** Whether a refusal is the API's 503 busy (the save waited its whole lock budget for level-ups in flight). */
export const isBusy = (status: number | undefined, body: unknown): boolean =>
  status === 503 || (body as { code?: unknown } | null | undefined)?.code === "busy";

// ---------------------------------------------------------------- the XP table

/** One level as typed: its start is text until it is checked; `reached` locks its reward and keeps it from removal. */
export type XpRowDraft = Readonly<{
  level: number;
  xpFrom: string;
  itemId: string | null;
  reached: boolean;
}>;

export const xpDraftOf = (table: XpTableAdmin): XpRowDraft[] =>
  table.levels.map((row) => ({
    level: row.level,
    xpFrom: String(row.xpFrom),
    itemId: row.itemId,
    reached: row.reached,
  }));

export const checkXpTable = (rows: readonly XpRowDraft[]) =>
  checked(xpTableDocSchema, {
    levels: rows.map((row) => ({
      level: row.level,
      xpFrom: wholeNumber(row.xpFrom),
      itemId: row.itemId,
    })),
  });

export const isXpTableDirty = (table: XpTableAdmin, rows: readonly XpRowDraft[]): boolean =>
  JSON.stringify(xpDraftOf(table)) !==
  JSON.stringify(rows.map((row) => ({ ...row, xpFrom: row.xpFrom.trim() })));

/** A new top level with no start and no reward yet, for the admin to fill in. */
export const withLevelAdded = (rows: readonly XpRowDraft[]): XpRowDraft[] => [
  ...rows,
  { level: rows.length + 1, xpFrom: "", itemId: null, reached: false },
];

/** The table without its top level; never below two levels, and never a level someone reached. */
export const canRemoveTop = (rows: readonly XpRowDraft[]): boolean =>
  rows.length > 2 && rows.at(-1)?.reached === false;

/**
 * The items a level's picker offers: the one it holds now and every item no level holds and the shop does not sell. The
 * database refuses the rest (an item with another source) all the same.
 */
export function rewardChoices(
  items: readonly ItemAdmin[],
  rows: readonly XpRowDraft[],
  current: string | null,
): ItemAdmin[] {
  const held = new Set(rows.flatMap((row) => (row.itemId === null ? [] : [row.itemId])));
  return items.filter(
    (item) =>
      item.id === current ||
      (!held.has(item.id) && (item.source === null || "level" in item.source)),
  );
}

// ---------------------------------------------------------------- items

/** What an admin edits of an item: both names, and the art while it is not locked. */
export type ItemDraft = Readonly<{ name: Pair; visualKey: string | null }>;

export const itemDraftOf = (item: ItemAdmin): ItemDraft => ({
  name: item.name,
  visualKey: item.visualKey,
});

export const checkItem = (draft: ItemDraft) =>
  checked(itemDocSchema, {
    name: { ar: draft.name.ar.trim(), en: draft.name.en.trim() },
    visualKey: draft.visualKey,
  });

export const isItemDirty = (item: ItemAdmin, draft: ItemDraft): boolean =>
  draft.name.ar.trim() !== item.name.ar ||
  draft.name.en.trim() !== item.name.en ||
  draft.visualKey !== item.visualKey;

/** A new item as typed: optionally on sale, with its price and place as text. */
export type NewItemDraft = Readonly<{
  id: string;
  kind: ItemKind;
  name: Pair;
  visualKey: string | null;
  onSale: boolean;
  price: string;
  position: string;
}>;

export const newItemDraft = (): NewItemDraft => ({
  id: "",
  kind: "frame",
  name: { ar: "", en: "" },
  visualKey: "frame-01",
  onSale: false,
  price: "",
  position: "",
});

/** The draft of another kind, with that kind's first shipped art. */
export const withKind = (draft: NewItemDraft, kind: ItemKind): NewItemDraft => ({
  ...draft,
  kind,
  visualKey: visualsOf(kind)[0] ?? null,
});

export const checkNewItem = (draft: NewItemDraft) =>
  checked(itemCreateSchema, {
    id: draft.id.trim(),
    kind: draft.kind,
    name: { ar: draft.name.ar.trim(), en: draft.name.en.trim() },
    visualKey: draft.visualKey,
    ...(draft.onSale
      ? {
          shop: {
            price: wholeNumber(draft.price),
            position: wholeNumber(draft.position),
            status: "active",
          },
        }
      : {}),
  });

/** The source badge of an item: the level it rewards, the shop, or none. */
export function sourceOf(
  item: ItemAdmin,
): Readonly<{ kind: "level"; level: number } | { kind: "shop" } | { kind: "none" }> {
  if (item.source === null) return { kind: "none" };
  return "level" in item.source ? { kind: "level", level: item.source.level } : { kind: "shop" };
}
