import { z } from "zod";
import type { Language } from "./digits";
import { isLockedText } from "./locked";
import type { Messages } from "./messages";
import { isUsableOverride } from "./translate";

/** What the translation matrix can be narrowed to (FR-1765): everything, what an admin changed, or what lacks a language. */
export const MATRIX_SHOWS = ["all", "changed", "missingAr", "missingEn"] as const;
export type MatrixShow = (typeof MATRIX_SHOWS)[number];

export const MATRIX_MAX_LIMIT = 100;

/** One text of the app: the shipped wording, and what an admin changed in each language (null: the shipped text shows). */
export type MatrixRow = Readonly<{
  key: string;
  /** The screen or feature the key belongs to: its first word (`quests` for `quests.title`). */
  area: string;
  /** Legal and consent wording: shown, never saved. */
  locked: boolean;
  shipped: Readonly<Record<Language, string>>;
  /** The stored values as they are, usable or not. */
  stored: Readonly<Record<Language, string | null>>;
  /** A stored value the app ignores because the shipped text gained or lost a placeholder since it was saved. */
  stale: Readonly<Record<Language, boolean>>;
}>;

export type Matrix = Readonly<{
  /** Rows that match the search and filters, before paging. */
  total: number;
  /** Every area of the app with its number of keys, whatever the search says. */
  areas: readonly Readonly<{ area: string; count: number }>[];
  rows: readonly MatrixRow[];
}>;

export type MatrixQuery = Readonly<{
  q?: string | undefined;
  area?: string | undefined;
  show: MatrixShow;
  offset: number;
  limit: number;
}>;

/** A row of the translation store. */
export type StoredText = Readonly<{ key: string; ar: string | null; en: string | null }>;

const pair = z.object({ ar: z.string(), en: z.string() });
const nullable = z.object({ ar: z.string().nullable(), en: z.string().nullable() });
const flags = z.object({ ar: z.boolean(), en: z.boolean() });

export const matrixRowSchema = z.object({
  key: z.string(),
  area: z.string(),
  locked: z.boolean(),
  shipped: pair,
  stored: nullable,
  stale: flags,
});

/** What `PUT /v1/admin/translations/:key` answers. */
export const savedRowSchema = z.object({ row: matrixRowSchema });

export const matrixSchema = z.object({
  total: z.number().int().min(0),
  areas: z.array(z.object({ area: z.string(), count: z.number().int().min(0) })),
  rows: z.array(matrixRowSchema),
});

const ARABIC_LETTER = /[؀-ۿݐ-ݿ]/;
const LATIN_LETTER = /[A-Za-z]/;
const PLACEHOLDER = /\{[a-zA-Z][a-zA-Z0-9]*\}/g;
// Arabic marks and the tatweel, which a search should not need to type.
const ARABIC_MARKS = /[ـً-ٰٟ]/g;

/** The area of a key: the word before its first dot. */
const areaOf = (key: string): string => key.split(".")[0] ?? key;

const fold = (text: string): string =>
  text.normalize("NFKC").replace(ARABIC_MARKS, "").toLowerCase();

/** The row for one key of the shipped texts, with the store's values for it (none when nobody changed it). */
export function matrixRow(messages: Messages, key: string, stored?: StoredText): MatrixRow {
  const shipped = messages[key] ?? { ar: "", en: "" };
  const values = { ar: stored?.ar ?? null, en: stored?.en ?? null };
  const isStale = (code: Language): boolean => {
    const value = values[code];
    return value !== null && !isUsableOverride(messages, key, code, value);
  };
  return {
    key,
    area: areaOf(key),
    locked: isLockedText(key),
    shipped: { ar: shipped.ar, en: shipped.en },
    stored: values,
    stale: { ar: isStale("ar"), en: isStale("en") },
  };
}

/** The text a player sees in one language: the stored value when the app can use it, else the shipped text. */
export function shownText(row: MatrixRow, code: Language): string {
  const value = row.stored[code];
  return value !== null && !row.stale[code] ? value : row.shipped[code];
}

const lettersOf = (text: string): string => text.replace(PLACEHOLDER, "");

/** A language the shown text of a key does not really have: Arabic with no Arabic letters, English with no Latin ones. */
function lacks(row: MatrixRow, code: Language): boolean {
  const own = lettersOf(shownText(row, code));
  const other = lettersOf(shownText(row, code === "ar" ? "en" : "ar"));
  return code === "ar"
    ? !ARABIC_LETTER.test(own) && LATIN_LETTER.test(other)
    : !LATIN_LETTER.test(own) && ARABIC_LETTER.test(other);
}

function matchesShow(row: MatrixRow, show: MatrixShow): boolean {
  switch (show) {
    case "changed":
      return row.stored.ar !== null || row.stored.en !== null;
    case "missingAr":
      return lacks(row, "ar");
    case "missingEn":
      return lacks(row, "en");
    default:
      return true;
  }
}

function matchesSearch(row: MatrixRow, needle: string): boolean {
  const haystack = [
    row.key,
    row.shipped.ar,
    row.shipped.en,
    row.stored.ar ?? "",
    row.stored.en ?? "",
  ];
  return haystack.some((text) => fold(text).includes(needle));
}

/** Every area of the catalog with its number of keys, by name. */
function areasOf(keys: readonly string[]): Matrix["areas"] {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(areaOf(key), (counts.get(areaOf(key)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => (a.area < b.area ? -1 : 1));
}

/**
 * The translation matrix (FR-1765): every shipped key in key order with what an admin changed, narrowed by a search
 * (the key or the text in either language, ignoring case and Arabic marks), an area and a filter, then one page of it.
 * A key the store holds that the app no longer ships is not listed (there is nothing for it to replace).
 */
export function buildMatrix(
  messages: Messages,
  stored: readonly StoredText[],
  query: MatrixQuery,
): Matrix {
  const keys = Object.keys(messages).sort((a, b) => (a < b ? -1 : 1));
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const needle = fold((query.q ?? "").trim());
  const matching = keys
    .filter((key) => query.area === undefined || areaOf(key) === query.area)
    .map((key) => matrixRow(messages, key, byKey.get(key)))
    .filter((row) => matchesShow(row, query.show) && (needle === "" || matchesSearch(row, needle)));
  return {
    total: matching.length,
    areas: areasOf(keys),
    rows: matching.slice(query.offset, query.offset + query.limit),
  };
}
