import { inboxSchema, type Inbox } from "@questify/shared";
import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";

export type InboxDeps = Readonly<{ pool: Pool }>;

/**
 * What waits for the event's team, as the member reads it (T-616): the door's answer (`event_inbox`, migration 0110)
 * checked against the strict schema, so nothing but counts can leave. Undefined for an event outside the member's
 * organizer or event limit (the database raises AN404). Nothing is kept between requests: every figure is an index
 * count of the event's open rows.
 */
export async function readInbox(
  deps: InboxDeps,
  team: OrganizerContext,
  eventId: string,
): Promise<Inbox | undefined> {
  try {
    const answer = await withConnection(deps.pool, (client) =>
      withRequestContext(client, teamSeat(team), async () => {
        const { rows } = await client.query("SELECT event_inbox($1) AS answer", [eventId]);
        return rows[0]?.["answer"];
      }),
    );
    return inboxSchema.parse(answer);
  } catch (error) {
    if ((error as { code?: string }).code === "AN404") {
      return undefined;
    }
    throw error;
  }
}
