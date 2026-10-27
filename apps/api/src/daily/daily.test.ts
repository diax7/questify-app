import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { dailyRefusal, readDaily, submitAnswer, submitGuess } from "#src/daily/daily";
import { HttpError } from "#src/http-error";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

type Seen = { sql: string; values: readonly unknown[] };
const QUESTION = "44444444-4444-4444-8444-444444444444";

async function clientAnswering(answer: (sql: string, values: readonly unknown[]) => FakeAnswer) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return answer(sql, values);
  });
  return { client: (await pool.connect()) as PoolClient, seen };
}

const answerOf = (error: unknown) => {
  try {
    dailyRefusal(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("dailyRefusal returned");
};

type Case = readonly [
  Readonly<Record<string, string>>,
  number,
  string,
  Readonly<Record<string, string>>,
];
const conflicts = (code: string, reasons: string[]): Case[] =>
  reasons.map((reason) => [{ code, detail: reason }, 409, "daily_conflict", { reason }]);

const CASES: readonly Case[] = [
  [{ code: "PI401" }, 401, "unauthenticated", {}],
  [{ code: "DC404", detail: "unavailable" }, 404, "daily_unavailable", {}],
  [{ code: "DW404", detail: "unavailable" }, 404, "daily_unavailable", {}],
  ...conflicts("DC409", ["period_over", "changed", "out_of_order", "answered"]),
  ...conflicts("DW409", [
    "period_over",
    "changed",
    "out_of_order",
    "attempt_taken",
    "finished",
    "other_language",
  ]),
  [{ code: "DC422", detail: "position" }, 422, "invalid_answer", { field: "position" }],
  [{ code: "DC422", detail: "choice" }, 422, "invalid_answer", { field: "choice" }],
  [{ code: "DW422", detail: "length" }, 422, "invalid_guess", { reason: "length" }],
  [{ code: "DW422", detail: "letters" }, 422, "invalid_guess", { reason: "letters" }],
  [{ code: "DW422", detail: "not_a_word" }, 422, "invalid_guess", { reason: "not_a_word" }],
];

describe("the daily doors' refusals (T-406)", () => {
  it.each(CASES)("answers %o as %i %s", (fields, status, code, details) => {
    const answer = answerOf(pgError(fields));
    expect(answer).toBeInstanceOf(HttpError);
    expect(answer).toMatchObject({ status, envelope: { code, details } });
    expect((answer as HttpError).envelope.details).toEqual(details);
  });

  it.each([
    { code: "DC409", detail: "unknown" },
    { code: "DC409" },
    { code: "DW422", detail: "attempt" },
    { code: "DC422", detail: "length" },
    { code: "DW422", detail: "choice" },
    { code: "DK409", detail: "started" },
    { code: "40P01" },
    { code: "42501" },
    {},
  ])("rethrows %o unchanged as a server fault", (fields) => {
    const fault = pgError(fields);
    expect(answerOf(fault)).toBe(fault);
  });
});

describe("readDaily", () => {
  it("answers the games the database built for the caller", async () => {
    const daily = { challenge: null, word: null };
    const { client, seen } = await clientAnswering(() => ({ rows: [{ daily }] }));
    await expect(readDaily(client)).resolves.toEqual(daily);
    expect(seen.map((one) => one.sql)).toEqual(["SELECT own_daily() AS daily"]);
  });

  it.each([
    ["a null answer", [{ daily: null }]],
    ["no row", []],
  ])("answers 401 for %s, an inactive caller", async (_label, rows) => {
    const { client } = await clientAnswering(() => ({ rows }));
    await expect(readDaily(client)).rejects.toMatchObject({ status: 401 });
  });
});

describe("the move doors", () => {
  it("sends an answer's challenge, question, position and choice, and answers the reply", async () => {
    const reply = { answer: { position: 1 }, replayed: false };
    const { client, seen } = await clientAnswering(() => ({ rows: [{ reply }] }));
    await expect(
      submitAnswer(client, { challengeId: 3, questionId: QUESTION, position: 1, choice: 2 }),
    ).resolves.toEqual(reply);
    expect(seen).toEqual([
      { sql: "SELECT daily_answer_submit($1, $2, $3, $4) AS reply", values: [3, QUESTION, 1, 2] },
    ]);
  });

  it("sends a guess's word, attempt and text, and answers the reply", async () => {
    const reply = { guess: { attempt: 2 }, replayed: true };
    const { client, seen } = await clientAnswering(() => ({ rows: [{ reply }] }));
    await expect(submitGuess(client, { wordId: 9, attempt: 2, guess: "crane" })).resolves.toEqual(
      reply,
    );
    expect(seen).toEqual([
      { sql: "SELECT daily_guess_submit($1, $2, $3) AS reply", values: [9, 2, "crane"] },
    ]);
  });

  it("answers a refusal as its HTTP error", async () => {
    const { client } = await clientAnswering(() => {
      throw pgError({ code: "DW422", detail: "not_a_word" });
    });
    await expect(
      submitGuess(client, { wordId: 9, attempt: 1, guess: "zzzzz" }),
    ).rejects.toMatchObject({
      status: 422,
      envelope: { code: "invalid_guess", details: { reason: "not_a_word" } },
    });
  });
});
