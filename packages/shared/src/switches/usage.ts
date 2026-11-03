import { z } from "zod";
import type { FeatureDefinition, PlatformSettings, Registries } from "#src/config/registry";
import { isOrganizerOverridable, platformSwitchOf } from "./layers";

/**
 * The console's per-organizer feature usage (T-714, FR-1839, ADR-550): for each organizer, every event-level feature with
 * the layer state (the platform's switch and Questify's override for the organizer) and the events that switch it on and
 * that have content in it. The database door (`console_feature_usage`, migration 0140) answers counts only; the layers are
 * laid over them here with the functions the organizer's Features panel uses, so the two pages never disagree.
 */

/** The most recent events of an organizer the door reads; older ones are not counted (`more` says there are some). */
export const USAGE_EVENTS_CAP = 200;

/** The most organizers one page holds, and the default. */
export const USAGE_PAGE_MAX = 50;
export const USAGE_PAGE_DEFAULT = 25;

const count = z.number().int().min(0);

const rawOrganizerSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  /** Events read: the organizer's latest, at most `USAGE_EVENTS_CAP`. */
  events: count,
  more: z.boolean(),
  /** Questify's On or Off for the organizer, by feature. */
  overrides: z.record(z.string(), z.boolean()),
  /** Events that set their own switch for the feature on, and off. */
  switches: z.record(z.string(), z.strictObject({ on: count, off: count })),
  /** Events Questify unlocked the add-on for. */
  unlocked: z.record(z.string(), count),
  /** Events with content in the feature, for every feature the door measures. */
  using: z.record(z.string(), count),
});

/** What `console_feature_usage` answers: one entry per organizer of the page, in order. */
export const featureUsageRawSchema = z.strictObject({ organizers: z.array(rawOrganizerSchema) });
export type FeatureUsageRaw = z.infer<typeof featureUsageRawSchema>;
export type FeatureUsageRawOrganizer = z.infer<typeof rawOrganizerSchema>;

const rowSchema = z.strictObject({
  key: z.string(),
  /** An add-on: Questify unlocks it per event. */
  addOn: z.boolean(),
  /** What the platform's switch is now. */
  platformEnabled: z.boolean(),
  /** Questify's override for this organizer; null when it follows the platform or none applies to the feature. */
  override: z.boolean().nullable(),
  /** What the organizer's events get from the layers above them: the override, else the platform. */
  effective: z.boolean(),
  /** Events read that have the feature on (0 while `effective` is false). */
  eventsOn: count,
  /** Events read with content in the feature; null when the feature has no content of its own to count. */
  eventsUsing: count.nullable(),
});
export type FeatureUsageRow = z.infer<typeof rowSchema>;

const organizerSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  events: count,
  more: z.boolean(),
  features: z.array(rowSchema),
});
export type FeatureUsageOrganizer = z.infer<typeof organizerSchema>;

/** What `GET /v1/admin/feature-usage` answers. */
export const featureUsagePageSchema = z.strictObject({
  organizers: z.array(organizerSchema),
  nextCursor: z.uuid().nullable(),
});
export type FeatureUsagePage = z.infer<typeof featureUsagePageSchema>;

/** The features an organizer's events can have, in key order: those with an event layer (not Questify-wide ones). */
export function eventFeatureKeys(registries: Registries): string[] {
  return Object.entries(registries.features)
    .filter(([, definition]) => definition.level !== "platform")
    .map(([key]) => key)
    .sort();
}

/** Events whose own switch leaves a feature on: where the owner switched it on, or where the owner did not switch it off. */
function ownSwitchOn(
  definition: FeatureDefinition,
  key: string,
  raw: FeatureUsageRawOrganizer,
): number {
  const own = raw.switches[key];
  return definition.eventOffByDefault === true
    ? (own?.on ?? 0)
    : Math.max(0, raw.events - (own?.off ?? 0));
}

/**
 * How many of the events read have the feature on, by the rules of `featureLayer`: an add-on where Questify unlocked it,
 * any other where the owner's own switch leaves it on. Nothing while the platform or the override keeps it off.
 */
function eventsOnOf(
  definition: FeatureDefinition,
  key: string,
  raw: FeatureUsageRawOrganizer,
  effective: boolean,
): number {
  if (!effective) {
    return 0;
  }
  return definition.gated ? (raw.unlocked[key] ?? 0) : ownSwitchOn(definition, key, raw);
}

function rowOf(
  definition: FeatureDefinition,
  key: string,
  platform: PlatformSettings,
  raw: FeatureUsageRawOrganizer,
): FeatureUsageRow {
  const platformEnabled = platformSwitchOf(definition, platform, key);
  const override = isOrganizerOverridable(definition) ? (raw.overrides[key] ?? null) : null;
  const effective = override ?? platformEnabled;
  return {
    key,
    addOn: definition.gated,
    platformEnabled,
    override,
    effective,
    eventsOn: eventsOnOf(definition, key, raw, effective),
    eventsUsing: Object.hasOwn(raw.using, key) ? (raw.using[key] ?? 0) : null,
  };
}

/** One organizer's usage: the layers laid over the door's counts, a row for every event-level feature. */
export function featureUsageOrganizer(
  registries: Registries,
  platform: PlatformSettings,
  raw: FeatureUsageRawOrganizer,
): FeatureUsageOrganizer {
  const features: FeatureUsageRow[] = [];
  for (const key of eventFeatureKeys(registries)) {
    const definition = registries.features[key];
    if (definition !== undefined) {
      features.push(rowOf(definition, key, platform, raw));
    }
  }
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    events: raw.events,
    more: raw.more,
    features,
  };
}
