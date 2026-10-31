import type { Branding } from "#src/design/accents";
import type { LocalizedText } from "#src/errors";
import type { EventLayout } from "#src/layout/layout";
import type { EventTerms } from "./terms";

/** A feature that exists inside the reviewed app. Configuration can only switch these on or off (FR-1504). */
export type FeatureDefinition = Readonly<{
  /** An add-on: hidden for an event until Questify unlocks it for that event (FR-1729). */
  gated: boolean;
  /** Set by Questify for every event at once; an organizer has no switch for it (FR-1702's username changes). */
  level?: "platform";
  /** Off until a Questify admin switches it on (the location switch waits for the store privacy answers, ADR-208). */
  offByDefault?: true;
  /** Off for an event until its owner switches it on (quest ratings, FR-1623); the platform switch stays on. */
  eventOffByDefault?: true;
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
  /** The event's look (FR-1023): an accent from the curated list, or none. */
  branding?: Branding | undefined;
  /** The event's bar and Home blocks (T-606, FR-1749): the order and what is hidden; Questify's own layout when none. */
  layout?: EventLayout | undefined;
}>;

/**
 * The features the reviewed app contains. Add a key here in the same change that builds the feature
 * (and never to "prepare" one): a switch for something that is not in the app would break FR-1504.
 */
