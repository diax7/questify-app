import type { Caller } from "#src/auth/sign-in";
import { withRolledBackContext } from "#src/db/context";
import {
  REFUSALS,
  subjectOf,
  type RedReason,
  type ScanDeps,
  type ScannedPlayer,
} from "#src/operators/scan";
import { verifyMyCode } from "#src/quests/qr";

/** No ranking, no idempotency store: a practice scan cannot move a place or keep a key (ADR-249, the route wall). */
export type PracticeDeps = Pick<ScanDeps, "pool" | "myKey">;

export type PracticeRequest = Readonly<{ operatorId: string; questId: string; code: string }>;

/** A practice scan's red reasons: the real scan's, and `going_live` while the event's go-live wipe is owed. */
export type PracticeReason = RedReason | "going_live";

/** What a practice scan shows: the real station's three colours, with nothing paid or stored. */
export type PracticeResult =
  | Readonly<{
      kind: "completed";
      player: ScannedPlayer | null;
      points: number;
      occurrence: number;
    }>
  | Readonly<{ kind: "already_completed"; player: ScannedPlayer | null }>
  | Readonly<{
      kind: "refused";
      reason: PracticeReason;
      detail?: string;
      player: ScannedPlayer | null;
    }>
  | Readonly<{ kind: "not_operator" }>;

type Row = {
  outcome: "completed" | "refused";
  points: string | null;
  occurrence: number | null;
  refusal: string | null;
  refusal_detail: string | null;
};

type Judged =
  | Readonly<{ kind: "completed"; points: number; occurrence: number }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "refused"; reason: PracticeReason; detail?: string }>
  | Readonly<{ kind: "not_operator" }>;

/**
 * The database's answer as the station shows it. A code the real scan's table does not know (a deadlock, a
 * serialization failure, a bug), or a key clash a fresh key cannot cause, is thrown: a 500, never a red result.
 */
function judged(row: Row): Judged {
  if (row.outcome === "completed") {
    return { kind: "completed", points: Number(row.points), occurrence: Number(row.occurrence) };
  }
  if (row.refusal === "PW409") {
    return { kind: "refused", reason: "going_live" };
  }
  const refusal = REFUSALS[row.refusal ?? ""]?.(row.refusal_detail ?? undefined);
  if (refusal === undefined || refusal.kind === "key_reused" || refusal.kind === "completed") {
    throw new Error(`The practice scan was refused with an unexpected SQLSTATE ${row.refusal}.`);
  }
  return refusal;
}

/**
 * A practice scan (FR-929): the real door runs and the database undoes it (`operator_practice_scan`), in a
 * transaction the API always rolls back, so the operator sees the real green, orange or red and nothing is saved.
 * Logged without the player or the code.
 */
export async function practiceScan(
  deps: PracticeDeps,
  request: PracticeRequest,
  caller: Caller,
): Promise<PracticeResult> {
  const opened = verifyMyCode(deps.myKey, request.code);
  if (opened.kind !== "valid") {
    caller.log("operator.practice_scan", {
      questId: request.questId,
      result: "refused",
      reason: "invalid_code",
    });
    return { kind: "refused", reason: "invalid_code", player: null };
  }
  const { answer, player } = await withRolledBackContext(
    deps.pool,
    { playerId: request.operatorId },
    async (client) => {
      const { rows } = await client.query<Row>(
        "SELECT outcome, points, occurrence, refusal, refusal_detail FROM operator_practice_scan($1, $2, $3)",
        [request.questId, opened.playerId, opened.version],
      );
      const found = judged(rows[0] as Row);
      return { answer: found, player: await subjectOf(client, request.questId, opened.playerId) };
    },
  );
  caller.log("operator.practice_scan", {
    questId: request.questId,
    result: answer.kind,
    ...(answer.kind === "refused" ? { reason: answer.reason } : {}),
  });
  return answer.kind === "not_operator" ? answer : { ...answer, player };
}
