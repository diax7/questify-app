import type { PoolClient } from "pg";
import {
  ENGINE_VERSIONS,
  gameTarget,
  isGameName,
  judgeRound,
  lastInputMs,
  type GameName,
  type GameTarget,
  type Judgement,
} from "@questify/shared";
import type { AuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { BUCKETS } from "#src/auth/throttle";
import {
  bonusPaid,
  itemGiven,
  levelReached,
  type Bonus,
  type ItemGiven,
  type LevelUp,
} from "#src/completions/complete";
import { heldBack, type PlayerLimit } from "#src/plays/limits";
import { run, type Done, type PlayDeps } from "#src/plays/run";
import type { SettingsService } from "#src/settings/service";

export type GameDeps = PlayDeps &
  Readonly<{ keys: Pick<AuthKeys, "playerKey">; settings: Pick<SettingsService, "forEvent"> }>;

/** Rounds issued and results sent per player (T-305): far above any honest play, well below a script's. */
export const GAME_LIMITS = {
  roundsPerPlayer: { max: 30, windowSeconds: 600 },
  resultsPerPlayer: { max: 20, windowSeconds: 600 },
} as const;

const ROUND_LIMIT: PlayerLimit = { bucket: BUCKETS.gameRound, ...GAME_LIMITS.roundsPerPlayer };
const RESULT_LIMIT: PlayerLimit = { bucket: BUCKETS.gameResult, ...GAME_LIMITS.resultsPerPlayer };

export type GameOutcome<T> =
  | Done<T>
  | Readonly<{ kind: "too_many_attempts"; retryAfterSeconds: number }>
  /** The app's engine for the game is older than the server's: nothing was issued (ADR-212). */
  | Readonly<{ kind: "update_required" }>
  /** The replay or the clock refused the round: it counted as played, and the reason stays with the organizer. */
  | Readonly<{ kind: "impossible"; attemptsLeft: number | null }>;

/** A round the app plays: everything the board is drawn from, frozen by the database. */
export type IssuedRound = Readonly<{
  roundId: string;
  game: GameName;
  level: string;
  seed: number;
  params: unknown;
  points: number;
  engineVersion: number;
  issuedAt: string;
  deadlineAt: string;
  serverNow: string;
  attemptsLeft: number | null;
  replayed: boolean;
}>;

/** The quest sheet's game state (member_game). */
export type GameView = Readonly<{
  game: GameName;
  level: string;
  params: unknown;
  target: GameTarget;
  attempts: number | null;
  cooldownMinutes: number | null;
  used: number;
  attemptsLeft: number | null;
  passed: boolean;
  done: boolean;
  retryAt: string | null;
  open: Readonly<{ roundId: string; deadlineAt: string }> | null;
  last: Readonly<{ verdict: string; result: unknown }> | null;
  serverNow: string;
}>;

/** A counted result: passed (paid now), done (passed, the quest already completed) or short, with the target. */
export type GameResult = Readonly<{
  verdict: "passed" | "short" | "done";
  result: unknown;
  target: GameTarget;
  attemptsLeft: number | null;
  completionId: string | null;
  points: number;
  score: number;
  balance: number;
  replayed: boolean;
  levelUp: LevelUp | null;
  bonus: Bonus | null;
  item: ItemGiven | null;
}>;

/** Whether the platform's `miniGames` switch is on; the event's own switch is the database's (`games_on`). */
export async function gamesPlatformOn(
  settings: Pick<SettingsService, "forEvent">,
): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["miniGames"]?.enabled !== false;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

type ViewRow = Readonly<{
  game: string;
  level: string;
  params: unknown;
  attempts: number | null;
  cooldown_minutes: number | null;
  used: number;
  attempts_left: number | null;
  passed: boolean;
  done: boolean;
  retry_at: Date | null;
  open_round: string | null;
  open_deadline: Date | null;
  last_verdict: string | null;
  last_result: unknown;
  server_now: Date;
}>;

const gameOf = (value: string): GameName => {
  if (!isGameName(value)) {
    throw new Error(`The database named a game this build cannot play: ${value}`);
  }
  return value;
};

function viewOf(row: ViewRow): GameView {
  const game = gameOf(row.game);
  return {
    game,
    level: row.level,
    params: row.params,
    target: gameTarget(game, row.params),
    attempts: row.attempts,
    cooldownMinutes: row.cooldown_minutes,
    used: row.used,
    attemptsLeft: row.attempts_left,
    passed: row.passed,
    done: row.done,
    retryAt: iso(row.retry_at),
    open:
      row.open_round === null || row.open_deadline === null
        ? null
        : { roundId: row.open_round, deadlineAt: row.open_deadline.toISOString() },
    last: row.last_verdict === null ? null : { verdict: row.last_verdict, result: row.last_result },
    serverNow: row.server_now.toISOString(),
  };
}

/** The player's game quest for its sheet; not found unless they are a member of its event. */
export function readGame(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<GameView>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<ViewRow>("SELECT * FROM member_game($1)", [questId]);
    return viewOf(rows[0] as ViewRow);
  });
}

