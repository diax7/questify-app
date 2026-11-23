import { DEFAULT_BRANDING, type Branding } from "#src/design/accents";
import type { LocalizedText } from "#src/errors";
import { maintenanceFor, type BannerSetting } from "#src/maintenance/notices";
import { playerDocuments, type LegalInForce } from "#src/legal/documents";
import { DEFAULT_COMPOSED_LAYOUT, composedLayoutOf, type ComposedLayout } from "#src/layout/layout";
import {
  DEFAULT_PLAYER_INTRO,
  composedPlayerIntroOf,
  type ComposedPlayerIntro,
} from "#src/layout/player-intro";
import {
  DEFAULT_QUESTIFY_HOME,
  composedQuestifyHomeOf,
  type ComposedQuestifyHome,
} from "#src/layout/questify-home";
import type {
  EventConfig,
  FeatureDefinition,
  PlatformFeatureSetting,
  PlatformSettings,
  Registries,
} from "./registry";
import { DEFAULT_TERMS, type EventTerms } from "./terms";
import { NO_EVENT_TEXTS, type EventTexts } from "./texts";

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
  /** The event's currency and renamed words, always complete; Questify's own words outside an event. */
  terms: EventTerms;
  /** The labels the event renamed, per language and key; empty outside an event and when it renamed none (T-614). */
  texts: EventTexts;
  /** The event's look (FR-1023); no accent outside an event or when the organizer picked none. */
  branding: Branding;
  /** The event's bar and Home blocks to show, in order (T-606, FR-1749); Questify's own outside an event. */
  layout: ComposedLayout;
  /** Questify home's blocks to show, in order, and its banner (T-713, FR-1838); the same inside an event. */
  questifyHome: ComposedQuestifyHome;
  /** The player intro's cards to play, in order (T-802b, FR-1803). */
  playerIntro: ComposedPlayerIntro;
  /** Why play is paused (T-703b, FR-1771): the event's own message, else the platform-wide one; null when play runs. */
  maintenance: LocalizedText | null;
  /** The banner for Questify Home (FR-1772) with its window; the app compares it with its own clock. */
  banner: BannerSetting | null;
}>;

/** The configuration before the legal block: what the shipped defaults, the platform and the event decide. */
export type ComposedBody = Omit<ComposedConfig, "legal">;

// The keys of an object are unique, so two of them are never equal.
const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : 1);

/** Whether the platform leaves a feature on: its stored switch, else the shipped default (ADR-208). */
export function platformAllows(
  definition: FeatureDefinition,
  setting: PlatformFeatureSetting | undefined,
): boolean {
  return setting?.enabled ?? definition.offByDefault !== true;
}

/** Whether an add-on is open to the event: an ungated feature always, a gated one once Questify unlocked it (FR-1729). */
export function unlockedFor(
  definition: FeatureDefinition,
  event: EventConfig | undefined,
  key: string,
): boolean {
  return !definition.gated || event?.unlocked?.includes(key) === true;
}

/** Whether the event's own switch leaves a feature on (FR-1623); a platform-level feature has none. */
export function eventSwitchOn(
  definition: FeatureDefinition,
  event: EventConfig | undefined,
  key: string,
): boolean {
  return (
    definition.level === "platform" ||
    (event?.features?.[key] ?? definition.eventOffByDefault !== true)
  );
}

/** Whether the event leaves a feature on: unlocked when gated, and its own switch. */
export function eventAllows(
  definition: FeatureDefinition,
  event: EventConfig | undefined,
  key: string,
): boolean {
  return unlockedFor(definition, event, key) && eventSwitchOn(definition, event, key);
}

/** One feature as the app receives it: on only when the platform and the event both leave it on. */
export function composeFeature(
  definition: FeatureDefinition,
  setting: PlatformFeatureSetting | undefined,
  event: EventConfig | undefined,
  key: string,
): ComposedFeature {
  const platformOn = platformAllows(definition, setting);
  return {
    enabled: platformOn && eventAllows(definition, event, key),
    minAppVersion: setting?.minAppVersion ?? null,
    message: platformOn ? null : (setting?.message ?? null),
  };
}

function composeFeatures(
  registries: Registries,
  platform: PlatformSettings,
  event: EventConfig | undefined,
): Record<string, ComposedFeature> {
  const entries = Object.entries(registries.features).sort(byKey);
  return Object.fromEntries(
    entries.map(([key, definition]) => [
      key,
      composeFeature(definition, platform.features?.[key], event, key),
    ]),
  );
}

function composeTuning(registries: Registries, platform: PlatformSettings): Record<string, number> {
  const entries = Object.entries(registries.tuning)
    .filter(([, definition]) => definition.serverOnly !== true)
    .sort(byKey);
  return Object.fromEntries(
    entries.map(([key, definition]) => {
      // A missing number counts as NaN, and NaN and infinities fall outside every range.
      const stored = platform.tuning?.[key] ?? Number.NaN;
      const usable = stored >= definition.min && stored <= definition.max;
      return [key, usable ? stored : definition.default];
    }),
  );
}

/** The event's own words, labels, accent and layout, each Questify's own where the event set none (or there is no event). */
function composeEventLook(
  event: EventConfig | undefined,
): Pick<ComposedConfig, "terms" | "texts" | "branding" | "layout"> {
  const set = event ?? {};
  return {
    terms: set.terms ?? DEFAULT_TERMS,
    texts: set.texts ?? NO_EVENT_TEXTS,
    branding: set.branding ?? DEFAULT_BRANDING,
    layout: set.layout === undefined ? DEFAULT_COMPOSED_LAYOUT : composedLayoutOf(set.layout),
  };
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
): ComposedBody {
  return {
    schemaVersion: 1,
    features: composeFeatures(registries, platform, event),
    tuning: composeTuning(registries, platform),
    ...composeEventLook(event),
    questifyHome: composedQuestifyHomeOf(platform.questifyHome ?? DEFAULT_QUESTIFY_HOME),
    playerIntro: composedPlayerIntroOf(platform.playerIntro ?? DEFAULT_PLAYER_INTRO),
    maintenance: maintenanceFor(platform.maintenance, event?.id),
    banner: platform.banner ?? null,
  };
}

/** The composed configuration with the player documents in force (FR-1705), which an admin publishes (FR-1781). */
export function withLegal(body: ComposedBody, inForce: LegalInForce): ComposedConfig {
  return {
    ...body,
    legal: { documents: playerDocuments(inForce).map(({ id, version }) => ({ id, version })) },
  };
}
