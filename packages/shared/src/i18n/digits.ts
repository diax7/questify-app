export type Language = "ar" | "en";

// Unicode blocks of the digit zero: Arabic-Indic U+0660 and extended Arabic-Indic (Persian) U+06F0.
const DIGIT_BLOCKS = [0x0660, 0x06f0] as const;

/**
 * Turns Arabic-Indic and Persian digits into 0-9. Numbers are shown in Western digits in both
 * languages (ADR-018, FR-1507), so texts an admin types are normalized on save.
 */
export function toWesternDigits(text: string): string {
  let result = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const zero = DIGIT_BLOCKS.find((start) => code >= start && code <= start + 9);
    result += zero === undefined ? character : String(code - zero);
  }
  return result;
}

const LOCALES: Record<Language, string> = { ar: "ar-SA", en: "en" };
const formatters: Partial<Record<Language, Intl.NumberFormat>> = {};

/** A number for display: Western digits, comma between thousands, in both languages (FR-1507). */
export function formatNumber(value: number, language: Language): string {
  // Some devices default Arabic to Arabic-Indic digits, so Western digits are asked for explicitly.
  formatters[language] ??= new Intl.NumberFormat(LOCALES[language], { numberingSystem: "latn" });
  return formatters[language].format(value);
}
