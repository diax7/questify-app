import {
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  type Language,
  type MessageKey,
} from "@questify/shared";

/** The saved language choice: a preference only, readable by scripts, sent on same-site navigation. */
export const LANGUAGE_COOKIE = "qs_lang";

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { ar: "العربية", en: "English" };

export function isLanguage(value: unknown): value is Language {
  return value === "ar" || value === "en";
}

export function otherLanguage(language: Language): Language {
  return language === "ar" ? "en" : "ar";
}

export function directionOf(language: Language): "rtl" | "ltr" {
  return language === "ar" ? "rtl" : "ltr";
}

/**
 * The language for a visit to `/`: the saved choice, else the first Arabic or English entry in the browser's
 * `Accept-Language` by preference, else English (the same rule as the app, FR-1743).
 */
export function negotiateLanguage(
  saved: string | undefined,
  acceptLanguage: string | null,
): Language {
  if (isLanguage(saved)) {
    return saved;
  }
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...parameters] = entry.trim().split(";");
      const quality = parameters
        .map((parameter) => /^\s*q=([0-9.]+)\s*$/.exec(parameter)?.[1])
        .find((value) => value !== undefined);
      return { code: tag.split("-")[0]?.toLowerCase(), quality: Number(quality ?? "1"), index };
    })
    .filter((entry) => entry.quality > 0)
    .toSorted((a, b) => b.quality - a.quality || a.index - b.index);
  return ranked.map((entry) => entry.code).find(isLanguage) ?? "en";
}

/** The `Set-Cookie` value that remembers a language for a year. */
export function languageCookie(language: Language): string {
  return `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}

/**
 * Wraps left-to-right text (an email, a code) placed inside a sentence in Unicode isolation marks, so it keeps its own
 * order inside Arabic text and does not reorder the words around it.
 */
const FIRST_STRONG_ISOLATE = String.fromCodePoint(0x2068);
const POP_DIRECTIONAL_ISOLATE = String.fromCodePoint(0x2069);

export function isolate(text: string): string {
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;
}

export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

const translate = createTranslator(MESSAGES, NO_OVERRIDES);

/** The shipped texts in one language (translation-store overrides join with the first organizer screens). */
export function translatorFor(language: Language): Translate {
  return (key, params) => translate(key, language, params);
}
