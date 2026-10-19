import type { LocalizedText } from "#src/errors";
import type { PlatformFeatureSetting, PlatformSettings } from "./registry";

const VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function readMessage(value: unknown): LocalizedText | undefined {
  return isRecord(value) && isText(value["ar"]) && isText(value["en"])
    ? { ar: value["ar"], en: value["en"] }
    : undefined;
}

function readFeature(value: unknown): PlatformFeatureSetting {
  if (!isRecord(value)) {
    return {};
  }
  const message = readMessage(value["message"]);
  const version = value["minAppVersion"];
  return {
    ...(typeof value["enabled"] === "boolean" ? { enabled: value["enabled"] } : {}),
    ...(message === undefined ? {} : { message }),
    ...(typeof version === "string" && VERSION.test(version) ? { minAppVersion: version } : {}),
  };
}

/**
 * Reads stored platform settings tolerantly: whatever is well formed is kept and the rest is dropped, so one
 * damaged value (a manual edit, an older shape) can never stop the app from getting a configuration.
 * New saves are strict (see validatePlatformSettings); this only guards reads.
 */
export function readPlatformSettings(stored: {
  features?: unknown;
  tuning?: unknown;
}): PlatformSettings {
  const features = isRecord(stored.features)
    ? Object.fromEntries(
        Object.entries(stored.features).map(([key, value]) => [key, readFeature(value)]),
      )
    : undefined;
  const tuning = isRecord(stored.tuning)
    ? Object.fromEntries(
        Object.entries(stored.tuning).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      )
    : undefined;
  return {
    ...(features === undefined ? {} : { features }),
    ...(tuning === undefined ? {} : { tuning }),
  };
}

/** Reads the feature switches stored in an event's config; anything that is not true or false is dropped. */
export function readEventSwitches(stored: unknown): Readonly<Record<string, boolean>> {
  const features = isRecord(stored) ? stored["features"] : undefined;
  return isRecord(features)
    ? Object.fromEntries(
        Object.entries(features).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      )
    : {};
}
