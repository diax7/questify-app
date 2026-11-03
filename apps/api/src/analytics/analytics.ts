import {
  ANALYTICS_SCHEMAS,
  sponsorRawSchema,
  sponsorTotals,
  type AnalyticsPanel,
  type SponsorTotals,
} from "@questify/shared";
import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";

export type AnalyticsDeps = Readonly<{ pool: Pool }>;

/** The database door behind each panel (migration 0102); constants, never taken from a request. */
const DOORS: Readonly<Record<AnalyticsPanel, string>> = {
  participation: "analytics_participation",
  quests: "analytics_quests",
  economy: "analytics_economy",
};

/**
 * One door of the exports and analytics under the member's seat: its answer, or undefined when the database refuses
 * with AN404 (an event, or a sponsor, outside the member's organizer or event limit). Any other fault is thrown.
 */
export async function callDoor(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  sql: string,
  values: readonly unknown[],
): Promise<unknown> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, teamSeat(team), async () => {
        const { rows } = await client.query(`SELECT ${sql} AS answer`, [...values]);
        return rows[0]?.["answer"];
      }),
    );
  } catch (error) {
    if ((error as { code?: string }).code === "AN404") {
      return undefined;
    }
    throw error;
  }
}

/**
 * One panel of the event's analytics as the team member reads it: the door's answer, checked against the panel's
 * schema so nothing but counts can leave. Undefined for an event outside the member's organizer or event limit (the
 * database raises AN404). Nothing is kept between requests: each door reads indexes and the players' own rows, never
 * the points record, and answers a 50,000-player event in well under a second.
 */
export async function readAnalytics(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  eventId: string,
  panel: AnalyticsPanel,
): Promise<unknown> {
  const answer = await callDoor(deps, team, `${DOORS[panel]}($1)`, [eventId]);
  return answer === undefined ? undefined : ANALYTICS_SCHEMAS[panel].parse(answer);
}

/**
 * A sponsor's totals as the sponsor may see them (FR-1306, FR-1626): the door's exact counts checked against the strict
 * schema, then every count under the floor left out. Undefined for an event or a sponsor the member cannot reach.
 */
export async function readSponsorTotals(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  eventId: string,
  sponsorId: string,
): Promise<SponsorTotals | undefined> {
  const answer = await callDoor(deps, team, "analytics_sponsor($1, $2)", [eventId, sponsorId]);
  return answer === undefined ? undefined : sponsorTotals(sponsorRawSchema.parse(answer));
}
