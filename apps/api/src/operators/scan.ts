import type { Pool, PoolClient } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { verifyMyCode, type MyCodeKey } from "#src/quests/qr";

export type ScanDeps = Readonly<{ pool: Pool; myKey: MyCodeKey }>;

export type ScanRequest = Readonly<{
  operatorId: string;
  questId: string;
  /** The scanned My QR token. */
  code: string;
  idempotencyKey: string;
}>;

/** Why the station shows red (FR-924). */
export type RedReason =
  | "invalid_code"
  | "old_code"
  | "not_in_event"
  | "enrollment_inactive"
  | "quest_not_open"
  | "quest_not_found"
  | "ability_off"
  | "outside_station"
  | "self_scan"
  | "operator_not_playing"
  | "wrong_method";

export type ScannedPlayer = Readonly<{ username: string; avatar: string }>;

/**
 * What the station shows: green with the points, orange (already completed, nothing paid) or red with a reason. The
 * operator never sees the player's score or balance. `not_operator` (removed, FR-905) and `key_reused` are answered as
 * errors, not as a scan result.
 */
export type ScanResult =
  | Readonly<{
      kind: "completed";
      player: ScannedPlayer | null;
      points: number;
      occurrence: number;
      replayed: boolean;
      /** For the ranking update after the commit; never sent to the station. */
      completionId: string;
      playerId: string;
    }>
  | Readonly<{ kind: "already_completed"; player: ScannedPlayer | null }>
  | Readonly<{ kind: "refused"; reason: RedReason; detail?: string; player: ScannedPlayer | null }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "key_reused" }>;

export type Judged =
  | Readonly<{ kind: "completed"; row: Row }>
  | Readonly<{ kind: "refused"; reason: RedReason; detail?: string }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "key_reused" }>;

type Row = { completion_id: string; points: string; occurrence: number; replayed: boolean };

const refused = (reason: RedReason, detail?: string): Judged =>
  detail === undefined ? { kind: "refused", reason } : { kind: "refused", reason, detail };

/** The SQLSTATEs of operator_complete_quest and record_completion (migration 0026); the practice scan maps them too. */
export const REFUSALS: Readonly<Record<string, (detail: string | undefined) => Judged>> = {
  OP403: () => ({ kind: "not_operator" }),
  OQ404: () => refused("quest_not_found"),
  OA403: () => refused("ability_off"),
  OS403: () => refused("outside_station"),
  OY409: () => refused("self_scan"),
  OM422: () => refused("old_code"),
  QC404: () => refused("not_in_event"),
  QC403: (detail) => refused("enrollment_inactive", detail),
  QN403: (detail) => refused("quest_not_open", detail),
  QV422: () => refused("wrong_method"),
  QP403: () => refused("operator_not_playing"),
  QD409: () => ({ kind: "already_completed" }),
  QK422: () => ({ kind: "key_reused" }),
};

async function judge(
  client: PoolClient,
  request: ScanRequest,
  scanned: Readonly<{ playerId: string; version: number }>,
): Promise<Judged> {
  // A refusal raises; the savepoint keeps the transaction usable for reading who was scanned.
  await client.query("SAVEPOINT scan");
  try {
    const { rows } = await client.query<Row>(
      "SELECT completion_id, points, occurrence, replayed FROM operator_complete_quest($1, $2, $3, $4)",
      [request.questId, scanned.playerId, scanned.version, request.idempotencyKey],
    );
    return { kind: "completed", row: rows[0] as Row };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = REFUSALS[pg.code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    await client.query("ROLLBACK TO SAVEPOINT scan");
    return refusal(pg.detail);
  }
}

/**
 * Who the station just scanned. The database names only a player of the quest's event, and only to an operator of
 * that event: someone outside it, an unknown quest or a removed operator get no one.
 */
export async function subjectOf(
  client: PoolClient,
  questId: string,
  playerId: string,
): Promise<ScannedPlayer | null> {
  const { rows } = await client.query<ScannedPlayer>(
    "SELECT username, avatar FROM operator_scan_subject($1, $2)",
    [questId, playerId],
  );
  return rows[0] ?? null;
}

/**
 * The station scan (FR-923, FR-924): the API opens the My QR; `operator_complete_quest` checks the operator, their
 * ability and quest limit, the player's code version and every completion rule, and pays the player in one
 * transaction. The station then reads who it scanned.
 */
export async function operatorScan(
  deps: ScanDeps,
  request: ScanRequest,
  caller: Caller,
): Promise<ScanResult> {
  const opened = verifyMyCode(deps.myKey, request.code);
  if (opened.kind !== "valid") {
    caller.log("operator.scan_refused", { reason: "invalid_code", problem: opened.kind });
    return { kind: "refused", reason: "invalid_code", player: null };
  }
  const scanned = { playerId: opened.playerId, version: opened.version };
  const { judged, player } = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId: request.operatorId }, async () => {
      const result = await judge(client, request, scanned);
      return { judged: result, player: await subjectOf(client, request.questId, scanned.playerId) };
    }),
  );
  switch (judged.kind) {
    case "completed":
      caller.log("operator.scan_completed", {
        questId: request.questId,
        replayed: String(judged.row.replayed),
      });
      return {
        kind: "completed",
        player,
        points: Number(judged.row.points),
        occurrence: judged.row.occurrence,
        replayed: judged.row.replayed,
        completionId: judged.row.completion_id,
        playerId: scanned.playerId,
      };
    case "refused":
      caller.log("operator.scan_refused", { reason: judged.reason, questId: request.questId });
      return { ...judged, player };
    case "already_completed":
      return { kind: "already_completed", player };
    case "not_operator":
    case "key_reused":
      return judged;
  }
}
