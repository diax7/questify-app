import type { Bilingual } from "#src/lib/prizes.ts";

type Named = Readonly<{ id: string; name: Bilingual }>;

/** One quest item as `GET …/quest-items` answers it (FR-522, FR-1617, T-304d). */
export type QuestItem = Readonly<{
  id: string;
  name: Bilingual;
  description: Bilingual;
  stockTotal: number;
  unitsOut: number;
  stockLeft: number;
  /** Players who completed a source while it was out, or after the desk closed: they got the points only. */
  missed: number;
  quests: readonly Named[];
  categories: readonly Named[];
}>;

/** One player who missed the item, newest first (FR-1617). */
export type QuestItemMiss = Readonly<{
  username: string | null;
  avatar: string;
  at: string;
  source: "quest" | "category";
  sourceName: Bilingual;
  reason: "out_of_stock" | "claim_closed";
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads the items answer; undefined when it is not one. */
export function questItemsOf(body: unknown): readonly QuestItem[] | undefined {
  return isRecord(body) && Array.isArray(body["items"])
    ? (body["items"] as QuestItem[])
    : undefined;
}

/** Reads the misses answer; undefined when it is not one. */
export function questItemMissesOf(body: unknown): readonly QuestItemMiss[] | undefined {
  return isRecord(body) && Array.isArray(body["misses"])
    ? (body["misses"] as QuestItemMiss[])
    : undefined;
}

/** Whether a quest or category still gives this item. */
export const linked = (item: QuestItem): boolean =>
  item.quests.length > 0 || item.categories.length > 0;

/**
 * The items that ran out while a quest or category still gives them (FR-1617): the organizer is warned, with how many
 * players got points only.
 */
export const ranOut = (items: readonly QuestItem[]): QuestItem[] =>
  items.filter((item) => item.stockLeft <= 0 && linked(item));

/** The id a quest or category form sends: the chosen item, or null for none. */
export const itemChoice = (value: string): string | null => (value === "" ? null : value);
