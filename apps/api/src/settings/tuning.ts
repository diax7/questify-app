import { TUNING, isUsableTuning, readPlatformSettings } from "@questify/shared";
import type { Client, PoolClient } from "pg";
import { readStoredPlatform } from "#src/settings/store";

/**
 * A tuning number as the console stored it (T-703), or the app's own when none is stored or the stored one is not a
 * whole number inside its range: the same rule the database functions and `composeConfig` use. For numbers the server
 * itself shows or applies; the database functions read their numbers on their own (migration 0125).
 */
export async function readTuning(
  db: Client | PoolClient,
  key: keyof typeof TUNING,
): Promise<number> {
  const definition = TUNING[key];
  if (definition === undefined) {
    throw new Error(`"${key}" is not a tuning number of the app; add it to the registry first`);
  }
  const stored = readPlatformSettings(await readStoredPlatform(db)).tuning?.[key];
  return isUsableTuning(stored, definition) ? stored : definition.default;
}
