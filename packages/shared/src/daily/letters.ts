/**
 * The daily word's letters (T-406, ADR-310, MINOR-6): five-letter words; English a to z; Arabic an explicit set of 33
 * letters, the 28 letters plus ة ى ء ؤ ئ, each its own key on the app's keyboard. أ إ آ ٱ fold to ا, and the
 * diacritics and the tatweel are dropped. Migration 0069's `daily_letters` holds the same lists (a DB test compares).
 */

export const DAILY_LANGUAGES = ["ar", "en"] as const;
export type DailyLanguage = (typeof DAILY_LANGUAGES)[number];

/** Every daily word and guess has this many letters. */
export const WORD_LENGTH = 5;

export const DAILY_LETTERS: Readonly<Record<DailyLanguage, readonly string[]>> = {
  ar: [..."ابتثجحخدذرزسشصضطظعغفقكلمنهويةىءؤئ"],
  en: [..."abcdefghijklmnopqrstuvwxyz"],
};

/** The Arabic diacritics (U+064B to U+065F, U+0670) and the tatweel (U+0640). */
const MARKS = /[\u064B-\u065F\u0670\u0640]/gu;
/** The alef forms that fold to a bare alef. */
const ALEF_FORMS = /[\u0622\u0623\u0625\u0671]/gu;

/** A word or guess as it is compared: trimmed; English lower-cased; Arabic without marks and with one alef. */
export function foldWord(language: DailyLanguage, text: string): string {
  const trimmed = text.trim();
  if (language === "en") return trimmed.toLowerCase();
  return trimmed.replace(MARKS, "").replace(ALEF_FORMS, "\u0627");
}

/** The normalized word when it is exactly five letters of the language, else null (the server's `word_norm`). */
export function normalizeWord(language: DailyLanguage, text: string): string | null {
  const folded = [...foldWord(language, text)];
  const letters = DAILY_LETTERS[language];
  return folded.length === WORD_LENGTH && folded.every((letter) => letters.includes(letter))
    ? folded.join("")
    : null;
}
