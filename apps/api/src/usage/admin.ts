import type { UsageEvents, UsageOrganizer } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { demoOrganizerIn } from "#src/console/feature-usage";
import { withRequestContext } from "#src/db/context";

/**
 * The console's usage view (T-609, FR-1730, ADR-394): two read-only doors of migration 0104 that answer counts and
 * re-read the admin from the account (`app_admin_id`), so the request flag set here opens nothing on its own. A refusal
 * (US404: not an active platform admin, or no such organizer) is the same 404 the console hook gives.
 */
async function seat<T>(
  pool: Pool,
  adminId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: adminId }, () => work(client)),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "US404") throw notFound();
    throw error;
  }
}

async function door<T>(pool: Pool, adminId: string, sql: string, values: unknown[]): Promise<T> {
  return seat(pool, adminId, async (client) => {
    const { rows } = await client.query<{ r: T }>(sql, values);
    return rows[0]?.r as T;
  });
}

/**
 * The 100 organizers created last, with their events, players, invitations sent and alert emails sent. The organizer the App
 * Review demo runs under is left out (T-710, Q-525): it is Questify's own, not a customer's.
 */
export const listUsage = (
  pool: Pool,
  adminId: string,
): Promise<Readonly<{ organizers: UsageOrganizer[] }>> =>
  seat(pool, adminId, async (client) => {
    const list = await client.query<{ r: { organizers: UsageOrganizer[] } }>(
      "SELECT usage_organizers() AS r",
    );
    const demo = await client.query<{ r: unknown }>("SELECT console_review_demo() AS r");
    const demoId = demoOrganizerIn(demo.rows[0]?.r);
    const organizers = list.rows[0]?.r.organizers ?? [];
    return { organizers: organizers.filter((organizer) => organizer.id !== demoId) };
  });

/** One organizer's 200 latest events with the same figures. */
export const readOrganizerUsage = (
  pool: Pool,
  adminId: string,
  organizerId: string,
): Promise<UsageEvents> => door(pool, adminId, "SELECT usage_events($1) AS r", [organizerId]);