type RoundRow = Readonly<{
  round_id: string;
  game: string;
  level: string;
  seed: number;
  params: unknown;
  points: number;
  engine_version: number;
  issued_at: Date;
  deadline_at: Date;
  server_now: Date;
  attempts_left: number | null;
  replayed: boolean;
}>;

const issuedOf = (row: RoundRow): IssuedRound => ({
  roundId: row.round_id,
  game: gameOf(row.game),
  level: row.level,
  seed: row.seed,
  params: row.params,
  points: row.points,
  engineVersion: row.engine_version,
  issuedAt: row.issued_at.toISOString(),
  deadlineAt: row.deadline_at.toISOString(),
  serverNow: row.server_now.toISOString(),
  attemptsLeft: row.attempts_left,
  replayed: row.replayed,
});

export type StartRequest = Readonly<{
  playerId: string;
  questId: string;
  idempotencyKey: string;
  deviceId: string | undefined;
  /** The engine version the app carries for each game; a game it does not name is version 0. */
  engineVersions: Readonly<Record<string, number>>;
}>;

/** Issues the round, or answers that the app must update first; the engine check runs before an attempt is used. */
async function issue(
  client: PoolClient,
  request: StartRequest,
): Promise<IssuedRound | "update_required"> {
  const { rows: named } = await client.query<{ game: string }>("SELECT game FROM member_game($1)", [
    request.questId,
  ]);
  const game = gameOf(named[0]?.game ?? "");
  const server = ENGINE_VERSIONS[game];
  if ((request.engineVersions[game] ?? 0) < server) {
    return "update_required";
  }
  const { rows } = await client.query<RoundRow>("SELECT * FROM start_game_round($1, $2, $3, $4)", [
    request.questId,
    request.idempotencyKey,
    request.deviceId ?? null,
    server,
  ]);
  return issuedOf(rows[0] as RoundRow);
}

/**
 * Starts a round of a game quest (ADR-212, ADR-213): refused while the platform's switch is off, past the per-player
 * limit, for an app whose engine is too old (426, no attempt used), or as `start_game_round` refuses.
 */
export async function startRound(
  deps: GameDeps,
  request: StartRequest,
): Promise<GameOutcome<IssuedRound>> {
  if (!(await gamesPlatformOn(deps.settings))) {
    return { kind: "feature_off" };
  }
  const wait = await heldBack(deps, request.playerId, ROUND_LIMIT, true);
  if (wait !== undefined) {
    return { kind: "too_many_attempts", retryAfterSeconds: wait };
  }
  const issued = await run(deps, { playerId: request.playerId }, (client) =>
    issue(client, request),
  );
  if (issued.kind === "done" && issued.value === "update_required") {
    return { kind: "update_required" };
  }
  return issued as Done<IssuedRound>;
}

type ReplayRow = Readonly<{ game: string; seed: number; params: unknown; engine_version: number }>;

type FinishRow = Readonly<{
  verdict: "passed" | "short" | "refused" | "done";
  completion_id: string | null;
  points: string | null;
  score: string;
  balance: string;
  attempts_left: number | null;
  replayed: boolean;
  result: unknown;
}>;

export type ResultRequest = Readonly<{
  playerId: string;
  roundId: string;
  idempotencyKey: string;
  inputs: unknown;
  claimed: unknown;
}>;

