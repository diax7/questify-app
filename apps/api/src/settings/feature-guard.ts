import { featureOff } from "#src/auth/http-errors";
import type { SettingsService } from "#src/settings/service";

type Reader = Pick<SettingsService, "forEvent">;

/**
 * Whether the event's composed configuration has the feature on for this player: the platform's switch, the event's own
 * and any unlock all count (FR-1009). An event the player cannot see counts as on, so the door behind answers as it always did.
 */
export async function eventFeatureOn(
  settings: Reader,
  eventId: string,
  playerId: string,
  feature: string,
): Promise<boolean> {
  const config = await settings.forEvent(eventId, playerId);
  return config.kind !== "ok" || config.config.features[feature]?.enabled !== false;
}

/** Refuses with 403 `feature_off` while the feature is off for the event, before any door is asked. */
export async function requireEventFeature(
  settings: Reader,
  eventId: string,
  playerId: string,
  feature: string,
): Promise<void> {
  if (!(await eventFeatureOn(settings, eventId, playerId, feature))) {
    throw featureOff();
  }
}
