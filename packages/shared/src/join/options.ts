import type { Language } from "#src/i18n/digits";

/** One choice of a choice field (ADR-171): a short id the answer stores, and its label in at least one language. */
export type JoinOption = Readonly<{ id: string; ar: string | null; en: string | null }>;

/** An option as the dashboard sends it: a kept one names its id, a new one has none. */
export type JoinOptionInput = Readonly<{
  id?: string | undefined;
  ar?: string | undefined;
  en?: string | undefined;
}>;

/** A choice field has 2 to 20 options; a label is at most 60 characters (migration 0037's shape check). */
export const JOIN_OPTION_MIN = 2;
export const JOIN_OPTION_MAX = 20;
export const JOIN_OPTION_LABEL_MAX = 60;
const OPTION_ID = /^[a-z0-9]{1,12}$/;

const labelOf = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

const tooLong = (text: string | null) => text !== null && [...text].length > JOIN_OPTION_LABEL_MAX;

const sameLabel = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The options to save, or undefined when the list breaks a rule: 2 to 20; each with a label (at most 60 characters);
 * no two alike in a language; a kept option names an id the field has now, once. A new option gets an id from
 * `makeId` that no option of the field has used.
 */
export function cleanOptions(
  input: readonly JoinOptionInput[],
  current: readonly JoinOption[],
  makeId: () => string,
): JoinOption[] | undefined {
  if (input.length < JOIN_OPTION_MIN || input.length > JOIN_OPTION_MAX) {
    return undefined;
  }
  const taken = new Set(current.map((option) => option.id));
  const used = new Set<string>();
  const cleaned: JoinOption[] = [];
  for (const typed of input) {
    const ar = labelOf(typed.ar);
    const en = labelOf(typed.en);
    const kept = typed.id === undefined || taken.has(typed.id);
    if (
      (ar === null && en === null) ||
      tooLong(ar) ||
      tooLong(en) ||
      !kept ||
      (typed.id !== undefined && used.has(typed.id)) ||
      cleaned.some((other) => sameLabel(other.ar, ar) || sameLabel(other.en, en))
    ) {
      return undefined;
    }
    const id = typed.id ?? freshId(makeId, taken);
    taken.add(id);
    used.add(id);
    cleaned.push({ id, ar, en });
  }
  return cleaned;
}

function freshId(makeId: () => string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = makeId();
    if (OPTION_ID.test(id) && !taken.has(id)) {
      return id;
    }
  }
  throw new Error("could not make a new option id: makeId keeps returning taken or malformed ids");
}

/** An option's label in a language, else in the other one. */
export function joinOptionLabel(option: JoinOption, language: Language): string {
  const other: Language = language === "ar" ? "en" : "ar";
  return option[language] ?? option[other] ?? "";
}
