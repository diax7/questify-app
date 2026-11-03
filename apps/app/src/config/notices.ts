import { bannerActive, type ComposedConfig, type Language } from "@questify/shared";

/** Why play is paused (T-703b, FR-1771), in the player's language, or null while play runs. */
export function maintenanceMessage(
  config: ComposedConfig | null | undefined,
  language: Language,
): string | null {
  const text = config?.maintenance?.[language].trim();
  return text === undefined || text === "" ? null : text;
}

/**
 * The scheduled banner (T-703b, FR-1772) while the phone's clock is inside its window: shown from the start, gone from
 * the end. The phone decides, so a copy kept offline stops showing a banner that has ended.
 */
export function bannerMessage(
  config: ComposedConfig | null | undefined,
  language: Language,
  now: number,
): string | null {
  return bannerActive(config?.banner, now) ? (config?.banner?.message[language] ?? null) : null;
}

/**
 * The messages players see for the features Questify switched off (T-703, FR-1769): the platform's switch is off and a
 * message was written. A feature off without a message stays hidden without a word; the same text is not listed twice.
 * Ordered by feature name, so the list does not move between reads.
 */
export function switchedOffMessages(
  config: ComposedConfig | null | undefined,
  language: Language,
): string[] {
  const features = Object.entries(config?.features ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const texts = features.flatMap(([, feature]) => {
    const text = feature.enabled ? undefined : feature.message?.[language].trim();
    return text === undefined || text === "" ? [] : [text];
  });
  return [...new Set(texts)];
}
