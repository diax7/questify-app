import type { ProfileItem } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { normalizeEntryCode } from "@questify/shared";
import type { AuthKeys } from "#src/auth/keys";
import { COMPLETION_LIMITS } from "#src/auth/limits";
import type { Caller } from "#src/auth/sign-in";
import { BUCKETS, countRecent, forget, record, tryLock, type Bucket } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { firstBonusPaid, type OwnFirstBonus } from "#src/quests/first-bonus";
import {
  verifyQuestCode,
  verifyScreenCode,
  type QuestCodeKey,
  type ScreenCodeKey,
} from "#src/quests/qr";
import type { SettingsService } from "#src/settings/service";

export type Proof =
  | Readonly<{ type: "qr"; code: string }>
  | Readonly<{ type: "code"; code: string }>
  | Readonly<{ type: "location" }>
  /** The code a station or an operator's phone shows (T-309, FR-314): the quest id and a 30-second window. */
  | Readonly<{ type: "screen"; code: string }>;

/**
 * The phone's reading (T-303b, ADR-206): every value is client-reported. It reaches the database only as an argument,
 * which keeps rounded distances and never the point.
 */
export type Position = Readonly<{
  lat: number;
  lng: number;
  accuracyM: number;
  ageS: number;
  mocked?: boolean | undefined;
}>;

export type CompletionRequest = Readonly<{
  playerId: string;
  questId: string;
  proof: Proof;
  /** A well-formed reading, or null: a bad one on a QR or code scan was dropped before this (never a refusal). */
  position: Position | null;
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
  /** The Questify level this completion reached for the first time (T-401), or null; the same on a replay. */
  levelUp: LevelUp | null;
  /** The category bonus this completion paid (T-304), or null; the same on a replay. */
  bonus: Bonus | null;
  /** The quest item this completion gave or missed (T-304d), or null; the same on a replay. */
  item: ItemGiven | null;
  /** The boost that doubled this completion (T-307), or null; the same on a replay. */
  boost: Boosted | null;
  /** The first-N bonus this completion earned, or missed when `place` is null (T-313); the same on a replay. */
  firstBonus: OwnFirstBonus | null;
}>;

/** A boost a payment was made with (T-307, ADR-233): `points` already holds the multiplied amount. */
export type Boosted = Readonly<{ multiplier: number }>;

export type LevelUp = Readonly<{
  level: number;
  title: Readonly<{ ar: string; en: string }>;
  items: readonly ProfileItem[];
}>;

/**
 * A quest item a payment gave (FR-522) or missed (FR-1617): `pending` waits at the prize desk; `out_of_stock` and
 * `claim_closed` paid the points only (T-304d, ADR-205).
 */
export type ItemGiven = Readonly<{
  name: Readonly<{ ar: string | null; en: string | null }>;
  outcome: ItemOutcome;
  /** A pending item's claim deadline, with the event's zone to say it in (it may be the desk's closing soon); else null. */
  until: Readonly<{ at: string; timeZone: string }> | null;
}>;

export type ItemOutcome = "pending" | "out_of_stock" | "claim_closed";

/**
 * A category's completion bonus, paid with the completion that finished the category (FR-231, ADR-202): its points
 * (0 for an item-only bonus) and its quest item (T-304d), or null.
 */
export type Bonus = Readonly<{
  categoryId: string;
  points: number;
  category: Readonly<{ ar: string | null; en: string | null }>;
  item: ItemGiven | null;
}>;

type BonusRow = {
  category_id: string;
  points: string;
  name_ar: string | null;
  name_en: string | null;
  item_ar: string | null;
  item_en: string | null;
  item_outcome: ItemOutcome | null;
  item_until: Date | null;
  item_time_zone: string | null;
};

type ItemFields = Readonly<{
  ar: string | null;
  en: string | null;
  outcome: ItemOutcome | null;
  until: Date | null | undefined;
  timeZone: string | null | undefined;
}>;

const itemOf = (row: ItemFields): ItemGiven | null =>
  row.outcome === null
    ? null
    : {
        name: { ar: row.ar, en: row.en },
        outcome: row.outcome,
        until:
          row.until instanceof Date && typeof row.timeZone === "string"
            ? { at: row.until.toISOString(), timeZone: row.timeZone }
            : null,
      };

