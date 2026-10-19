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
  /**
   * The layout could not be turned to the language's direction (Expo Go resets it on every launch), so the texts are
   * in the wanted language but the layout keeps the direction the app started with.
   */
  fellBack: boolean;
}>;

/**
 * The `textAlign` that puts text at the reading start of the language: right for Arabic, left for English. React
 * Native swaps "left" and "right" when the whole app runs right to left, so the value depends on the layout the app
 * started with too (in Expo Go an Arabic screen can run in a left-to-right app).
 */
export function textAlignFor(language: Language, layoutIsRtl: boolean): "left" | "right" {
  return isRtl(language) === layoutIsRtl ? "left" : "right";
}

/** The language whose direction matches the layout the app actually started with. */
export function languageOfLayout(layoutIsRtl: boolean): Language {
  return layoutIsRtl ? "ar" : "en";
}

/**
 * Chooses the language at launch: the player's saved choice if there is a valid one, otherwise the phone's
 * language (FR-1743). React Native reads the layout direction only at launch, so a language whose direction
 * differs from the direction the app started with takes effect after a restart (ADR-110).
 *
 * If a restart for this language was already tried and the direction still does not match (Expo Go, or a phone that
 * will not switch), the app keeps the player's language for the texts and does not restart again. Dropping back to
 * the other language would make the switch look like it did nothing.
 */
export function decideBoot(input: {
  stored: unknown;
  device: readonly DeviceLocale[];
  layoutIsRtl: boolean;
  restartTriedFor: unknown;
}): BootDecision {
  const wanted = isLanguage(input.stored) ? input.stored : languageFromDevice(input.device);
  const mismatch = isRtl(wanted) !== input.layoutIsRtl;
  if (mismatch && input.restartTriedFor === wanted) {
    return { language: wanted, needsRestart: false, fellBack: true };
  }
  return { language: wanted, needsRestart: mismatch, fellBack: false };
}
