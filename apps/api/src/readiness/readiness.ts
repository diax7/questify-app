import {
  evaluateReadiness,
  readinessFactsSchema,
  readinessSoonRowsSchema,
  type Readiness,
  type ReadinessSoon,
} from "@questify/shared";
import type { Pool } from "pg";
import { notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type ReadinessDeps = Readonly<{ pool: Pool }>;

/**
 * The go-live checklist of one event, as its team reads it (T-618, FR-1845): the door's facts (`event_readiness`,
 * migration 0112, flags and counts only) checked against the strict schema and turned into items. Undefined for an event
 * outside the member's organizer or event limit (the database raises AN404). Read-only and nothing is kept: the facts
 * are indexed lookups of this event's rows. The checklist blocks nothing.
 */
export async function readReadiness(
  deps: ReadinessDeps,
  team: OrganizerContext,
  eventId: string,
): Promise<Readiness | undefined> {
  try {
    const answer = await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: team.organizerId, staffUserId: team.staffUserId },
        async () => {
          const { rows } = await client.query("SELECT event_readiness($1) AS answer", [eventId]);
          return rows[0]?.["answer"];
        },
      ),
    );
    return evaluateReadiness(readinessFactsSchema.parse(answer));
  } catch (error) {
    if ((error as { code?: string }).code === "AN404") {
      return undefined;
    }
    throw error;
  }
}

/**
 * The console's list (T-618): up to 100 events that start within 14 days and are not live yet, soonest first, each with
 * the same checklist its owner reads. The door re-reads the admin from the account (`app_admin_id`), so the request
 * flag set here opens nothing on its own; a refusal (RD404) is the same 404 the console hook gives.
 */
export async function readReadinessSoon(pool: Pool, adminId: string): Promise<ReadinessSoon> {
  try {
    const answer = await withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: adminId }, async () => {
        const { rows } = await client.query("SELECT readiness_soon() AS answer");
        return rows[0]?.["answer"];
      }),
    );
    const { events } = readinessSoonRowsSchema.parse(answer);
    return {
      events: events.map(({ facts, startsAt, endsAt, ...event }) => ({
        ...event,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        readiness: evaluateReadiness(facts),
      })),
    };
  } catch (error) {
    if ((error as { code?: string }).code === "RD404") {
      throw notFound();
    }
    throw error;
  }
}
