import type { OrganizerAlertSwitches } from "@questify/shared";
import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type AlertDeps = Readonly<{ pool: Pool }>;

/** The refusals of migration 0082's doors: AL404 is a caller who is not a member of the organizer, AL422 a bad body. */
export type AlertSwitchesResult =
  | Readonly<{ kind: "done"; switches: OrganizerAlertSwitches }>
  | Readonly<{ kind: "not_found" | "invalid" }>;

/** Runs one door in the team member's seat; a refusal the database raises becomes its result. */
async function callDoor(
  deps: AlertDeps,
  context: OrganizerContext,
  sql: string,
  values: readonly unknown[],
): Promise<AlertSwitchesResult> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const switches = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<{ r: OrganizerAlertSwitches }>(sql, [...values]);
        return rows[0]?.r;
      }),
    );
    // The doors answer one object or raise; a missing one is a server fault.
    if (switches === undefined) {
      throw new Error("an alert switches door answered no row");
    }
    return { kind: "done", switches };
  } catch (error) {
    switch ((error as { code?: string }).code) {
      case "AL404":
        return { kind: "not_found" };
      case "AL422":
        return { kind: "invalid" };
      default:
        throw error;
    }
  }
}

/** The calling member's own alert switches for the organizer (`own_alert_switches`): all on until they switch one off. */
export function readOwnAlertSwitches(
  deps: AlertDeps,
  context: OrganizerContext,
): Promise<AlertSwitchesResult> {
  return callDoor(deps, context, "SELECT own_alert_switches($1) AS r", [context.organizerId]);
}

/**
 * Saves the calling member's own switches (`set_own_alert_switches`, audited by the database) and answers them as
 * stored. The door takes no member id: nobody, an owner included, sets another member's switches.
 */
export function saveOwnAlertSwitches(
  deps: AlertDeps,
  context: OrganizerContext,
  input: Readonly<{ switches: OrganizerAlertSwitches; requestId: string }>,
): Promise<AlertSwitchesResult> {
  return callDoor(deps, context, "SELECT set_own_alert_switches($1, $2::jsonb, $3) AS r", [
    context.organizerId,
    JSON.stringify(input.switches),
    input.requestId,
  ]);
}