/** The verdict as finish_game_round takes it: a refusal carries its reason and no result. */
function verdictArgs(judgement: Judgement): [string, string | null, string | null, boolean] {
  return judgement.verdict === "refused"
    ? ["refused", null, judgement.reason, false]
    : [judgement.verdict, JSON.stringify(judgement.result), null, judgement.unlikely];
}

/** The longest last-input time the database's integer takes; anything longer fails the clock check anyway. */
const MAX_INPUT_MS = 2_147_483_647;

async function finishOf(
  client: PoolClient,
  request: ResultRequest,
  judgement: Judgement,
  target: GameTarget,
): Promise<GameResult | Readonly<{ impossible: number | null }>> {
  const [verdict, result, reason, unlikely] = verdictArgs(judgement);
  const { rows } = await client.query<FinishRow>(
    "SELECT * FROM finish_game_round($1, $2, $3, $4, $5, $6, $7)",
    [
      request.roundId,
      request.idempotencyKey,
      verdict,
      result,
      reason,
      unlikely,
      Math.min(lastInputMs(request.inputs), MAX_INPUT_MS),
    ],
  );
  const row = rows[0] as FinishRow;
  if (row.verdict === "refused") {
    return { impossible: row.attempts_left };
  }
  const paid = row.completion_id;
  return {
    verdict: row.verdict,
    result: row.result,
    target,
    attemptsLeft: row.attempts_left,
    completionId: paid,
    points: Number(row.points ?? 0),
    score: Number(row.score),
    balance: Number(row.balance),
    replayed: row.replayed,
    levelUp: paid === null ? null : await levelReached(client, paid),
    bonus: paid === null ? null : await bonusPaid(client, paid),
    item: paid === null ? null : await itemGiven(client, paid),
  };
}

/**
 * Takes a round's result (ADR-212): reads the frozen round (the caller's own, else not found), replays the phone's
 * inputs on the server with the round's engine version outside any transaction, then hands the verdict to
 * `finish_game_round`, which checks the clock and the window and pays a first pass. A phone's claimed result alone
 * never pays: it only has to match the replay. The refusal's reason is logged for the organizer's trail, never answered.
 */
export async function sendResult(
  deps: GameDeps,
  request: ResultRequest,
  caller: Caller,
): Promise<GameOutcome<GameResult>> {
  const wait = await heldBack(deps, request.playerId, RESULT_LIMIT, true);
  if (wait !== undefined) {
    return { kind: "too_many_attempts", retryAfterSeconds: wait };
  }
  const read = await run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<ReplayRow>("SELECT * FROM game_round_for_replay($1)", [
      request.roundId,
    ]);
    return rows[0];
  });
  if (read.kind !== "done") {
    return read;
  }
  if (read.value === undefined) {
    return { kind: "not_found" };
  }
  const round = read.value;
  const game = gameOf(round.game);
  const judgement = judgeRound(game, round.engine_version, round, request);
  const target = gameTarget(game, round.params);
  const finished = await run(deps, { playerId: request.playerId }, (client) =>
    finishOf(client, request, judgement, target),
  );
  caller.log("game.result", {
    game,
    verdict: finished.kind === "done" ? judgement.verdict : finished.kind,
    reason: judgement.verdict === "refused" ? judgement.reason : "",
  });
  if (finished.kind === "done" && "impossible" in finished.value) {
    return { kind: "impossible", attemptsLeft: finished.value.impossible };
  }
  return finished as Done<GameResult>;
}

/** Rounds closed per tick at most; the next tick takes the rest. */
const SWEEP_BATCH = 50;

/**
 * Closes the rounds left open past their window (ADR-213), one per transaction, as the system; a closed last attempt
 * may pay its category bonus. Answers how many it closed.
 */
export async function closeDueRounds(deps: PlayDeps): Promise<number> {
  let closed = 0;
  for (let i = 0; i < SWEEP_BATCH; i += 1) {
    const outcome = await run(deps, {}, async (client) => {
      const { rows } = await client.query<{ outcome: string | null }>(
        "SELECT close_one_due_round() AS outcome",
      );
      return rows[0]?.outcome ?? null;
    });
    if (outcome.kind !== "done" || outcome.value === null) {
      break;
    }
    closed += 1;
  }
  return closed;
}