const bonusOf = (rows: readonly BonusRow[]): Bonus | null => {
  const row = rows[0];
  return row === undefined
    ? null
    : {
        categoryId: row.category_id,
        points: Number(row.points),
        category: { ar: row.name_ar, en: row.name_en },
        item: itemOf({
          ar: row.item_ar,
          en: row.item_en,
          outcome: row.item_outcome ?? null,
          until: row.item_until,
          timeZone: row.item_time_zone,
        }),
      };
};

/** The quest item this completion gave or missed, for the calling player (own_quest_item, migration 0047). */
export async function itemGiven(
  client: PoolClient,
  completionId: string,
): Promise<ItemGiven | null> {
  const { rows } = await client.query<{
    name_ar: string | null;
    name_en: string | null;
    outcome: ItemOutcome;
    until: Date | null;
    time_zone: string;
  }>("SELECT name_ar, name_en, outcome, until, time_zone FROM own_quest_item($1)", [completionId]);
  const row = rows[0];
  return row === undefined
    ? null
    : itemOf({
        ar: row.name_ar,
        en: row.name_en,
        outcome: row.outcome,
        until: row.until,
        timeZone: row.time_zone,
      });
}

/** The boost this completion was paid with, for the calling player (completion_boost, migration 0055), or null. */
export async function boostApplied(
  client: PoolClient,
  completionId: string,
): Promise<Boosted | null> {
  const { rows } = await client.query<{ multiplier: number | null }>(
    "SELECT completion_boost($1) AS multiplier",
    [completionId],
  );
  const multiplier = rows[0]?.multiplier ?? null;
  return multiplier === null ? null : { multiplier };
}

/** The bonus this completion paid, for the calling player (own_bonus, migration 0044). */
export async function bonusPaid(client: PoolClient, completionId: string): Promise<Bonus | null> {
  const { rows } = await client.query<BonusRow>("SELECT * FROM own_bonus($1)", [completionId]);
  return bonusOf(rows);
}

/** The bonus the calling player's quiz on this quest paid, also when it finished with no right answers. */
export async function quizBonus(client: PoolClient, questId: string): Promise<Bonus | null> {
  const { rows } = await client.query<BonusRow>("SELECT * FROM own_category_bonus($1)", [questId]);
  return bonusOf(rows);
}

/** Why a code was refused: one answer to the player, told apart in the log. */
export type CodeProblem =
  | "not_questify"
  | "forged"
  | "wrong_quest"
  | "old"
  | "wrong_code"
  | "wrong_method"
  /** A screen code more than 15 seconds past its change (T-309): the app asks to scan the screen again. */
  | "expired";

/** Why a check-in was refused (migration 0048's check_in_check). */
export type LocationProblem = "no_position" | "bad_position" | "stale" | "imprecise" | "not_here";

const LOCATION_PROBLEMS: ReadonlySet<string> = new Set([
  "no_position",
  "bad_position",
  "stale",
  "imprecise",
  "not_here",
]);

export type CompletionResult =
  | Readonly<{ kind: "completed"; value: Completed }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "quest_not_open"; reason: string }>
  | Readonly<{ kind: "already_completed"; cap: number }>
  | Readonly<{ kind: "invalid_code"; problem: CodeProblem }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "too_many_attempts"; retryAfterSeconds: number }>
  | Readonly<{ kind: "location_refused"; reason: LocationProblem; distanceM: number | null }>
  /** The platform's `locationQuests` switch is off (ADR-208): a check-in is refused; the QR still works. */
  | Readonly<{ kind: "feature_off" }>;

export type CompletionDeps = Readonly<{
  pool: Pool;
  codeKey: QuestCodeKey;
  screenKey: ScreenCodeKey;
  keys: AuthKeys;
  settings: Pick<SettingsService, "forEvent">;
}>;

/** A QV422 refusal: a check-in's location reason (with the player's own rounded distance), else a code problem. */
function proofRefusal(detail: string, hint: string): CompletionResult {
  if (LOCATION_PROBLEMS.has(detail)) {
    const distance = Number.parseInt(hint, 10);
    return {
      kind: "location_refused",
      reason: detail as LocationProblem,
      distanceM: Number.isFinite(distance) ? distance : null,
    };
  }
  return { kind: "invalid_code", problem: detail as CodeProblem };
}

