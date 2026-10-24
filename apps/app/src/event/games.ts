import {
  ENGINE_VERSIONS,
  gameTarget,
  isGameName,
  type GameName,
  type GameTarget,
} from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import {
  bonusOf,
  boostedOf,
  completionAnswer,
  itemGivenOf,
  type Boosted,
  type Bonus,
  type CompletionAnswer,
  type ItemGiven,
} from "#src/event/quests-api.ts";
import { drawable } from "#src/games/round.ts";
import { levelUpOf, type LevelUp } from "#src/questify/level.ts";
import { firstBonusPaidOf, type FirstBonusPaid } from "#src/event/first-bonus.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The server's clock against the phone's: what to add to `Date.now()` to read the server's time (ADR-213). */
export const clockOffset = (serverNow: string, receivedAt: number): number =>
  Date.parse(serverNow) - receivedAt;

/** A game quest's state for its sheet (`GET /v1/quests/{id}/game`). */
export type GameSheet = Readonly<{
  game: GameName;
  level: string;
  target: GameTarget;
  attempts: number | null;
  used: number;
  attemptsLeft: number | null;
  passed: boolean;
  done: boolean;
  retryAt: string | null;
  /** The server's clock offset when the sheet was read. */
  offsetMs: number;
}>;

/**
 * The sheet, or "update" for a game this build cannot draw: one added after it, or at an engine version it lacks
 * (CTO 3). The sheet then shows the update line and no Play, never "failed", so every build meets later games well.
 */
export function gameSheetOf(body: unknown, receivedAt: number): GameSheet | "update" | undefined {
  if (
    !isRecord(body) ||
    typeof body["game"] !== "string" ||
    typeof body["serverNow"] !== "string"
  ) {
    return undefined;
  }
  const game = body["game"];
  const engineVersion = typeof body["engineVersion"] === "number" ? body["engineVersion"] : 1;
  if (!isGameName(game) || !drawable(game, engineVersion)) {
    return "update";
  }
  return {
    game,
    level: String(body["level"]),
    target: isRecord(body["target"])
      ? (body["target"] as GameTarget)
      : gameTarget(game, body["params"]),
    attempts: numberOrNull(body["attempts"]),
    used: typeof body["used"] === "number" ? body["used"] : 0,
    attemptsLeft: numberOrNull(body["attemptsLeft"]),
    passed: body["passed"] === true,
    done: body["done"] === true,
    retryAt: stringOrNull(body["retryAt"]),
    offsetMs: clockOffset(body["serverNow"], receivedAt),
  };
}

export async function fetchGameSheet(
  session: Pick<Session, "request">,
  questId: string,
  now: () => number = Date.now,
): Promise<GameSheet | "update" | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/quests/${encodeURIComponent(questId)}/game`,
  });
  return answer.kind === "ok" ? gameSheetOf(answer.body, now()) : undefined;
}

/** A round the server issued (ADR-212): everything the board is drawn from, and the window for its result. */
export type IssuedRound = Readonly<{
  questId: string;
  roundId: string;
  game: GameName;
  level: string;
  seed: number;
  params: unknown;
  engineVersion: number;
  deadlineAt: string;
  offsetMs: number;
}>;

/** Why no round was issued: an update first, a game refusal, or a quest refusal in the sheet's words. */
export type RoundAnswer =
  | Readonly<{ kind: "round"; round: IssuedRound }>
  | Readonly<{ kind: "update" }>
  | Readonly<{ kind: "game_refused"; reason: string; retryAt: string | null }>
  | Exclude<CompletionAnswer, { kind: "completed" }>;

export function roundAnswerOf(
  answer: AuthedResult,
  questId: string,
  receivedAt: number,
): RoundAnswer {
  if (answer.kind === "ok") {
    const body = isRecord(answer.body) ? answer.body : {};
    return isGameName(body["game"]) &&
      typeof body["roundId"] === "string" &&
      typeof body["seed"] === "number" &&
      typeof body["engineVersion"] === "number" &&
      typeof body["deadlineAt"] === "string" &&
      typeof body["serverNow"] === "string"
      ? {
          kind: "round",
          round: {
            questId,
            roundId: body["roundId"],
            game: body["game"],
            level: String(body["level"]),
            seed: body["seed"],
            params: body["params"],
            engineVersion: body["engineVersion"],
            deadlineAt: body["deadlineAt"],
            offsetMs: clockOffset(body["serverNow"], receivedAt),
          },
        }
      : { kind: "failed" };
  }
  if (answer.kind === "error" && answer.code === "update_required") {
    return { kind: "update" };
  }
  if (answer.kind === "error" && answer.code === "game_refused") {
    return {
      kind: "game_refused",
      reason: String(answer.details["reason"]),
      retryAt: stringOrNull(answer.details["retryAt"]),
    };
  }
  const parsed = completionAnswer(answer);
  return parsed.kind === "completed" ? { kind: "failed" } : parsed;
}

/** Asks for a round of a game quest (an attempt is used), naming the engine version this build draws each game with. */
export async function startGameRound(
  session: Pick<Session, "request">,
  questId: string,
  key: string,
  now: () => number = Date.now,
): Promise<RoundAnswer> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/quests/${encodeURIComponent(questId)}/game-rounds`,
    body: { engineVersions: ENGINE_VERSIONS },
    headers: { "idempotency-key": key },
  });
  return roundAnswerOf(answer, questId, now());
}

