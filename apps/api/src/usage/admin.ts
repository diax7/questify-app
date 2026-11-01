import type { UsageEvents, UsageOrganizer } from "@questify/shared";
import type { Pool } from "pg";
import { notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/**
 * The console's usage view (T-609, FR-1730, ADR-394): two read-only doors of migration 0104 that answer counts and
 * re-read the admin from the account (`app_admin_id`), so the request flag set here opens nothing on its own. A refusal
 * (US404: not an active platform admin, or no such organizer) is the same 404 the console hook gives.
 */
async function door<T>(pool: Pool, adminId: string, sql: string, values: unknown[]): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: adminId }, async () => {
        const { rows } = await client.query<{ r: T }>(sql, values);
        return rows[0]?.r as T;
      }),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "US404") throw notFound();
    throw error;
  }
}

/** The 100 organizers created last, with their events, players, invitations sent and alert emails sent. */
export const listUsage = (
  pool: Pool,
  adminId: string,
): Promise<Readonly<{ organizers: UsageOrganizer[] }>> =>
  door(pool, adminId, "SELECT usage_organizers() AS r", []);

/** One organizer's 200 latest events with the same figures. */
export const readOrganizerUsage = (
  pool: Pool,
  adminId: string,
  organizerId: string,
): Promise<UsageEvents> => door(pool, adminId, "SELECT usage_events($1) AS r", [organizerId]);