export const FEATURES: FeatureRegistry = {
  /**
   * The agenda (T-505, T-602, FR-1009): the owner turns it off for an event, which hides the Agenda in the app and refuses
   * its player doors; registrations and the team's own page stay. Off for the platform, the same for every event.
   */
  agenda: { gated: false },
  bigScreen: { gated: true },
  /**
   * Double-point boosts (T-307, FR-252, ADR-233): the owner turns them off for an event, which stops every boost paying
   * at once; off for the platform, no new boost is saved while running ones finish.
   */
  boosts: { gated: false },
  /**
   * Cheers (T-509, FR-1841, ADR-377): the owner turns them off for an event, which ends any live cheers moment at once; off for the
   * platform, no moment can start and the app's cheer card goes. The switch sits on the Big screen page.
   */
  cheers: { gated: false },
  /**
   * Community quests (T-306b, F-101, ADR-226): the owner turns them off for an event, which finishes its running
   * goals; off for the platform, the bar and the builder are hidden while running goals still finish and pay.
   */
  community: { gated: false },
  /**
   * The daily challenge (T-406, FR-730, ADR-312): off for the platform, the challenge is hidden and its doors refuse at
   * once; a play left unfinished pays nothing.
   */
  dailyChallenge: { gated: false, level: "platform" },
  /**
   * The Questify daily streak (T-405, FR-420, ADR-299): off for the platform, no day is counted, none is shown and no
   * milestone is paid, at once; a streak restarts after it is switched back on. No event switch: the event streak has
   * its own owner-only settings.
   */
  dailyStreak: { gated: false, level: "platform" },
  /**
   * The daily word (T-406, FR-1810, ADR-312): off for the platform, the word game is hidden and its doors refuse at
   * once; a play left unfinished pays nothing.
   */
  dailyWord: { gated: false, level: "platform" },
  /**
   * Flash quests (T-307, FR-251, ADR-231): off for an event or the platform, every flash quest is hidden and refused at
   * once, and none can be launched.
   */
  flashQuests: { gated: false },
  /**
   * The help desk (T-310, F-118, ADR-248): off for an event, players can no longer send questions or problem reports
   * (their answers stay readable) and open tickets stay answerable.
   */
  helpDesk: { gated: false },
  /**
   * Questify invitations (T-409, FR-738, ADR-330 (7)): off until a Questify admin switches it on, which waits for the
   * web pages (T-409b), the privacy policy's line on invitation counts and the promotional SMS sender (RUNBOOK). Off,
   * owners cannot request a campaign and nothing is started or sent at once; results keep being counted and published.
   * No event switch: the admin's approval is the per-event gate. Never shown in the mobile app (FR-740).
   */
  invitationCampaigns: { gated: false, level: "platform", offByDefault: true },
  /**
   * Location check-in quests and the far-from-venue flag (T-303b, ADR-208): off for every event until the App Store
   * privacy label, Play's Data safety form and the database's parameter logging are confirmed. Off, the builder refuses
   * the type, the app never reads location, and existing location quests complete by their QR.
   */
  locationQuests: { gated: false, level: "platform", offByDefault: true },
  /**
   * Kiosks and the live code (T-309b, F-107, ADR-245): off for the platform, kiosk pages show "Not available", no kiosk
   * scan is paid and the app serves no live code; pairing and the Devices page stay, so kiosks can still be revoked. No
   * event switch: the quest's own kiosk method is the organizer's. ADR-076's paid add-on gates it later.
   */
  kiosks: { gated: false, level: "platform" },
  /**
   * Maps (T-506, T-602, FR-1009): the owner turns them off for an event, which hides the map in the app and refuses its
   * player door; the team's Maps page and every pin stay.
   */
  maps: { gated: false },
  /** Meet-someone quests (T-303c, FR-1009, ADR-210): the owner turns them off for an event, which hides every one. */
  meetSomeone: { gated: false },
  /** Mini-games (T-305, FR-1009, ADR-213): the owner turns them off for an event, which hides every game quest. */
  miniGames: { gated: false },
  /**
   * NFC tags (T-308, F-105, ADR-234): off for the platform, the app hides NFC, tags can't be written or tapped, and every
   * NFC quest completes by its QR. No event switch: the quest's own NFC method is the organizer's.
   */
  nfcTags: { gated: false, level: "platform" },
  /**
   * Live polls (T-306, T-602, FR-1009): the owner turns them off for an event, which hides every live poll card, open or
   * closed; votes already cast stay counted and the team's own results stay. The database refuses a live poll's vote and
   * its reads while off (T-602c, 403 `feature_off`); a plain vote quest stays open.
   */
  polls: { gated: false },
  /**
   * Push notifications (T-501, ADR-345): off for the platform, nothing is claimed or sent and queued pushes expire unsent;
   * the notification center keeps every message, and registration, mutes and settle go on. No event switch: an event's
   * defaults for the topics are T-510's.
   */
  pushNotifications: { gated: false, level: "platform" },
  /**
   * The Questify-wide ranking (T-408, FR-611, ADR-322): off for the platform, Home and Explore hide it and its door
   * answers 404 `ranking_off` at once; the boards keep being written, so turning it back on is exact.
   */
  questifyRanking: { gated: false, level: "platform" },
  /**
   * Quest ratings (T-508, FR-1211, FR-1623): the owner turns them on for an event; off until then. Off for the platform, no
   * prompt shows and no rating is taken.
   */
  questRatings: { gated: false, eventOffByDefault: true },
  /** The event ranking (T-106, FR-607): the owner turns it off and on for an event. */
  ranking: { gated: false },
  /** Today's ranking for a multi-day event (T-216, FR-608): the owner turns it off and on. */
  rankingToday: { gated: false },
  /** Share quests (T-303, FR-219, ADR-199): the owner turns them off for an event, which hides every one. */
  shareQuests: { gated: false },
  /**
   * The shop (T-201, T-602, FR-1009): the owner turns it off for an event, which hides the Rewards tab, Home's shop card and
   * goal, and refuses the shop's read and a goal pin; a prize a player already holds is still handed over at the desk by
   * their My QR, cancelled or left to expire. The database refuses a new reservation while off (T-602c, 403 `feature_off`).
   */
  shop: { gated: false },
  /**
   * Station pages and the rotating screen QR (T-309, F-106, ADR-240): off for the platform, station pages show "Not
   * available" and no screen code is served; pairing and the Devices page stay, so devices can still be revoked. No
   * event switch: the quest's own screen QR method is the organizer's.
   */
  stations: { gated: false, level: "platform" },
  /** Players may change their username (FR-1702), at most once per `usernameChangeDays`. */
  usernameChanges: { gated: false, level: "platform" },
};

/** Starting values from Q-074 (still to be tested in the field); admins adjust them inside the range. */
export const TUNING: TuningRegistry = {
  /** Seconds between the app's reads of what is live in an event (T-306, ADR-221), while an event screen is open. */
  livePollSeconds: { default: 10, min: 5, max: 60 },
  myQrGraceSeconds: { default: 5, min: 0, max: 30 },
  /** Days between two username changes (FR-705); sign-up does not count. */
  usernameChangeDays: { default: 30, min: 1, max: 365 },
};

export const REGISTRIES: Registries = { features: FEATURES, tuning: TUNING };
