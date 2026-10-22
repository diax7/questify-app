import type { Pool, PoolClient } from "pg";
import { normalizeEntryCode } from "@questify/shared";
import type { AuthKeys } from "#src/auth/keys";
import { COMPLETION_LIMITS } from "#src/auth/limits";
import type { Caller } from "#src/auth/sign-in";
import { BUCKETS, countRecent, forget, record, tryLock, type Bucket } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { verifyQuestCode, type QuestCodeKey } from "#src/quests/qr";

export type Proof =
  | Readonly<{ type: "qr"; code: string }>
  | Readonly<{ type: "code"; code: string }>;

export type CompletionRequest = Readonly<{
  playerId: string;
  questId: string;
  proof: Proof;
  idempotencyKey: string;
  /** The app's install id when it sent a well-formed one; a claim from an honest client only. */
  deviceId: string | undefined;
}>;

export type Completed = Readonly<{
  completionId: string;
  points: number;
  occurrence: number;
  score: number;
  balance: number;
  replayed: boolean;
}>;

/** Why a code was refused: one answer to the player, told apart in the log. */
export type CodeProblem =
  | "not_questify"
  | "forged"
  | "wrong_quest"
  | "old"
  | "wrong_code"
  | "wrong_method";

export type CompletionResult =
  | Readonly<{ kind: "completed"; value: Completed }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "quest_not_open"; reason: string }>
  | Readonly<{ kind: "already_completed"; cap: number }>
  | Readonly<{ kind: "invalid_code"; problem: CodeProblem }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "too_many_attempts"; retryAfterSeconds: number }>;

export type CompletionDeps = Readonly<{ pool: Pool; codeKey: QuestCodeKey; keys: AuthKeys }>;

/** The SQLSTATEs of `complete_quest` (migration 0012). */
const REFUSALS: Readonly<Record<string, (detail: string) => CompletionResult>> = {
  QC404: () => ({ kind: "not_found" }),
  QC403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  // An operator the owner has not allowed to play (migration 0026).
  QP403: () => ({ kind: "enrollment_inactive", reason: "operator_not_playing" }),
  QN403: (detail) => ({ kind: "quest_not_open", reason: detail }),
  QD409: (detail) => ({ kind: "already_completed", cap: Number(detail) }),
  QV422: (detail) => ({ kind: "invalid_code", problem: detail as CodeProblem }),
  QK422: () => ({ kind: "key_reused" }),
};

type Reservation = ReadonlyArray<Readonly<{ bucket: Bucket; key: Buffer; at: string }>>;

/** The three counts a wrong code is held against (FR-322). */
function limitsFor(deps: CompletionDeps, request: CompletionRequest) {
  const { wrongCodesPerPlayerQuest, wrongCodesPerPlayer, wrongCodesPerDevice } = COMPLETION_LIMITS;
  return [
    {
      bucket: BUCKETS.codePlayerQuest,
      key: deps.keys.playerQuestKey(request.playerId, request.questId),
      ...wrongCodesPerPlayerQuest,
    },
    {
      bucket: BUCKETS.codePlayer,
      key: deps.keys.playerKey(request.playerId),
      ...wrongCodesPerPlayer,
    },
    ...(request.deviceId === undefined
      ? []
      : [
          {
            bucket: BUCKETS.codeDevice,
            key: deps.keys.deviceKey(request.deviceId),
            ...wrongCodesPerDevice,
          },
        ]),
  ] as const;
}

/**
 * A retry whose first answer is held only by the database (another server, a restart) also passes here first, so a
 * player at the limit gets 429 instead of the replay: rare, and the completion itself is already safe.
 *
 * Counts this typed code as a wrong one before it is checked, in its own short transaction under a lock on the player,
 * so a burst of parallel guesses cannot slip past the count and a refusal's rollback cannot erase it. A right code
 * gives the reservation back afterwards.
 */
async function reserve(
  deps: CompletionDeps,
  request: CompletionRequest,
): Promise<Reservation | Readonly<{ retryAfterSeconds: number }>> {
  const limits = limitsFor(deps, request);
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      if (!(await tryLock(client, deps.keys.playerKey(request.playerId)))) {
        return { retryAfterSeconds: 1 };
      }
      for (const limit of limits) {
        const window = await countRecent(client, limit.bucket, limit.key, limit.windowSeconds);
        if (window.count >= limit.max) {
          return { retryAfterSeconds: window.retryAfterSeconds };
        }
      }
      const reservation: { bucket: Bucket; key: Buffer; at: string }[] = [];
      for (const limit of limits) {
        reservation.push({
          bucket: limit.bucket,
          key: limit.key,
          at: await record(client, limit.bucket, limit.key),
        });
      }
      return reservation;
    }),
  );
}

