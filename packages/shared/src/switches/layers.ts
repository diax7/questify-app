import { z } from "zod";
import type {
  EventConfig,
  FeatureDefinition,
  PlatformSettings,
  Registries,
} from "#src/config/registry";

/**
 * The three layers of a feature for one event (ADR-105, FR-1826, FR-1827): the platform's switch, which a Questify admin may
 * override for one organizer; Questify allowing the event (an add-on is unlocked per event); the owner's own switch.
 */

/** What Questify set for one organizer: a feature key to On or Off, over the platform's switch. */
export type OrganizerOverrides = Readonly<Record<string, boolean>>;

/** The body that sets one organizer's override (T-711): On or Off; removing it is a DELETE. */
export const organizerOverrideBodySchema = z.strictObject({ enabled: z.boolean() });
export type OrganizerOverrideBody = z.infer<typeof organizerOverrideBodySchema>;

/**
 * Whether an organizer's override can act on the feature: it has an event layer (not Questify-wide, FR-1702's username
 * changes and the like have no organizer to act on) and its platform rule is read for one event, not platform-wide (T-711b).
 */
export const isOrganizerOverridable = (definition: FeatureDefinition): boolean =>
  definition.level !== "platform" && definition.noOrganizerOverride !== true;

const definitionOf = (registries: Registries, key: string): FeatureDefinition | undefined =>
  Object.hasOwn(registries.features, key) ? registries.features[key] : undefined;

/** The platform's switch for a feature: what an admin set, else the app's own (off for a feature that ships off). */
const platformSwitchOf = (
  definition: FeatureDefinition,
  platform: PlatformSettings,
  key: string,
): boolean => platform.features?.[key]?.enabled ?? definition.offByDefault !== true;

/**
 * The platform settings as one organizer sees them: each override replaces that feature's platform switch. An override
 * carries no "switched off" message (the platform's message is about the platform), and a key the app no longer has, or one
 * that cannot be overridden, is ignored.
 */
export function platformForOrganizer(
  registries: Registries,
  platform: PlatformSettings,
  overrides: OrganizerOverrides,
): PlatformSettings {
  const entries = Object.entries(overrides).filter(([key]) => {
    const definition = definitionOf(registries, key);
    return definition !== undefined && isOrganizerOverridable(definition);
  });
  if (entries.length === 0) {
    return platform;
  }
  const features = { ...platform.features };
  for (const [key, enabled] of entries) {
    const minAppVersion = features[key]?.minAppVersion;
    features[key] = { enabled, ...(minAppVersion === undefined ? {} : { minAppVersion }) };
  }
  return { ...platform, features };
}

/** A feature as the owner meets it: not listed, an add-on Questify has not allowed, or a switch that is on or off. */
export type FeatureLayer = "hidden" | "locked" | "on" | "off";

/** The feature's definition when the owner can meet it: it has an event layer and the platform leaves it on. */
function listedDefinition(
  registries: Registries,
  platform: PlatformSettings,
  key: string,
): FeatureDefinition | undefined {
  const definition = definitionOf(registries, key);
  const listed =
    definition !== undefined &&
    definition.level !== "platform" &&
    platformSwitchOf(definition, platform, key);
  return listed ? definition : undefined;
}

/**
 * Where one feature stands for an event. `platform` is the platform as the event's organizer sees it
 * (`platformForOrganizer`). A feature with no event layer has no state for the owner: it is hidden.
 */
export function featureLayer(
  registries: Registries,
  platform: PlatformSettings,
  event: EventConfig,
  key: string,
): FeatureLayer {
  const definition = listedDefinition(registries, platform, key);
  if (definition === undefined) {
    return "hidden";
  }
  if (definition.gated) {
    return event.unlocked?.includes(key) === true ? "on" : "locked";
  }
  return (event.features?.[key] ?? definition.eventOffByDefault !== true) ? "on" : "off";
}

/** Whether the owner may switch the feature on: the platform leaves it on and Questify allowed it for the event. */
export const ownerMaySwitchOn = (layer: FeatureLayer): boolean => layer === "on" || layer === "off";

const layerRowSchema = z.strictObject({
  key: z.string(),
  state: z.enum(["on", "off", "locked"]),
  /** An add-on: Questify unlocks it for the event, the owner has no switch for it. */
  addOn: z.boolean(),
});

/** What `GET …/events/{id}/features` answers: the features the owner can see, hidden ones left out. */
export const eventLayersSchema = z.strictObject({ features: z.array(layerRowSchema) });
export type EventLayers = z.infer<typeof eventLayersSchema>;
export type EventLayerRow = z.infer<typeof layerRowSchema>;

/** The owner's list for an event: every event-level feature the platform leaves on, in key order. */
export function eventLayersOf(
  registries: Registries,
  platform: PlatformSettings,
  event: EventConfig,
): EventLayers {
  const rows: EventLayerRow[] = [];
  for (const key of Object.keys(registries.features).sort()) {
    const state = featureLayer(registries, platform, event, key);
    if (state !== "hidden") {
      rows.push({ key, state, addOn: registries.features[key]?.gated === true });
    }
  }
  return { features: rows };
}

const overrideRowSchema = z.strictObject({
  key: z.string(),
  /** What the platform's switch is now. */
  platformEnabled: z.boolean(),
  /** Questify's override for this organizer; null when the organizer follows the platform. */
  override: z.boolean().nullable(),
  /** What the organizer's events get: the override, else the platform. */
  effective: z.boolean(),
});

/** What `GET /v1/admin/organizers/{id}/features` answers: the features an override can act on. */
export const organizerFeaturesViewSchema = z.strictObject({ features: z.array(overrideRowSchema) });
export type OrganizerFeaturesView = z.infer<typeof organizerFeaturesViewSchema>;
export type OrganizerFeatureRow = z.infer<typeof overrideRowSchema>;

/** The console's list for one organizer: each overridable feature with the platform's switch, the override and the result. */
export function organizerFeaturesView(
  registries: Registries,
  platform: PlatformSettings,
  overrides: OrganizerOverrides,
): OrganizerFeaturesView {
  const rows: OrganizerFeatureRow[] = [];
  for (const key of Object.keys(registries.features).sort()) {
    const definition = definitionOf(registries, key);
    if (definition !== undefined && isOrganizerOverridable(definition)) {
      const platformEnabled = platformSwitchOf(definition, platform, key);
      const override = overrides[key] ?? null;
      rows.push({ key, platformEnabled, override, effective: override ?? platformEnabled });
    }
  }
  return { features: rows };
}