/** The SQLSTATEs of `complete_quest` (migrations 0012, 0048). */
const REFUSALS: Readonly<Record<string, (detail: string, hint: string) => CompletionResult>> = {
  QC404: () => ({ kind: "not_found" }),
  QC403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  // An operator the owner has not allowed to play (migration 0026).
  QP403: () => ({ kind: "enrollment_inactive", reason: "operator_not_playing" }),
  QN403: (detail) => ({ kind: "quest_not_open", reason: detail }),
  QD409: (detail) => ({ kind: "already_completed", cap: Number(detail) }),
  QV422: proofRefusal,
  QK422: () => ({ kind: "key_reused" }),
};

type Reservation = ReadonlyArray<Readonly<{ bucket: Bucket; key: Buffer; at: string }>>;

type Limit = Readonly<{ bucket: Bucket; key: Buffer; max: number; windowSeconds: number }>;

/**
 * The counts an attempt is held against: a typed code's three (FR-322), or a check-in's own one per player and quest
 * (T-303b), which never touches the wrong-code buckets.
 */
function limitsFor(deps: CompletionDeps, request: CompletionRequest): readonly Limit[] {
  const { wrongCodesPerPlayerQuest, wrongCodesPerPlayer, wrongCodesPerDevice } = COMPLETION_LIMITS;
  if (request.proof.type === "location") {
    return [
      {
        bucket: BUCKETS.checkInPlayerQuest,
        key: deps.keys.playerQuestKey(request.playerId, request.questId),
        ...COMPLETION_LIMITS.refusedCheckInsPerPlayerQuest,
      },
    ];
  }
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
 * Counts this typed code (or check-in) as a refused one before it is checked, in its own short transaction under a lock
 * on the player, so a burst of parallel attempts cannot slip past the count and a refusal's rollback cannot erase it. A
 * right code (or a check-in that was not refused for its position) gives the reservation back afterwards.
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

type EngineProof = Readonly<{
  method: "qr" | "code" | "location" | "screen_qr";
  version: number | null;
  typed: string | null;
}>;

async function callEngine(
  client: PoolClient,
  request: CompletionRequest,
  proof: EngineProof,
): Promise<CompletionResult> {
  try {
    const { rows } = await client.query<Row>(
      "SELECT * FROM complete_quest($1, $2, $3, $4, $5, $6, $7)",
      [
        request.questId,
        proof.method,
        proof.version,
        proof.typed,
        request.idempotencyKey,
        request.deviceId ?? null,
        request.position,
      ],
    );
    const row = rows[0] as Row;
    const levelUp = await levelReached(client, row.completion_id);
    const bonus = await bonusPaid(client, row.completion_id);
    const item = await itemGiven(client, row.completion_id);
    const boost = await boostApplied(client, row.completion_id);
    const firstBonus = await firstBonusPaid(client, row.completion_id);
    return {
      kind: "completed",
      value: {
        completionId: row.completion_id,
        points: Number(row.points),
        occurrence: row.occurrence,
        score: Number(row.score),
        balance: Number(row.balance),
        replayed: row.replayed,
        levelUp,
        bonus,
        item,
        boost,
        firstBonus,
      },
    };
  } catch (error) {
    const pg = error as { code?: string; detail?: string; hint?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    if (refusal === undefined) {
      throw error;
    }
    return refusal(pg.detail ?? "", pg.hint ?? "");
  }
}

/** The level this completion's XP credit reached first, with its title (own_level, migration 0039). */
export async function levelReached(
  client: PoolClient,
  completionId: string,
): Promise<LevelUp | null> {
  const { rows } = await client.query<{
    level_up: number | null;
    up_title_ar: string;
    up_title_en: string;
  }>("SELECT level_up, up_title_ar, up_title_en FROM own_level($1)", [completionId]);
  const row = rows[0];
  if (row === undefined || row.level_up === null) {
    return null;
  }
  const granted = await client.query<{ items: ProfileItem[] }>(
    "SELECT own_level_items($1) AS items",
    [completionId],
  );
  return {
    level: row.level_up,
    title: { ar: row.up_title_ar, en: row.up_title_en },
    items: granted.rows[0]?.items ?? [],
  };
}

/** Whether the platform's `locationQuests` switch is on (ADR-208); off unless a Questify admin switched it on. */
export async function locationQuestsOn(
  settings: Pick<SettingsService, "forEvent">,
): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["locationQuests"]?.enabled === true;
}

/** Whether a refusal keeps the attempt counted: a wrong typed code, or a check-in refused for its position. */
const countsAsRefused = (result: CompletionResult): boolean =>
  (result.kind === "invalid_code" && result.problem === "wrong_code") ||
  result.kind === "location_refused";

type Prepared =
  | Readonly<{ kind: "ready"; proof: EngineProof; reservation: Reservation | undefined }>
  | Readonly<{ kind: "refused"; result: CompletionResult }>;

/** Opens a screen code for this quest: its window goes to the door, which judges it with the database clock. */
function screenProof(deps: CompletionDeps, request: CompletionRequest, code: string): Prepared {
  const check = verifyScreenCode(deps.screenKey, code, request.questId);
  return check.kind === "valid"
    ? {
        kind: "ready",
        proof: { method: "screen_qr", version: check.window, typed: null },
        reservation: undefined,
      }
    : { kind: "refused", result: { kind: "invalid_code", problem: check.kind } };
}

/**
 * Checks a QR's or a screen code's signature, or holds a typed code or a check-in against its limits, before the
 * database is asked.
 */
async function prepare(deps: CompletionDeps, request: CompletionRequest): Promise<Prepared> {
  if (request.proof.type === "screen") {
    return screenProof(deps, request, request.proof.code);
  }
  if (request.proof.type === "qr") {
    const check = verifyQuestCode(deps.codeKey, request.proof.code, request.questId);
    return check.kind === "valid"
      ? {
          kind: "ready",
          proof: { method: "qr", version: check.version, typed: null },
          reservation: undefined,
        }
      : { kind: "refused", result: { kind: "invalid_code", problem: check.kind } };
  }
  const held = await reserve(deps, request);
  if (!Array.isArray(held)) {
    return {
      kind: "refused",
      result: { kind: "too_many_attempts", ...(held as { retryAfterSeconds: number }) },
    };
  }
  const typed = request.proof.type === "code" ? normalizeEntryCode(request.proof.code) : null;
  return {
    kind: "ready",
    proof: { method: request.proof.type, version: null, typed },
    reservation: held as Reservation,
  };
}

/**
 * Completes a quest for the player of the request (FR-201, 202, 211, 215, 216, 302, 304, 316, 401, 402): the API checks
 * the QR's signature and holds a typed code or a check-in against its limits; `complete_quest` checks every other rule
 * (a check-in's position among them, migration 0048) and writes the completion, the ledger entry, the score and balance
 * in one transaction. While the platform's location switch is off a check-in is refused and no reading is passed on.
 */
export async function completeQuest(
  deps: CompletionDeps,
  request: CompletionRequest,
  caller: Caller,
): Promise<CompletionResult> {
  const on =
    request.position === null && request.proof.type !== "location"
      ? false
      : await locationQuestsOn(deps.settings);
  if (request.proof.type === "location" && !on) {
    return refused(caller, request, { kind: "feature_off" });
  }
  const asked: CompletionRequest = on ? request : { ...request, position: null };
  const prepared = await prepare(deps, asked);
  if (prepared.kind === "refused") {
    return refused(caller, asked, prepared.result);
  }
  const { proof, reservation } = prepared;
  let result: CompletionResult;
  try {
    result = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: asked.playerId }, () =>
        callEngine(client, asked, proof),
      ),
    );
  } catch (error) {
    // A busy or broken database is no wrong guess: give the attempt back, so retrying a right code is never locked out.
    if (reservation !== undefined) {
      await release(deps, reservation, caller);
    }
    throw error;
  }
  if (reservation !== undefined && !countsAsRefused(result)) {
    await release(deps, reservation, caller);
  }
  if (result.kind === "completed") {
    caller.log("quest.completed", {
      questId: asked.questId,
      points: result.value.points,
      replayed: String(result.value.replayed),
    });
    return result;
  }
  return refused(caller, asked, result);
}

/** The reason a refusal is logged with: the code problem, the location reason, the status reason, or its kind. */
function reasonOf(result: CompletionResult): string {
  switch (result.kind) {
    case "invalid_code":
      return result.problem;
    case "location_refused":
    case "quest_not_open":
    case "enrollment_inactive":
      return result.reason;
    default:
      return result.kind;
  }
}

/**
 * Logs a refusal with its reason (a spike of forged codes is worth a look, RUNBOOK); never the token, the code, the
 * position or a distance.
 */
function refused(
  caller: Caller,
  request: CompletionRequest,
  result: CompletionResult,
): CompletionResult {
  caller.log("quest.refused", {
    questId: request.questId,
    refusal: result.kind,
    reason: reasonOf(result),
  });
  return result;
}