/** What a result's answer says (FR-217, FR-218, FR-1809). */
export type ResultAnswer =
  | Readonly<{
      kind: "passed";
      result: unknown;
      points: number;
      levelUp: LevelUp | null;
      bonus: Bonus | null;
      item: ItemGiven | null;
      boost: Boosted | null;
      /** The first-N bonus it earned, or missed when `place` is null (T-313); null when none. */
      firstBonus: FirstBonusPaid | null;
    }>
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "short"; result: unknown; target: GameTarget; attemptsLeft: number | null }>
  /** The replay refused the round; it counted as played. The reason is never sent. */
  | Readonly<{ kind: "refused" }>
  /** The round's window ended, or it was closed meanwhile: it counted as played. */
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "signed_out" }>;

function sentOf(body: Record<string, unknown>): ResultAnswer {
  switch (body["verdict"]) {
    case "passed":
      return {
        kind: "passed",
        result: body["result"],
        points: typeof body["points"] === "number" ? body["points"] : 0,
        levelUp: levelUpOf(body["levelUp"]),
        bonus: bonusOf(body["bonus"]),
        item: itemGivenOf(body["item"]),
        boost: boostedOf(body["boost"]),
        firstBonus: firstBonusPaidOf(body["firstBonus"]),
      };
    case "done":
      return { kind: "done" };
    case "short":
      return isRecord(body["target"])
        ? {
            kind: "short",
            result: body["result"],
            target: body["target"] as GameTarget,
            attemptsLeft: numberOrNull(body["attemptsLeft"]),
          }
        : { kind: "failed" };
    default:
      return { kind: "failed" };
  }
}

export function resultAnswerOf(answer: AuthedResult): ResultAnswer {
  if (answer.kind === "network" || answer.kind === "signed_out") {
    return { kind: answer.kind };
  }
  if (answer.kind === "ok") {
    return isRecord(answer.body) ? sentOf(answer.body) : { kind: "failed" };
  }
  if (answer.code === "game_refused") {
    return answer.status === 422 ? { kind: "refused" } : { kind: "expired" };
  }
  // A 5xx (busy) is retried with the same key, as a lost answer is: the server answers a replayed key once.
  return answer.status >= 500 ? { kind: "network" } : { kind: "failed" };
}

/** A finished round's result as the app keeps it until it is sent (memory only, ADR-213, Q-177). */
export type PendingResult = Readonly<{
  questId: string;
  roundId: string;
  key: string;
  inputs: readonly unknown[];
  claimed: unknown;
  deadlineAt: string;
  offsetMs: number;
}>;

export async function sendGameResult(
  session: Pick<Session, "request">,
  pending: PendingResult,
): Promise<ResultAnswer> {
  return resultAnswerOf(
    await session.request({
      method: "POST",
      path: `/v1/game-rounds/${encodeURIComponent(pending.roundId)}/result`,
      body: { inputs: pending.inputs, claimed: pending.claimed },
      headers: { "idempotency-key": pending.key },
    }),
  );
}

/** Whether a round's result window is still open, read on the server's clock (FR-1809). */
export const windowOpen = (
  round: Pick<PendingResult, "deadlineAt" | "offsetMs">,
  now: number,
): boolean => now + round.offsetMs < Date.parse(round.deadlineAt);

/**
 * The rounds issued and the results waiting to be sent, in memory only: a closed app loses them, and the round counts
 * as played (Q-177). One of each per quest at most.
 */
export function gameMemory() {
  const rounds = new Map<string, IssuedRound>();
  const pending = new Map<string, PendingResult>();
  return {
    keepRound: (round: IssuedRound) => void rounds.set(round.roundId, round),
    round: (roundId: string) => rounds.get(roundId),
    keepResult: (result: PendingResult) => void pending.set(result.questId, result),
    /** The quest's unsent result while its window is open; one past its window is dropped. */
    result: (questId: string, now: number): PendingResult | undefined => {
      const held = pending.get(questId);
      if (held !== undefined && !windowOpen(held, now)) {
        pending.delete(questId);
        return undefined;
      }
      return held;
    },
    dropResult: (questId: string) => void pending.delete(questId),
  };
}

export const games = gameMemory();

/** What the quest sheet offers (FR-1807, FR-1809, CTO 6): Retry while a result waits, else Play or why not. */
export type SheetAction =
  | Readonly<{ kind: "retry"; pending: PendingResult }>
  | Readonly<{ kind: "play" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "already_played" }>
  | Readonly<{ kind: "no_attempts" }>
  | Readonly<{ kind: "cooldown"; retryAt: string }>;

export function sheetAction(
  sheet: GameSheet,
  pending: PendingResult | undefined,
  now: number,
): SheetAction {
  if (pending !== undefined) {
    return { kind: "retry", pending };
  }
  if (sheet.passed) {
    return { kind: "passed" };
  }
  if (sheet.attemptsLeft === 0) {
    return sheet.attempts === 1 ? { kind: "already_played" } : { kind: "no_attempts" };
  }
  if (sheet.retryAt !== null && Date.parse(sheet.retryAt) > now + sheet.offsetMs) {
    return { kind: "cooldown", retryAt: sheet.retryAt };
  }
  return { kind: "play" };
}
