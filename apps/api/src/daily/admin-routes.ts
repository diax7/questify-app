import {
  DAILY_LANGUAGES,
  dailyCadenceBodySchema,
  dailyChallengeBodySchema,
  dailyQuestionBodySchema,
  dailyWordBodySchema,
  wordListBodySchema,
} from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  changeWordList,
  clearDailyChallenge,
  clearDailyWord,
  listDailyQuestions,
  readDailyConsole,
  readWordList,
  retireDailyQuestion,
  saveDailyQuestion,
  setDailyCadence,
  setDailyChallenge,
  setDailyWord,
  type DailyAdmin,
} from "#src/daily/admin";

// A guess list call carries up to 2 × 20,000 words of at most 40 characters (about 3.3 MB of Arabic at most).
const LIST_LIMIT = 4 * 1024 * 1024;
const read = { config: { access: "admin" }, bodyLimit: 16 * 1024 } as const;
const write = { ...read, config: { ...read.config, idempotent: true } } as const;
const listWrite = { ...write, bodyLimit: LIST_LIMIT } as const;

const day = z.iso.date();
const consoleQuery = z.strictObject({ from: day, to: day });
const questionQuery = z.strictObject({
  status: z.enum(["ready", "retired"]).optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const wordListQuery = z.strictObject({
  prefix: z.string().max(40).default(""),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const questionParams = z.object({ questionId: z.uuid() });
const dayParams = z.object({ day });
const wordParams = z.object({ language: z.enum(DAILY_LANGUAGES), day });
const listParams = z.object({ language: z.enum(DAILY_LANGUAGES) });

/** The admin of a request that passed the console hook (activation/routes.ts), with the pool and the request id. */
function adminOf(request: FastifyRequest, pool: Pool): DailyAdmin {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) throw notFound();
  return { pool, adminId: account.id, requestId: request.id };
}

/** The question bank: read, create, replace and retire. */
function registerQuestionRoutes(scope: FastifyInstance, pool: Pool): void {
  scope.get("/daily/questions", read, async (request) => {
    const query = parse(questionQuery, request.query);
    return {
      questions: await listDailyQuestions(adminOf(request, pool), {
        status: query.status ?? null,
        before: query.before ?? null,
        limit: query.limit,
      }),
    };
  });
  scope.post("/daily/questions", write, async (request, reply) => {
    const body = parse(dailyQuestionBodySchema, request.body);
    const question = await saveDailyQuestion(adminOf(request, pool), null, body);
    return reply.code(201).send({ question });
  });
  scope.put("/daily/questions/:questionId", write, async (request) => {
    const { questionId } = parse(questionParams, request.params);
    const body = parse(dailyQuestionBodySchema, request.body);
    return { question: await saveDailyQuestion(adminOf(request, pool), questionId, body) };
  });
  scope.post("/daily/questions/:questionId/retire", write, async (request) => {
    const { questionId } = parse(questionParams, request.params);
    return { question: await retireDailyQuestion(adminOf(request, pool), questionId) };
  });
}

/** The schedule: a period's challenge and words, the guess lists and the cadence. */
function registerScheduleRoutes(scope: FastifyInstance, pool: Pool): void {
  scope.put("/daily/challenges/:day", write, async (request) => {
    const params = parse(dayParams, request.params);
    const body = parse(dailyChallengeBodySchema, request.body);
    return { challenge: await setDailyChallenge(adminOf(request, pool), params.day, body) };
  });
  scope.delete("/daily/challenges/:day", write, async (request) => {
    const params = parse(dayParams, request.params);
    return clearDailyChallenge(adminOf(request, pool), params.day);
  });
  scope.put("/daily/words/:language/:day", write, async (request) => {
    const params = parse(wordParams, request.params);
    const body = parse(dailyWordBodySchema, request.body);
    return {
      word: await setDailyWord(adminOf(request, pool), params.language, params.day, body.word),
    };
  });
  scope.delete("/daily/words/:language/:day", write, async (request) => {
    const params = parse(wordParams, request.params);
    return clearDailyWord(adminOf(request, pool), params.language, params.day);
  });
  scope.get("/daily/word-list/:language", read, async (request) => {
    const { language } = parse(listParams, request.params);
    return readWordList(adminOf(request, pool), language, parse(wordListQuery, request.query));
  });
  scope.post("/daily/word-list/:language", listWrite, async (request) => {
    const { language } = parse(listParams, request.params);
    return changeWordList(
      adminOf(request, pool),
      language,
      parse(wordListBodySchema, request.body),
    );
  });
  scope.put("/daily/cadence", write, async (request) =>
    setDailyCadence(adminOf(request, pool), parse(dailyCadenceBodySchema, request.body)),
  );
}

/**
 * The console's daily content (T-406, FR-732, FR-1733, FR-1811, FR-1814): registered inside the console scope, whose
 * hook answers 404 to anyone but an active platform admin and sets `no-store`. Every write takes an Idempotency-Key;
 * the database checks the admin again and audits each write.
 */
export function registerConsoleDailyRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool }>,
): void {
  scope.get("/daily", read, async (request) => {
    const query = parse(consoleQuery, request.query);
    return readDailyConsole(adminOf(request, deps.pool), query.from, query.to);
  });
  registerQuestionRoutes(scope, deps.pool);
  registerScheduleRoutes(scope, deps.pool);
}
