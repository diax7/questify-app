import {
  featureLayer,
  ownerMaySwitchOn,
  platformForOrganizer,
  readEventSwitches,
  readPlatformSettings,
  type EventConfig,
  type PlatformSettings,
  type Registries,
} from "@questify/shared";
import type { Client, PoolClient } from "pg";
import {
  readEntitlements,
  readEventOverrides,
  readStoredEventConfig,
  readStoredPlatform,
} from "#src/settings/store";

type Db = Client | PoolClient;

/** What decides an event's three layers, read together: the platform as its organizer sees it, and the event's own part. */
export type EventLayerInputs = Readonly<{ platform: PlatformSettings; event: EventConfig }>;

/**
 * Reads the platform (with the organizer's overrides laid over it), the event's switches and the add-ons Questify unlocked
 * for it. Undefined when the caller cannot see the event.
 */
export async function readEventLayerInputs(
  db: Db,
  registries: Registries,
  eventId: string,
): Promise<EventLayerInputs | undefined> {
  const stored = await readStoredEventConfig(db, eventId);
  if (stored === undefined) {
    return undefined;
  }
  const platform = readPlatformSettings(await readStoredPlatform(db));
  const overrides = await readEventOverrides(db, eventId);
  const unlocked = await readEntitlements(db, eventId);
  return {
    platform: platformForOrganizer(registries, platform, overrides),
    event: { features: readEventSwitches(stored), unlocked },
  };
}

/**
 * The first feature among `wanted` that the owner may not switch on for the event: one the platform (or Questify, for this
 * organizer) has off, or an add-on Questify has not allowed (FR-1826, FR-1827). Switching off is always allowed.
 */
export async function firstSwitchOnRefused(
  db: Db,
  registries: Registries,
  eventId: string,
  wanted: Readonly<Record<string, boolean>>,
): Promise<string | undefined> {
  const switchedOn = Object.entries(wanted)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
  if (switchedOn.length === 0) {
    return undefined;
  }
  const inputs = await readEventLayerInputs(db, registries, eventId);
  if (inputs === undefined) {
    return undefined;
  }
  return switchedOn.find(
    (key) => !ownerMaySwitchOn(featureLayer(registries, inputs.platform, inputs.event, key)),
  );
}
