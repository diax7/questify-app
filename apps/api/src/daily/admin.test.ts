import { describe, expect, it } from "vitest";
import {
  changeWordList,
  clearDailyChallenge,
  clearDailyWord,
  dailyContentRefusal,
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
import { HttpError } from "#src/http-error";
import { fakePool, pgError } from "#test/support/fake-pool";

const ID = "44444444-4444-4444-8444-444444444444";
const REQUEST = "req-1";
const DAY = "2026-11-01";

const answerOf = (error: unknown) => {
  try {
    dailyContentRefusal(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("dailyContentRefusal returned");
};

describe("the console daily doors' refusals (T-406)", () => {
  it.each([
    [{ code: "QY403" }, 404, "not_found", {}],
    [{ code: "DK404" }, 404, "not_found", {}],
    [{ code: "DK409", detail: "started" }, 409, "daily_content_conflict", { reason: "started" }],
    [
      { code: "DK409", detail: "used", hint: "2" },
      409,
      "daily_content_conflict",
      { reason: "used", position: 2 },
    ],
    [
      { code: "DK409", detail: "retired", hint: "x" },
      409,
      "daily_content_conflict",
      { reason: "retired" },
    ],
    [
      { code: "DK409", detail: "used", hint: "4" },
      409,
      "daily_content_conflict",
      { reason: "used" },
    ],
    [
      { code: "DK409", detail: "used", hint: "12" },
      409,
      "daily_content_conflict",
      { reason: "used" },
    ],
    [
      { code: "DK422", detail: "not_period_start" },
      422,
      "invalid_daily",
      { field: "not_period_start" },
    ],
    [{ code: "DK422", detail: "sponsor" }, 422, "invalid_daily", { field: "sponsor" }],
    [{ code: "23505" }, 409, "daily_content_conflict", { reason: "changed" }],
    [{ code: "23514" }, 422, "invalid_daily", {}],
  ])("answers %o as %i %s", (fields, status, code, details) => {
    const answer = answerOf(pgError(fields));
    expect(answer).toBeInstanceOf(HttpError);
    expect(answer).toMatchObject({ status, envelope: { code } });
    expect((answer as HttpError).envelope.details).toEqual(details);
  });

  it.each([
    { code: "DK409", detail: "nope" },
    { code: "DK422" },
    { code: "DC409", detail: "changed" },
    { code: "40P01" },
  ])("rethrows %o unchanged as a server fault", (fields) => {
    const fault = pgError(fields);
    expect(answerOf(fault)).toBe(fault);
  });
});

type Call = readonly [string, (admin: DailyAdmin) => Promise<unknown>, string, readonly unknown[]];
const QUESTION = { prompt: { ar: "س", en: "Q" }, options: [], answer: 1 };
const CALLS: readonly Call[] = [
  [
    "the console read",
    (a) => readDailyConsole(a, DAY, "2026-11-30"),
    "SELECT daily_console($1, $2) AS r",
    [DAY, "2026-11-30"],
  ],
  [
    "the bank",
    (a) => listDailyQuestions(a, { status: "ready", before: ID, limit: 20 }),
    "SELECT daily_question_list($1, $2, $3) AS r",
    ["ready", ID, 20],
  ],
  [
    "a new question",
    (a) => saveDailyQuestion(a, null, QUESTION),
    "SELECT daily_question_save($1, $2::jsonb, $3) AS r",
    [null, JSON.stringify(QUESTION), REQUEST],
  ],
  [
    "a retirement",
    (a) => retireDailyQuestion(a, ID),
    "SELECT daily_question_retire($1, $2) AS r",
    [ID, REQUEST],
  ],
  [
    "a sponsored challenge",
    (a) =>
      setDailyChallenge(a, DAY, { questionIds: [ID], sponsor: { name: { ar: "ش", en: "A" } } }),
    "SELECT daily_challenge_set($1, $2::uuid[], $3::jsonb, $4) AS r",
    [DAY, [ID], JSON.stringify({ ar: "ش", en: "A" }), REQUEST],
  ],
  [
    "an unsponsored challenge",
    (a) => setDailyChallenge(a, DAY, { questionIds: [ID], sponsor: null }),
    "SELECT daily_challenge_set($1, $2::uuid[], $3::jsonb, $4) AS r",
    [DAY, [ID], null, REQUEST],
  ],
  [
    "a cleared challenge",
    (a) => clearDailyChallenge(a, DAY),
    "SELECT daily_challenge_clear($1, $2) AS r",
    [DAY, REQUEST],
  ],
  [
    "a word",
    (a) => setDailyWord(a, "ar", DAY, "كتابة"),
    "SELECT daily_word_set($1, $2, $3, $4) AS r",
    ["ar", DAY, "كتابة", REQUEST],
  ],
  [
    "a cleared word",
    (a) => clearDailyWord(a, "en", DAY),
    "SELECT daily_word_clear($1, $2, $3) AS r",
    ["en", DAY, REQUEST],
  ],
  [
    "a list page",
    (a) => readWordList(a, "en", { prefix: "cr", page: 2 }),
    "SELECT word_list_page($1, $2, $3) AS r",
    ["en", "cr", 2],
  ],
  [
    "a list change",
    (a) => changeWordList(a, "en", { add: ["crane"], remove: ["slate"] }),
    "SELECT word_list_change($1, $2::text[], $3::text[], $4) AS r",
    ["en", ["crane"], ["slate"], REQUEST],
  ],
  [
    "a cadence",
    (a) => setDailyCadence(a, { kind: "word", cadence: "daily" }),
    "SELECT daily_cadence_set($1, $2, $3) AS r",
    ["word", "daily", REQUEST],
  ],
];

describe("the console daily doors' calls", () => {
  it.each(CALLS)(
    "sends %s to its door as the admin and answers its row",
    async (_label, work, sql, values) => {
      const seen: { sql: string; values: readonly unknown[] }[] = [];
      const { pool } = fakePool((query, sent) => {
        seen.push({ sql: query, values: sent });
        return { rows: [{ r: { ok: true } }] };
      });
      await expect(work({ pool, adminId: ID, requestId: REQUEST })).resolves.toEqual({ ok: true });
      expect(seen).toEqual([{ sql, values }]);
    },
  );

  it("answers a refusal as its HTTP error", async () => {
    const { pool } = fakePool(() => {
      throw pgError({ code: "DK409", detail: "started" });
    });
    await expect(
      clearDailyChallenge({ pool, adminId: ID, requestId: REQUEST }, DAY),
    ).rejects.toMatchObject({
      status: 409,
      envelope: { code: "daily_content_conflict", details: { reason: "started" } },
    });
  });
});
