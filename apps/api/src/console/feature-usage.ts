import {
  REGISTRIES,
  eventFeatureKeys,
  featureUsageOrganizer,
  featureUsageRawSchema,
  readPlatformSettings,
  type FeatureUsagePage,
} from "@questify/shared";
import type { Pool } from "pg";
import { door, type Admin } from "#src/console/doors";
import { answerOf } from "#src/console/platform";
import { readStoredPlatform } from "#src/settings/store";

export type FeatureUsageQuery = Readonly<{
  /** A prefix of the organizer's name or slug. */
  q: string | null;
  /** The last organizer of the page before. */
  cursor: string | null;
  limit: number;
}>;

/**
 * One page of the console's feature usage (T-714, FR-1839): `console_feature_usage` (migration 0140) answers the counts of
 * the page's organizers and the platform's settings are read in the same seat, so the layers laid over the counts are the
 * ones in force at that moment. Counts only, no personal data, so the read is not audited (the T-709 doors are not either).
 */
export function readFeatureUsage(
  pool: Pool,
  admin: Admin,
  query: FeatureUsageQuery,
): Promise<FeatureUsagePage> {
  return door(pool, admin, async (client) => {
    const platform = readPlatformSettings(await readStoredPlatform(client));
    const answer = await answerOf(client, "SELECT console_feature_usage($1, $2, $3, $4) AS r", [
      query.q,
      query.cursor,
      query.limit,
      eventFeatureKeys(REGISTRIES),
    ]);
    const { organizers } = featureUsageRawSchema.parse(answer);
    return {
      organizers: organizers.map((raw) => featureUsageOrganizer(REGISTRIES, platform, raw)),
      nextCursor: organizers.length === query.limit ? (organizers.at(-1)?.id ?? null) : null,
    };
  });
}
