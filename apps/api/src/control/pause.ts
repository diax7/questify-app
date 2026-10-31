import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type PauseDeps = Readonly<{ pool: Pool }>;

/** Which room switch a call sets (T-603b, FR-1026). */
export type RoomSwitch = "pause" | "resume" | "skip" | "unskip";

/** The quest's pause or skip after the call; `changed` is false when it already had it (nothing was written). */
export type SwitchValue =
  | Readonly<{ paused: boolean; changed: boolean }>
  | Readonly<{ skipped: boolean; changed: boolean }>;

/** Why the switch was refused (migration 0097); each maps to one HTTP answer in the routes. */
export type SwitchRefusal = Readonly<{ kind: "not_found" | "event_closed" | "not_in_order" }>;

export type SwitchDone = Readonly<{ kind: "done"; value: SwitchValue }> | SwitchRefusal;

/** The SQLSTATEs of `set_quest_paused` and `set_step_skipped` as refusals; undefined for anything else. */
export function switchRefusalOf(pg: Readonly<{ code?: string }>): SwitchRefusal | undefined {
  switch (pg.code) {
    case "AN404":
    case "AQ404":
    case "QX409":
      return { kind: "not_found" };
    case "QE409":
      return { kind: "event_closed" };
    case "SP422":
      return { kind: "not_in_order" };
    default:
      return undefined;
  }
}

const DOORS: Readonly<Record<RoomSwitch, Readonly<{ sql: string; key: "paused" | "skipped" }>>> = {
  pause: { sql: "SELECT set_quest_paused($1, $2, true, $3) AS r", key: "paused" },
  resume: { sql: "SELECT set_quest_paused($1, $2, false, $3) AS r", key: "paused" },
  skip: { sql: "SELECT set_step_skipped($1, $2, true, $3) AS r", key: "skipped" },
  unskip: { sql: "SELECT set_step_skipped($1, $2, false, $3) AS r", key: "skipped" },
};

/**
 * Pauses or resumes a quest, or skips or restores a step, as the caller inside their organizer and event limit. The
 * database checks the caller, the event's phase and the step's order, and audits a change; setting the state the
 * quest already has changes nothing.
 */
export async function setRoomSwitch(
  deps: PauseDeps,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; questId: string; requestId: string; action: RoomSwitch }>,
): Promise<SwitchDone> {
  const door = DOORS[target.action];
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const answer = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<{ r: Record<string, unknown> }>(door.sql, [
          target.eventId,
          target.questId,
          target.requestId,
        ]);
        return rows[0]?.r ?? {};
      }),
    );
    const state = answer[door.key] === true;
    const changed = answer["changed"] === true;
    return {
      kind: "done",
      value: door.key === "paused" ? { paused: state, changed } : { skipped: state, changed },
    };
  } catch (error) {
    const refusal = switchRefusalOf(error as { code?: string });
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}
