import {
  DAILY_CONTENT_CONFLICTS,
  DAILY_CONTENT_FIELDS,
  type AdminDailyQuestion,
  type DailyCadenceBody,
  type DailyChallengeBody,
  type DailyConsole,
  type DailyLanguage,
  type DailyQuestionBody,
  type WordListBody,
} from "@questify/shared";
import type { Pool } from "pg";
import { dailyContentConflict, invalidDaily, notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";

/**
 * The console's daily content (T-406, migration 0069, FR-732, FR-1733, FR-1811, FR-1814, ADR-307, ADR-308, ADR-311).
 * Every door re-reads the admin from the account (`questify_admin`), so the request flag set here opens nothing on its
 * own; the database audits each write with ids and changed field names only, never a word or an answer.
 */

type PgError = Readonly<{ code?: string; detail?: string; hint?: string }>;
/** How one SQLSTATE answers: only for these DETAILs (null: any), and with which HTTP error. */
type Rule = Readonly<{
  details: ReadonlySet<string> | null;
  answer: (detail: string, hint: string | undefined) => HttpError;
}>;

/** The question at fault (1 to 3) a DK409 names in its HINT, when it names one. */
const positionOf = (hint: string | undefined): Readonly<{ position?: number }> =>
  hint !== undefined && /^[1-3]$/.test(hint) ? { position: Number(hint) } : {};

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  // Not an active platform admin (QY403): the same 404 the console hook gives, so nothing is advertised.
  ["QY403", { details: null, answer: () => notFound() }],
  ["DK404", { details: null, answer: () => notFound() }],
  [
    "DK409",
    {
      details: new Set(DAILY_CONTENT_CONFLICTS),
      answer: (reason, hint) => dailyContentConflict({ reason, ...positionOf(hint) }),
    },
  ],
  ["DK422", { details: new Set(DAILY_CONTENT_FIELDS), answer: (field) => invalidDaily({ field }) }],
  // Two saves of one new day at once: the second meets the first's unique key.
  ["23505", { details: null, answer: () => dailyContentConflict({ reason: "changed" }) }],
  // A value the tables refuse that the shared schemas let through.
  ["23514", { details: null, answer: () => invalidDaily() }],
]);

/** A door's refusal as an HTTP answer; anything else is a server fault and is rethrown. */
export function dailyContentRefusal(error: unknown): never {
  const { code = "", detail = "", hint } = error as PgError;
  const rule = RULES.get(code);
  if (rule !== undefined && (rule.details === null || rule.details.has(detail))) {
    throw rule.answer(detail, hint);
  }
  throw error;
}

async function door<T>(pool: Pool, adminId: string, sql: string, values: unknown[]): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: adminId }, async () => {
        const { rows } = await client.query<{ r: T }>(sql, values);
        return rows[0]?.r as T;
      }),
    );
  } catch (error) {
    return dailyContentRefusal(error);
  }
}

export type DailyAdmin = Readonly<{ pool: Pool; adminId: string; requestId: string }>;

/** The schedule from `from` to `to` (at most 120 days), the status and warnings, the unused content. */
export const readDailyConsole = (
  admin: DailyAdmin,
  from: string,
  to: string,
): Promise<DailyConsole> =>
  door(admin.pool, admin.adminId, "SELECT daily_console($1, $2) AS r", [from, to]);

/** The question bank, newest first: one page after `before` (a question id). */
export const listDailyQuestions = (
  admin: DailyAdmin,
  query: Readonly<{ status: string | null; before: string | null; limit: number }>,
): Promise<AdminDailyQuestion[]> =>
  door(admin.pool, admin.adminId, "SELECT daily_question_list($1, $2, $3) AS r", [
    query.status,
    query.before,
    query.limit,
  ]);

/** Creates a question (`id` null) or replaces one until its challenge has started. */
export const saveDailyQuestion = (
  admin: DailyAdmin,
  id: string | null,
  body: DailyQuestionBody,
): Promise<AdminDailyQuestion> =>
  door(admin.pool, admin.adminId, "SELECT daily_question_save($1, $2::jsonb, $3) AS r", [
    id,
    JSON.stringify(body),
    admin.requestId,
  ]);

/** Retires a question no challenge holds. */
export const retireDailyQuestion = (admin: DailyAdmin, id: string): Promise<AdminDailyQuestion> =>
  door(admin.pool, admin.adminId, "SELECT daily_question_retire($1, $2) AS r", [
    id,
    admin.requestId,
  ]);

/** Sets a future period's challenge: its three questions and an optional sponsor name. */
export const setDailyChallenge = (admin: DailyAdmin, day: string, body: DailyChallengeBody) =>
  door<Record<string, unknown>>(
    admin.pool,
    admin.adminId,
    "SELECT daily_challenge_set($1, $2::uuid[], $3::jsonb, $4) AS r",
    [
      day,
      body.questionIds,
      body.sponsor === null ? null : JSON.stringify(body.sponsor.name),
      admin.requestId,
    ],
  );

/** Clears a future period's challenge (or a stranded one with no plays). */
export const clearDailyChallenge = (admin: DailyAdmin, day: string) =>
  door<Record<string, unknown>>(
    admin.pool,
    admin.adminId,
    "SELECT daily_challenge_clear($1, $2) AS r",
    [day, admin.requestId],
  );

/** Sets a future period's word in one language; a replaced word gets a new id. */
export const setDailyWord = (
  admin: DailyAdmin,
  language: DailyLanguage,
  day: string,
  word: string,
) =>
  door<Record<string, unknown>>(
    admin.pool,
    admin.adminId,
    "SELECT daily_word_set($1, $2, $3, $4) AS r",
    [language, day, word, admin.requestId],
  );

/** Clears a future period's word in one language (or a stranded one with no plays). */
export const clearDailyWord = (admin: DailyAdmin, language: DailyLanguage, day: string) =>
  door<Record<string, unknown>>(
    admin.pool,
    admin.adminId,
    "SELECT daily_word_clear($1, $2, $3) AS r",
    [language, day, admin.requestId],
  );

/** One page of a language's guess list starting with `prefix`, and how many words match. */
export const readWordList = (
  admin: DailyAdmin,
  language: DailyLanguage,
  query: Readonly<{ prefix: string; page: number }>,
) =>
  door<{ words: string[]; total: number }>(
    admin.pool,
    admin.adminId,
    "SELECT word_list_page($1, $2, $3) AS r",
    [language, query.prefix, query.page],
  );

/** Adds and removes guess-list words; invalid inputs are refused and the first 50 answered. */
export const changeWordList = (admin: DailyAdmin, language: DailyLanguage, body: WordListBody) =>
  door<{ added: number; removed: number; refused: string[]; total: number }>(
    admin.pool,
    admin.adminId,
    "SELECT word_list_change($1, $2::text[], $3::text[], $4) AS r",
    [language, body.add, body.remove, admin.requestId],
  );

/** Sets a kind's cadence from tomorrow; today's cadence again drops a pending change. */
export const setDailyCadence = (admin: DailyAdmin, body: DailyCadenceBody) =>
  door<Record<string, unknown>>(
    admin.pool,
    admin.adminId,
    "SELECT daily_cadence_set($1, $2, $3) AS r",
    [body.kind, body.cadence, admin.requestId],
  );
