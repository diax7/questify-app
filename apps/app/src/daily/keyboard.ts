import type { DailyLanguage } from "@questify/shared";

/**
 * The app's own keyboard for the daily word (T-406b): every letter of the language's set, each on its own key. Arabic has
 * all 33 keys including ة ى ء ؤ ئ (ADR-310); the system keyboard is never used, so a guess can only hold these letters.
 * Rows are in reading order for the language (Arabic rows read right to left on screen).
 */
export const KEY_ROWS: Readonly<Record<DailyLanguage, ReadonlyArray<readonly string[]>>> = {
  ar: [[..."ضصثقفغعهخ"], [..."حجدشسيبل"], [..."اتنمكطذر"], [..."زظوةىءؤئ"]],
  en: [[..."qwertyuiop"], [..."asdfghjkl"], [..."zxcvbnm"]],
};

/** The grid and the keyboard follow the word's language, not the app's: an Arabic word fills right to left in English too. */
export const gridDirection = (language: DailyLanguage): "rtl" | "ltr" =>
  language === "ar" ? "rtl" : "ltr";

/** What a tile shows for a letter: English in capitals, Arabic letters alone (each tile is one isolated form). */
export const tileLetter = (language: DailyLanguage, letter: string): string =>
  language === "en" ? letter.toUpperCase() : letter;
