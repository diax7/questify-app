import { eventRecapSchema, type EventRecap, type RankState } from "@questify/shared";
import type { PoolClient } from "pg";

/** One row of `event_recap` (migration 0074). */
export type RecapRow = Readonly<{
  status_now: string;
  name: unknown;
  local_date: string;
  city: unknown;
  rank: number | null;
  rank_state: RankState;
  quests_done: number;
  souvenirs: unknown;
}>;

export type RecapAnswer =
  | Readonly<{ kind: "recap"; recap: EventRecap }>
  /** Not a member who played, an unknown event, a rehearsal account: the same answer for each. */
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_ended" }>;

/**
 * The recap the route answers (T-410, FR-752, ADR-339) from `event_recap`'s row: none without a row, `not_ended`
 * before the event has ended, else the event, the rank (the passport's rule), the quests done and the souvenirs. It
 * goes through the shared schema, which keeps only those fields.
 */
export function recapOf(eventId: string, row: RecapRow | undefined): RecapAnswer {
  if (row === undefined) {
    return { kind: "not_found" };
  }
  if (row.status_now !== "ended" && row.status_now !== "archived") {
    return { kind: "not_ended" };
  }
  const recap = eventRecapSchema.parse({
    event: { id: eventId, name: row.name, date: row.local_date, city: row.city },
    rank: { state: row.rank_state, value: row.rank_state === "final" ? row.rank : null },
    questsDone: row.quests_done,
    souvenirs: row.souvenirs,
  });
  return { kind: "recap", recap };
}

/** The calling player's recap of one event, read under their own request context. */
export async function readRecap(client: PoolClient, eventId: string): Promise<RecapAnswer> {
  const { rows } = await client.query<RecapRow>("SELECT * FROM event_recap($1)", [eventId]);
  return recapOf(eventId, rows[0]);
}
