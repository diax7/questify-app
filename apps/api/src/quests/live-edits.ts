import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

/**
 * Live points edits (T-604, FR-411, FR-412, FR-413, ADR-387): the database doors of migration 0098 as the builder calls
 * them. "Also past" makes every kept completion worth the quest's new points through compensating entries; a played
 * quest's delete keeps or removes its points; the impact read gives the screen its real numbers.
 */

/** The types paid the quest's points (times a boost) once per completion: the only ones "also past" reaches. */
export const PAST_POINTS_TYPES: readonly string[] = [
  "scan_qr",
  "enter_code",
  "location",
  "vote",
  "survey",
  "share",
  "challenge",
  "passport",
  "meet",
];

/** What one past-points change did; `replayed` when the key had already run. */
export type PastChange = Readonly<{
  completions: number;
  players: number;
  raised: number;
  lowered: number;
  clamped: number;
  replayed: boolean;
}>;

/** The screen's numbers for new points (FR-413, FR-1032). */
export type PointsImpact = Readonly<{
  eligible: boolean;
  completions: number;
  players: number;
  raise: number;
  lower: number;
  clamped: number;
  prizesHanded: number;
}>;

/** What a played quest's delete took back. */
export type DeleteOutcome = Readonly<{ removed: number; total: number }>;

/** Why a live edit was refused by its door; each maps to one HTTP answer. */
export type LiveEditRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_not_live" }>
  | Readonly<{ kind: "results_final" }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "over_cap"; limit: number }>
  | Readonly<{ kind: "invalid"; field: "apply" }>;

const whole = (value: unknown): number => Number(value ?? 0);

/**
 * A refusal raised by the past or delete door inside a builder transaction: thrown so the transaction rolls back, and
 * answered by the builder only when it came from these doors (another door's AQ404 or AK422 means something else).
 */
export class LiveEditError extends Error {
  readonly refusal: LiveEditRefusal;

  constructor(refusal: LiveEditRefusal, cause: unknown) {
    super(`live edit refused: ${refusal.kind}`, { cause });
    this.name = "LiveEditError";
    this.refusal = refusal;
  }
}

/** Runs one call of a live-edit door, turning its refusals into a `LiveEditError`; anything else is thrown as it is. */
async function liveEditDoor<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const refusal = liveEditRefusal(error as { code?: string; hint?: string });
    throw refusal === undefined ? error : new LiveEditError(refusal, error);
  }
}

/** The SQLSTATEs of the past, delete and impact doors as refusals; undefined for anything else. */
export function liveEditRefusal(
  pg: Readonly<{ code?: string; hint?: string }>,
): LiveEditRefusal | undefined {
  switch (pg.code) {
    case "AQ404":
      return { kind: "not_found" };
    case "AS409":
      return { kind: "event_not_live" };
    case "RF409":
      return { kind: "results_final" };
    case "AK422":
      return { kind: "key_reused" };
    case "AC409":
      return { kind: "over_cap", limit: whole(pg.hint?.split(",")[0]) };
    case "PX422":
      return { kind: "invalid", field: "apply" };
    default:
      return undefined;
  }
}

type ChangeRow = {
  quest_id: string;
  to_points: number;
  completions: number;
  players: number;
  raised: number;
  lowered: number;
  clamped: number;
};

const changeOf = (row: ChangeRow, replayed: boolean): PastChange => ({
  completions: row.completions,
  players: row.players,
  raised: row.raised,
  lowered: row.lowered,
  clamped: row.clamped,
  replayed,
});

/**
 * The caller's earlier change under this key, read before anything is written: `same` when it was this quest at these
 * points (the answer is replayed), `other` when the key was used for another change, undefined when the key is new.
 */
export async function pastReplay(
  client: PoolClient,
  target: Readonly<{ eventId: string; questId: string; points: number; key: string }>,
): Promise<
  Readonly<{ kind: "same"; change: PastChange }> | Readonly<{ kind: "other" }> | undefined
> {
  const { rows } = await client.query<ChangeRow>("SELECT * FROM past_points_replay($1, $2)", [
    target.eventId,
    target.key,
  ]);
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return row.quest_id === target.questId && row.to_points === target.points
    ? { kind: "same", change: changeOf(row, true) }
    : { kind: "other" };
}

/** Entries one call of the past door writes at most: about 1.5 s each, well under the statement timeout (ADR-387). */
export const PAST_BATCH = 2000;

/** The longest key "also past" takes: the door stores its later calls as `key#2`, `key#3` within 255 characters. */
export const PAST_KEY_MAX = 240;

/**
 * Runs "also past" for the quest's points as this transaction wrote them, calling the door again with the next part
 * while it reports `more` (each call its own statement, in this transaction; the door keys them `key#2`, `key#3`).
 * Players and clamped come from part 1 alone, so the parts' sum is the answer a replay gives. Refusals throw a
 * `LiveEditError`.
 */
export async function applyPast(
  client: PoolClient,
  target: Readonly<{
    eventId: string;
    questId: string;
    fromPoints: number;
    key: string;
    requestId: string;
  }>,
): Promise<PastChange> {
  const total = { completions: 0, players: 0, raised: 0, lowered: 0, clamped: 0, replayed: false };
  for (let part = 1; ; part += 1) {
    const { rows } = await liveEditDoor(() =>
      client.query<ChangeRow & { replayed: boolean; more: boolean }>(
        "SELECT * FROM apply_past_points($1, $2, $3, $4, $5, $6, $7)",
        [
          target.eventId,
          target.questId,
          target.fromPoints,
          target.key,
          target.requestId,
          PAST_BATCH,
          part,
        ],
      ),
    );
    const row = rows[0] as ChangeRow & { replayed: boolean; more: boolean };
    total.completions += row.completions;
    total.players += row.players;
    total.raised += row.raised;
    total.lowered += row.lowered;
    total.clamped += row.clamped;
    total.replayed = row.replayed;
    if (!row.more) {
      return total;
    }
  }
}

/** Deletes a played quest, keeping or removing its points. Refusals throw a `LiveEditError`. */
export async function deletePlayed(
  client: PoolClient,
  target: Readonly<{ eventId: string; questId: string; remove: boolean; requestId: string }>,
): Promise<DeleteOutcome> {
  const { rows } = await liveEditDoor(() =>
    client.query<{ removed: number; total: string }>(
      "SELECT * FROM delete_played_quest($1, $2, $3, NULL, $4)",
      [target.eventId, target.questId, target.remove, target.requestId],
    ),
  );
  const row = rows[0];
  return { removed: row?.removed ?? 0, total: whole(row?.total) };
}

export type ImpactDone = Readonly<{ kind: "done"; value: PointsImpact }> | LiveEditRefusal;

/** The impact of new points on the quest's past completions, as the caller reads it (read only). */
export async function readImpact(
  deps: Readonly<{ pool: Pool }>,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; questId: string; points: number }>,
): Promise<ImpactDone> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const row = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<Record<string, unknown>>(
          "SELECT * FROM quest_points_impact($1, $2, $3)",
          [target.eventId, target.questId, target.points],
        );
        return rows[0] ?? {};
      }),
    );
    return {
      kind: "done",
      value: {
        eligible: row["eligible"] === true,
        completions: whole(row["completions"]),
        players: whole(row["players"]),
        raise: whole(row["raise"]),
        lower: whole(row["lower"]),
        clamped: whole(row["clamped"]),
        prizesHanded: whole(row["prizes_handed"]),
      },
    };
  } catch (error) {
    const pg = error as { code?: string };
    if (pg.code === "AN404") {
      return { kind: "not_found" };
    }
    const refusal = liveEditRefusal(pg);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}
