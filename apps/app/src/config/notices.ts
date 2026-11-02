import type { ComposedConfig, Language } from "@questify/shared";

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
