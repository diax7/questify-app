import {
  REGISTRIES,
  eventFeatureKeys,
  featureUsageOrganizer,
  featureUsageRawSchema,
  readPlatformSettings,
  type FeatureUsagePage,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
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

/** The two fields of `console_review_demo()` this page needs; the rest of its answer (the readiness) is not read. */
const demoOrganizerSchema = z.looseObject({
  exists: z.boolean(),
  organizerId: z.uuid().optional(),
});

/** The demo's organizer id in a `console_review_demo()` answer, or null when there is no demo. */
export function demoOrganizerIn(answer: unknown): string | null {
  const demo = demoOrganizerSchema.parse(answer);
  return demo.exists ? (demo.organizerId ?? null) : null;
}

/** The organizer the App Review demo runs under, or null when there is no demo (T-710): Questify's own, not a customer's. */
async function demoOrganizerOf(client: PoolClient): Promise<string | null> {
  return demoOrganizerIn(await answerOf(client, "SELECT console_review_demo() AS r"));
}

/**
 * One page of the console's feature usage (T-714, FR-1839): `console_feature_usage` (migration 0140) answers the counts of
 * the page's organizers and the platform's settings are read in the same seat, so the layers laid over the counts are the
 * ones in force at that moment. The review demo's organizer is left out of the page (Q-525), and the cursor still ends on
 * the last organizer the database sent, so paging goes on past it. Counts only, no personal data, so the read is not
 * audited (the T-709 doors are not either).
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
    const demo = await demoOrganizerOf(client);
    return {
      organizers: organizers
        .filter((raw) => raw.id !== demo)
        .map((raw) => featureUsageOrganizer(REGISTRIES, platform, raw)),
      nextCursor: organizers.length === query.limit ? (organizers.at(-1)?.id ?? null) : null,
    };
  });
}
