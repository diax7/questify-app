import type { Language } from "@questify/shared";

/**
 * Used when the phone is set to neither Arabic nor English. English keeps the first launch free of a restart:
 * such a phone lays screens out left to right already, which is what English needs.
 */
export const FALLBACK_LANGUAGE: Language = "en";

/** One entry of the phone's language list, as `expo-localization` reports it. */
export type DeviceLocale = Readonly<{ languageCode: string | null }>;

export function isLanguage(value: unknown): value is Language {
  return value === "ar" || value === "en";
}

/** Arabic is laid out right to left, English left to right (FR-1506). */
export function isRtl(language: Language): boolean {
  return language === "ar";
}

/** The first language in the phone's list that the app speaks. */
export function languageFromDevice(locales: readonly DeviceLocale[]): Language {
  for (const locale of locales) {
    const code = locale.languageCode?.toLowerCase();
    if (isLanguage(code)) {
      return code;
    }
  }
  return FALLBACK_LANGUAGE;
}

export type BootDecision = Readonly<{
  language: Language;
  /** The layout direction the phone started with is not the one this language needs (Q-079). */
  needsRestart: boolean;
}>;

/**
 * Chooses the language at launch: the player's saved choice if there is a valid one, otherwise the phone's
 * language (FR-1743). React Native reads the layout direction only at launch, so a language whose direction
 * differs from the direction the app started with takes effect after a restart.
 */
export function decideBoot(input: {
  stored: unknown;
  device: readonly DeviceLocale[];
  layoutIsRtl: boolean;
}): BootDecision {
  const language = isLanguage(input.stored) ? input.stored : languageFromDevice(input.device);
  return { language, needsRestart: isRtl(language) !== input.layoutIsRtl };
}
