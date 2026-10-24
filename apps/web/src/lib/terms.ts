import {
  DEFAULT_TERMS,
  readEventTerms,
  validateEventTerms,
  type EventTerms,
  type Language,
  type Word,
} from "@questify/shared";

export const WORDS = ["currency", "player", "operator", "quest", "category"] as const;
export type WordKey = (typeof WORDS)[number];
export const FORMS = ["one", "many"] as const;

/** The field a refusal names, as the form labels it: `player.en.one`. */
export type TermField = Readonly<{ word: WordKey; language: Language; form: "one" | "many" }>;

const isBlank = (word: Word): boolean =>
  [word.ar.one, word.ar.many, word.en.one, word.en.many].every((text) => text.trim() === "");

const sameWord = (a: Word, b: Word): boolean =>
  a.ar.one === b.ar.one &&
  a.ar.many === b.ar.many &&
  a.en.one === b.en.one &&
  a.en.many === b.en.many;

/**
 * What the form sends: the whole set, since a save replaces it. A word left wholly empty, or the same as Questify's
 * default, is left out, so it follows the default; a partly filled word goes as typed, so the check names the gap.
 */
export function termsBodyOf(draft: EventTerms): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of WORDS) {
    const word = draft[key];
    if (!isBlank(word) && !sameWord(word, DEFAULT_TERMS[key])) {
      body[key] = { ar: word.ar, en: word.en };
    }
  }
  if (draft.currency.icon !== DEFAULT_TERMS.currency.icon) {
    body["currency"] = { ...(body["currency"] as object | undefined), icon: draft.currency.icon };
  }
  return body;
}

/** Reads a refusal's path (`player.en.one`) as a field of the form, or undefined when it names none. */
export function termFieldOf(path: unknown): TermField | undefined {
  if (typeof path !== "string") {
    return undefined;
  }
  const [word, language, form, ...rest] = path.split(".");
  const known =
    (WORDS as readonly unknown[]).includes(word) &&
    (language === "ar" || language === "en") &&
    (form === "one" || form === "many") &&
    rest.length === 0;
  return known ? { word: word as WordKey, language, form } : undefined;
}

export type TermsCheck =
  | Readonly<{ ok: true; body: Record<string, unknown> }>
  | Readonly<{ ok: false; field: TermField | undefined }>;

/** The same check the API makes, before anything is sent, so a missing or bad form is named at once. */
export function checkTerms(draft: EventTerms): TermsCheck {
  const body = termsBodyOf(draft);
  const checked = validateEventTerms(body);
  return checked.ok
    ? { ok: true, body }
    : { ok: false, field: termFieldOf(checked.issues[0]?.path) };
}

/** The words as the app will show them once saved: trimmed, a word left out back to the default. */
export function previewOf(draft: EventTerms): EventTerms {
  return readEventTerms(termsBodyOf(draft));
}
