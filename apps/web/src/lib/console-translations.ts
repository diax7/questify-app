import {
  MATRIX_MAX_LIMIT,
  MESSAGES,
  matrixSchema,
  placeholdersOf,
  savedRowSchema,
  shownText,
  toWesternDigits,
  validateTranslation,
  type Language,
  type Matrix,
  type MatrixRow,
  type MatrixShow,
} from "@questify/shared";

export const TRANSLATIONS_API = "/v1/admin/translations";

/** Rows per page of the matrix. */
export const PAGE_SIZE = 50;

export const LANGUAGES = ["en", "ar"] as const satisfies readonly Language[];

/** What the matrix is narrowed to: the search words, one area, a filter and the page. */
export type MatrixView = Readonly<{
  q: string;
  area: string;
  show: MatrixShow;
  page: number;
}>;

export const FIRST_VIEW: MatrixView = { q: "", area: "", show: "all", page: 0 };

/** The API path of one view of the matrix. */
export function matrixPath(view: MatrixView): string {
  const query = new URLSearchParams();
  if (view.q.trim() !== "") {
    query.set("q", view.q.trim());
  }
  if (view.area !== "") {
    query.set("area", view.area);
  }
  query.set("show", view.show);
  query.set("offset", String(view.page * PAGE_SIZE));
  query.set("limit", String(Math.min(PAGE_SIZE, MATRIX_MAX_LIMIT)));
  return `${TRANSLATIONS_API}?${query.toString()}`;
}

/** The API path of one key. A key is dotted words, so it needs no escaping, but it is escaped all the same. */
export const keyPath = (key: string): string => `${TRANSLATIONS_API}/${encodeURIComponent(key)}`;

/** The matrix page; undefined when the answer is not the expected shape (a changed API shows the error state). */
export function readMatrix(body: unknown): Matrix | undefined {
  const parsed = matrixSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The row a save or a revert answers with; undefined when the answer is not the expected shape. */
export function readSavedRow(body: unknown): MatrixRow | undefined {
  const parsed = savedRowSchema.safeParse(body);
  return parsed.success ? parsed.data.row : undefined;
}

/** What the boxes hold while an admin types: the text of each language. */
export type RowDraft = Readonly<Record<Language, string>>;

/** The draft that starts an edit: the text players see now. */
export const draftOf = (row: MatrixRow): RowDraft => ({
  ar: shownText(row, "ar"),
  en: shownText(row, "en"),
});

/** A typed text as it would be stored: trimmed, Arabic-Indic digits written 0-9. */
const normalised = (text: string): string => toWesternDigits(text.trim());

/** Whether a language of the draft differs from the text players see now. */
export const isEdited = (row: MatrixRow, draft: RowDraft, language: Language): boolean =>
  normalised(draft[language]) !== shownText(row, language);

/** Whether anything in the draft differs from what players see now. */
export const isDirty = (row: MatrixRow, draft: RowDraft): boolean =>
  LANGUAGES.some((language) => isEdited(row, draft, language));

/** One placeholder of the shipped text: `present` in the draft, or `missing` from it. */
export type Chip = Readonly<{ name: string; state: "present" | "missing" }>;

/** The placeholders of the shipped text and whether the draft still has each, and the ones the draft adds. */
export function chipsOf(
  row: MatrixRow,
  language: Language,
  text: string,
): Readonly<{ chips: Chip[]; extra: string[] }> {
  const required = placeholdersOf(row.shipped[language]);
  const found = placeholdersOf(text);
  return {
    chips: required.map((name) => ({
      name,
      state: found.includes(name) ? "present" : "missing",
    })),
    extra: found.filter((name) => !required.includes(name)),
  };
}

/** A language the draft may not be saved with: it lacks a placeholder, adds one, or is too long. */
export function isInvalid(row: MatrixRow, draft: RowDraft, language: Language): boolean {
  const text = normalised(draft[language]);
  return text !== "" && !validateTranslation(MESSAGES, row.key, language, text).ok;
}

/** Whether the draft can be saved: something changed and every changed language is allowed. */
export const canSave = (row: MatrixRow, draft: RowDraft): boolean =>
  isDirty(row, draft) &&
  LANGUAGES.every(
    (language) => !isEdited(row, draft, language) || !isInvalid(row, draft, language),
  );

/**
 * The body of a save: only the languages that changed. A text that is blank, or the same as the shipped text, is sent
 * blank, which returns the language to the shipped text instead of storing a copy of it.
 */
export function bodyOf(row: MatrixRow, draft: RowDraft): Partial<Record<Language, string>> {
  const body: Partial<Record<Language, string>> = {};
  for (const language of LANGUAGES) {
    if (isEdited(row, draft, language)) {
      const text = normalised(draft[language]);
      body[language] = text === row.shipped[language] ? "" : text;
    }
  }
  return body;
}

/** Whether the key holds a change in either language, so it can be reverted. */
export const isChanged = (row: MatrixRow): boolean =>
  row.stored.ar !== null || row.stored.en !== null;

/**
 * Whether the phone never shows this key (Q-380): the console's own texts. The dashboard's other pages are not marked, since
 * the matrix cannot tell a dashboard-only key from a phone one.
 */
export const notOnPhone = (key: string): boolean => key.startsWith("console.");

/** The body that returns every changed language of a key to the shipped text. */
export function revertBody(row: MatrixRow): Partial<Record<Language, string>> {
  const body: Partial<Record<Language, string>> = {};
  for (const language of LANGUAGES) {
    if (row.stored[language] !== null) {
      body[language] = "";
    }
  }
  return body;
}

/** `text` with `{name}` put where the caret or selection was, and where the caret goes next. */
export function insertPlaceholder(
  text: string,
  selection: Readonly<{ start: number; end: number }>,
  name: string,
): Readonly<{ text: string; caret: number }> {
  const token = `{${name}}`;
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  return {
    text: `${text.slice(0, start)}${token}${text.slice(end)}`,
    caret: start + token.length,
  };
}

/** The row with the same key replaced by `next`; the list unchanged when it is not there. */
export function withRow(rows: readonly MatrixRow[], next: MatrixRow): MatrixRow[] {
  return rows.map((row) => (row.key === next.key ? next : row));
}

/** The 1-based range of a page of `count` rows out of `total`, for "51 to 100 of 4,165". */
export function rangeOf(page: number, count: number): Readonly<{ from: number; to: number }> {
  return { from: page * PAGE_SIZE + 1, to: page * PAGE_SIZE + count };
}

/** How many pages `total` rows take. */
export const pagesOf = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));
