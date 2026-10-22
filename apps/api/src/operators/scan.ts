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

type Refusal =
  | Readonly<{ kind: "refused"; reason: RedReason; detail?: string }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "key_reused" }>;

/** The SQLSTATEs of operator_complete_quest and record_completion (migration 0026). */
const REFUSALS: Readonly<Record<string, (detail: string) => Refusal>> = {
  OP403: () => ({ kind: "not_operator" }),
  OQ404: () => ({ kind: "refused", reason: "quest_not_found" }),
  OA403: () => ({ kind: "refused", reason: "ability_off" }),
  OS403: () => ({ kind: "refused", reason: "outside_station" }),
  OY409: () => ({ kind: "refused", reason: "self_scan" }),
  OM422: () => ({ kind: "refused", reason: "old_code" }),
  QC404: () => ({ kind: "refused", reason: "not_in_event" }),
  QC403: (detail) => ({ kind: "refused", reason: "enrollment_inactive", detail }),
  QN403: (detail) => ({ kind: "refused", reason: "quest_not_open", detail }),
  QV422: () => ({ kind: "refused", reason: "wrong_method" }),
  QP403: () => ({ kind: "refused", reason: "operator_not_playing" }),
  QD409: () => ({ kind: "already_completed" }),
  QK422: () => ({ kind: "key_reused" }),
};

/** Reasons that must not name the person: they are not this event's player, or the code named nobody. */
const NAMELESS: ReadonlySet<RedReason> = new Set([
  "invalid_code",
  "not_in_event",
  "quest_not_found",
]);

type Row = { completion_id: string; points: string; occurrence: number; replayed: boolean };

async function complete(
  client: PoolClient,
  request: ScanRequest,
  scanned: Readonly<{ playerId: string; version: number }>,
): Promise<Row | Refusal> {
  // A refusal raises; the savepoint keeps the transaction usable for reading who was scanned.
  await client.query("SAVEPOINT scan");
  try {
    const { rows } = await client.query<Row>(
      "SELECT completion_id, points, occurrence, replayed FROM operator_complete_quest($1, $2, $3, $4)",
      [request.questId, scanned.playerId, scanned.version, request.idempotencyKey],
    );
    return rows[0] as Row;
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    if (refusal === undefined) {
      throw error;
    }
    await client.query("ROLLBACK TO SAVEPOINT scan");
    return refusal(pg.detail ?? "");
  }
}

async function subjectOf(
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
 * transaction. The station then reads who it scanned, unless the scan named nobody it may know.
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
  const outcome = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId: request.operatorId }, async () => {
      const result = await complete(client, request, scanned);
      if ("kind" in result && (result.kind === "not_operator" || result.kind === "key_reused")) {
        return { result, player: null };
      }
      const named = !("kind" in result && result.kind === "refused" && NAMELESS.has(result.reason));
      return {
        result,
        player: named ? await subjectOf(client, request.questId, scanned.playerId) : null,
      };
    }),
  );
  const { result, player } = outcome;
  if (!("kind" in result)) {
    caller.log("operator.scan_completed", {
      questId: request.questId,
      replayed: String(result.replayed),
    });
    return {
      kind: "completed",
      player,
      points: Number(result.points),
      occurrence: result.occurrence,
      replayed: result.replayed,
      completionId: result.completion_id,
      playerId: scanned.playerId,
    };
  }
  if (result.kind === "refused") {
    caller.log("operator.scan_refused", { reason: result.reason, questId: request.questId });
    return { ...result, player };
  }
  if (result.kind === "already_completed") {
    return { kind: "already_completed", player };
  }
  return result;
}
