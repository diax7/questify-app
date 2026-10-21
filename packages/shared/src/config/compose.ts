import type { LocalizedText } from "#src/errors";
import { playerDocuments } from "#src/legal/documents";
import type { EventConfig, PlatformSettings, Registries } from "./registry";

export type ComposedFeature = Readonly<{
  enabled: boolean;
  /** Apps older than this treat the feature as absent. null means every app version. */
  minAppVersion: string | null;
  /** Why the feature is off, when the platform switched it off and said why. */
  message: LocalizedText | null;
}>;

/** The one document `GET /v1/config` returns: shipped defaults, then platform settings, then the event. */
export type ComposedConfig = Readonly<{
  schemaVersion: 1;
  features: Readonly<Record<string, ComposedFeature>>;
  tuning: Readonly<Record<string, number>>;
  /**
   * The player documents in force (FR-1705), for every event alike: the app shows these versions and sends them back,
   * so a new version never needs an app release.
   */
  legal: Readonly<{ documents: readonly Readonly<{ id: string; version: string }>[] }>;
}>;

// The keys of an object are unique, so two of them are never equal.
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : 1);

function composeFeatures(
  registries: Registries,
  platform: PlatformSettings,
  event: EventConfig | undefined,
): Record<string, ComposedFeature> {
  const entries = Object.entries(registries.features).toSorted(byKey);
  return Object.fromEntries(
    entries.map(([key, definition]) => {
      const setting = platform.features?.[key];
      const platformOn = setting?.enabled ?? true;
      const unlocked = !definition.gated || event?.unlocked?.includes(key) === true;
      const eventOn = definition.level === "platform" || (event?.features?.[key] ?? true);
      const feature: ComposedFeature = {
        enabled: platformOn && unlocked && eventOn,
        minAppVersion: setting?.minAppVersion ?? null,
        message: platformOn ? null : (setting?.message ?? null),
      };
      return [key, feature];
    }),
  );
}

function composeTuning(registries: Registries, platform: PlatformSettings): Record<string, number> {
  const entries = Object.entries(registries.tuning).toSorted(byKey);
  return Object.fromEntries(
    entries.map(([key, definition]) => {
      // A missing number counts as NaN, and NaN and infinities fall outside every range.
      const stored = platform.tuning?.[key] ?? Number.NaN;
      const usable = stored >= definition.min && stored <= definition.max;
      return [key, usable ? stored : definition.default];
    }),
  );
}

/**
 * Builds the configuration a player's app receives. A lower level can only narrow a higher one: an event
 * cannot switch on what the platform switched off, and an unknown feature or number is ignored because the
 * app can only use what it ships (FR-1504). Keys come out sorted, so equal inputs give an identical document.
 */
export function composeConfig(
  registries: Registries,
  platform: PlatformSettings,
  event: EventConfig | undefined,
): ComposedConfig {
  return {
    schemaVersion: 1,
    features: composeFeatures(registries, platform, event),
    tuning: composeTuning(registries, platform),
    legal: { documents: playerDocuments().map(({ id, version }) => ({ id, version })) },
  };
}
