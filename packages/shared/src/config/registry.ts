import type { LocalizedText } from "#src/errors";
import type { EventTerms } from "./terms";

/** A feature that exists inside the reviewed app. Configuration can only switch these on or off (FR-1504). */
export type FeatureDefinition = Readonly<{
  /** An add-on: hidden for an event until Questify unlocks it for that event (FR-1729). */
  gated: boolean;
  /** Set by Questify for every event at once; an organizer has no switch for it (FR-1702's username changes). */
  level?: "platform";
  /** Off until a Questify admin switches it on (the location switch waits for the store privacy answers, ADR-208). */
  offByDefault?: true;
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
  /** The event's own words (FR-404, FR-940); the defaults when it set none. */
  terms?: EventTerms | undefined;
}>;

/**
 * The features the reviewed app contains. Add a key here in the same change that builds the feature
 * (and never to "prepare" one): a switch for something that is not in the app would break FR-1504.
 */
export const FEATURES: FeatureRegistry = {
  bigScreen: { gated: true },
  cheers: { gated: false },
  /**
   * Location check-in quests and the far-from-venue flag (T-303b, ADR-208): off for every event until the App Store
   * privacy label, Play's Data safety form and the database's parameter logging are confirmed. Off, the builder refuses
   * the type, the app never reads location, and existing location quests complete by their QR.
   */
  locationQuests: { gated: false, level: "platform", offByDefault: true },
  /** Meet-someone quests (T-303c, FR-1009, ADR-210): the owner turns them off for an event, which hides every one. */
  meetSomeone: { gated: false },
  /** Mini-games (T-305, FR-1009, ADR-213): the owner turns them off for an event, which hides every game quest. */
  miniGames: { gated: false },
  polls: { gated: false },
  /** The event ranking (T-106, FR-607): the owner turns it off and on for an event. */
  ranking: { gated: false },
  /** Today's ranking for a multi-day event (T-216, FR-608): the owner turns it off and on. */
  rankingToday: { gated: false },
  /** Share quests (T-303, FR-219, ADR-199): the owner turns them off for an event, which hides every one. */
  shareQuests: { gated: false },
  shop: { gated: false },
  /** Players may change their username (FR-1702), at most once per `usernameChangeDays`. */
  usernameChanges: { gated: false, level: "platform" },
};

/** Starting values from Q-074 (still to be tested in the field); admins adjust them inside the range. */
export const TUNING: TuningRegistry = {
  /** Seconds between the app's reads of what is live in an event (T-306, ADR-221), while an event screen is open. */
  livePollSeconds: { default: 10, min: 5, max: 60 },
  myQrGraceSeconds: { default: 5, min: 0, max: 30 },
  screenQrRotationSeconds: { default: 45, min: 30, max: 60 },
  /** Days between two username changes (FR-705); sign-up does not count. */
  usernameChangeDays: { default: 30, min: 1, max: 365 },
};

export const REGISTRIES: Registries = { features: FEATURES, tuning: TUNING };
