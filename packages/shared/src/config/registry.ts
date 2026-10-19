import type { LocalizedText } from "#src/errors";

/** A feature that exists inside the reviewed app. Configuration can only switch these on or off (FR-1504). */
export type FeatureDefinition = Readonly<{
  /** An add-on: hidden for an event until Questify unlocks it for that event (FR-1729). */
  gated: boolean;
}>;

/** A number an admin may tune, with the range that is safe (F-279). Out-of-range values are never used. */
export type TuningDefinition = Readonly<{ default: number; min: number; max: number }>;

export type FeatureRegistry = Readonly<Record<string, FeatureDefinition>>;
export type TuningRegistry = Readonly<Record<string, TuningDefinition>>;
export type Registries = Readonly<{ features: FeatureRegistry; tuning: TuningRegistry }>;

/** What a Questify admin stores for one feature. Every field is optional; missing means the default. */
export type PlatformFeatureSetting = Readonly<{
  enabled?: boolean | undefined;
  /** Shown to players while the feature is off. */
  message?: LocalizedText | undefined;
  /** Apps older than this treat the feature as absent. */
  minAppVersion?: string | undefined;
}>;

export type PlatformSettings = Readonly<{
  features?: Readonly<Record<string, PlatformFeatureSetting>> | undefined;
  tuning?: Readonly<Record<string, number>> | undefined;
}>;

/** What an event stores in `event.config`. An event can only narrow what the platform allows. */
export type EventConfig = Readonly<{
  /** false switches a feature off for this event only. */
  features?: Readonly<Record<string, boolean>> | undefined;
  /** Gated features Questify unlocked for this event. */
  unlocked?: readonly string[] | undefined;
}>;

/**
 * The features the reviewed app contains. Add a key here in the same change that builds the feature
 * (and never to "prepare" one): a switch for something that is not in the app would break FR-1504.
 */
export const FEATURES: FeatureRegistry = {
  bigScreen: { gated: true },
  cheers: { gated: false },
  polls: { gated: false },
  shop: { gated: false },
};

/** Starting values from Q-074 (still to be tested in the field); admins adjust them inside the range. */
export const TUNING: TuningRegistry = {
  myQrGraceSeconds: { default: 5, min: 0, max: 30 },
  screenQrRotationSeconds: { default: 45, min: 30, max: 60 },
};

export const REGISTRIES: Registries = { features: FEATURES, tuning: TUNING };
