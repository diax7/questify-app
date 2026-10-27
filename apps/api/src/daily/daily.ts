import {
  DAILY_ANSWER_CONFLICTS,
  DAILY_GUESS_CONFLICTS,
  DAILY_GUESS_REFUSALS,
  type DailyAnswerBody,
  type DailyAnswerReply,
  type DailyGuessBody,
  type DailyGuessReply,
  type OwnDaily,
} from "@questify/shared";
import type { PoolClient } from "pg";
import {
  dailyConflict,
  dailyUnavailable,
  invalidAnswer,
  invalidGuess,
  unauthenticated,
} from "#src/auth/http-errors";
import type { HttpError } from "#src/http-error";

/**
 * The daily games' player doors (T-406, migration 0069, FR-730, FR-1810): `own_daily`, `daily_answer_submit` and
 * `daily_guess_submit` bind the caller from the request context and re-check an active player, so no door can name
 * another player. A retry sends the same natural key (position and choice, attempt and guess) and gets the stored
 * result, so no Idempotency-Key is needed.
 */

type PgError = Readonly<{ code?: string; detail?: string }>;
/** How one SQLSTATE answers: only for these DETAILs (null: any), and with which HTTP error. */
type Rule = Readonly<{
  details: ReadonlySet<string> | null;
  answer: (detail: string) => HttpError;
}>;

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["PI401", { details: null, answer: () => unauthenticated() }],
  ["DC404", { details: null, answer: () => dailyUnavailable() }],
  ["DW404", { details: null, answer: () => dailyUnavailable() }],
  [
    "DC409",
    { details: new Set(DAILY_ANSWER_CONFLICTS), answer: (reason) => dailyConflict({ reason }) },
  ],
  [
    "DW409",
    { details: new Set(DAILY_GUESS_CONFLICTS), answer: (reason) => dailyConflict({ reason }) },
  ],
  [
    "DC422",
    { details: new Set(["position", "choice"]), answer: (field) => invalidAnswer({ field }) },
  ],
  [
    "DW422",
    { details: new Set(DAILY_GUESS_REFUSALS), answer: (reason) => invalidGuess({ reason }) },
  ],
]);

/** A door's refusal as an HTTP answer, by SQLSTATE and DETAIL; anything else is a server fault and is rethrown. */
export function dailyRefusal(error: unknown): never {
  const { code = "", detail = "" } = error as PgError;
  const rule = RULES.get(code);
  if (rule !== undefined && (rule.details === null || rule.details.has(detail))) {
    throw rule.answer(detail);
  }
  throw error;
}

/** The caller's daily games; an inactive caller has none (401). */
export async function readDaily(client: PoolClient): Promise<OwnDaily> {
  const { rows } = await client.query<{ daily: OwnDaily | null }>("SELECT own_daily() AS daily");
  const daily = rows[0]?.daily;
  if (daily === null || daily === undefined) throw unauthenticated();
  return daily;
}

async function door<T>(client: PoolClient, sql: string, values: unknown[]): Promise<T> {
  try {
    const { rows } = await client.query<{ reply: T }>(sql, values);
    // Stryker disable next-line OptionalChaining: a door always answers one row or raises
    return rows[0]?.reply as T;
  } catch (error) {
    return dailyRefusal(error);
  }
}

/** Answers one question of the current challenge, in order, once. */
export const submitAnswer = (
  client: PoolClient,
  body: DailyAnswerBody,
): Promise<DailyAnswerReply> =>
  door(client, "SELECT daily_answer_submit($1, $2, $3, $4) AS reply", [
    body.challengeId,
    body.questionId,
    body.position,
    body.choice,
  ]);

/** Plays one guess of the current word; a refused guess uses no attempt. */
export const submitGuess = (client: PoolClient, body: DailyGuessBody): Promise<DailyGuessReply> =>
  door(client, "SELECT daily_guess_submit($1, $2, $3) AS reply", [
    body.wordId,
    body.attempt,
    body.guess,
  ]);
