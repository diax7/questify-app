import { ANALYTICS_SCHEMAS, type AnalyticsPanel } from "@questify/shared";
import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type AnalyticsDeps = Readonly<{ pool: Pool }>;

/** The database door behind each panel (migration 0102); constants, never taken from a request. */
const DOORS: Readonly<Record<AnalyticsPanel, string>> = {
  participation: "analytics_participation",
  quests: "analytics_quests",
  economy: "analytics_economy",
};

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
  try {
    const answer = await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: team.organizerId, staffUserId: team.staffUserId },
        async () => {
          const { rows } = await client.query(`SELECT ${DOORS[panel]}($1) AS answer`, [eventId]);
          return rows[0]?.["answer"];
        },
      ),
    );
    return ANALYTICS_SCHEMAS[panel].parse(answer);
  } catch (error) {
    if ((error as { code?: string }).code === "AN404") {
      return undefined;
    }
    throw error;
  }
}