async function release(
  deps: CompletionDeps,
  reservation: Reservation,
  caller: Caller,
): Promise<void> {
  try {
    await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, async () => {
        for (const held of reservation) {
          await forget(client, held.bucket, held.key, held.at);
        }
      }),
    );
    // Stryker disable next-line BlockStatement: best effort after the answer is settled; only a database dropping between two calls reaches it
  } catch (error) {
    // The completion is already settled; one extra counted attempt is the safe way to fail.
    caller.log("quest.code_release_failed", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

type Row = {
  completion_id: string;
  points: string;
  occurrence: number;
  score: string;
  balance: string;
  replayed: boolean;
};

async function callEngine(
  client: PoolClient,
  request: CompletionRequest,
  proof: Readonly<{ method: "qr" | "code"; version: number | null; typed: string | null }>,
): Promise<CompletionResult> {
  try {
    const { rows } = await client.query<Row>(
      "SELECT * FROM complete_quest($1, $2, $3, $4, $5, $6)",
      [
        request.questId,
        proof.method,
        proof.version,
        proof.typed,
        request.idempotencyKey,
        request.deviceId ?? null,
      ],
    );
    const row = rows[0] as Row;
    return {
      kind: "completed",
      value: {
        completionId: row.completion_id,
        points: Number(row.points),
        occurrence: row.occurrence,
        score: Number(row.score),
        balance: Number(row.balance),
        replayed: row.replayed,
      },
    };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    if (refusal === undefined) {
      throw error;
    }
    return refusal(pg.detail ?? "");
  }
}

/**
 * Completes a quest for the player of the request (FR-201, 202, 211, 302, 304, 316, 401, 402): the API checks the QR's
 * signature and holds a typed code against the guessing limits; `complete_quest` checks every other rule and writes
 * the completion, the ledger entry, the score and balance in one transaction (migration 0012).
 */
export async function completeQuest(
  deps: CompletionDeps,
  request: CompletionRequest,
  caller: Caller,
): Promise<CompletionResult> {
  let proof: Readonly<{ method: "qr" | "code"; version: number | null; typed: string | null }>;
  let reservation: Reservation | undefined;
  if (request.proof.type === "qr") {
    const check = verifyQuestCode(deps.codeKey, request.proof.code, request.questId);
    if (check.kind !== "valid") {
      return refused(caller, request, { kind: "invalid_code", problem: check.kind });
    }
    proof = { method: "qr", version: check.version, typed: null };
  } else {
    const held = await reserve(deps, request);
    if (!Array.isArray(held)) {
      return refused(caller, request, {
        kind: "too_many_attempts",
        ...(held as { retryAfterSeconds: number }),
      });
    }
    reservation = held as Reservation;
    proof = { method: "code", version: null, typed: normalizeEntryCode(request.proof.code) };
  }
  let result: CompletionResult;
  try {
    result = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: request.playerId }, () =>
        callEngine(client, request, proof),
      ),
    );
  } catch (error) {
    // A busy or broken database is no wrong guess: give the attempt back, so retrying a right code is never locked out.
    if (reservation !== undefined) {
      await release(deps, reservation, caller);
    }
    throw error;
  }
  if (
    reservation !== undefined &&
    !(result.kind === "invalid_code" && result.problem === "wrong_code")
  ) {
    await release(deps, reservation, caller);
  }
  if (result.kind === "completed") {
    caller.log("quest.completed", {
      questId: request.questId,
      points: result.value.points,
      replayed: String(result.value.replayed),
    });
    return result;
  }
  return refused(caller, request, result);
}

/** Logs a refusal with its reason (a spike of forged codes is worth a look, RUNBOOK); never the token or the code. */
function refused(
  caller: Caller,
  request: CompletionRequest,
  result: CompletionResult,
): CompletionResult {
  const reason =
    result.kind === "invalid_code"
      ? result.problem
      : result.kind === "quest_not_open" || result.kind === "enrollment_inactive"
        ? result.reason
        : result.kind;
  caller.log("quest.refused", { questId: request.questId, refusal: result.kind, reason });
  return result;
}
