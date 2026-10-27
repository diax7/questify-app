import { describe, expect, it } from "vitest";
import {
  DAILY_ANSWER_CONFLICTS,
  DAILY_CONTENT_CONFLICTS,
  DAILY_GUESS_CONFLICTS,
  DAILY_GUESS_REFUSALS,
  WORD_LIST_MAX,
  dailyAnswerBodySchema,
  dailyAnswerReplySchema,
  dailyCadenceBodySchema,
  dailyChallengeBodySchema,
  dailyConsoleSchema,
  dailyGuessBodySchema,
  dailyGuessReplySchema,
  dailyQuestionBodySchema,
  dailyWordBodySchema,
  marksSchema,
  ownDailySchema,
  wordListBodySchema,
} from "#src/daily/daily";

const QUESTION = "3f6f1c1e-6a0a-4c41-9a3b-6c2a1f1b9a01";
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;
const RLO = String.fromCharCode(0x202e);

describe("the player's bodies", () => {
  it("takes an answer by challenge, question, position 1 to 3 and choice 1 to 4", () => {
    const body = { challengeId: 7, questionId: QUESTION, position: 1, choice: 4 };
    expect(dailyAnswerBodySchema.parse(body)).toEqual(body);
    for (const bad of [
      { ...body, position: 0 },
      { ...body, position: 4 },
      { ...body, choice: 5 },
      { ...body, choice: 1.5 },
      { ...body, challengeId: 0 },
      { ...body, questionId: "q" },
      { ...body, extra: true },
    ]) {
      expect(ok(dailyAnswerBodySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("takes a guess by word, attempt 1 to 6 and up to 40 characters (the server checks the letters)", () => {
    const body = { wordId: 3, attempt: 6, guess: "crane" };
    expect(dailyGuessBodySchema.parse(body)).toEqual(body);
    expect(ok(dailyGuessBodySchema, { ...body, attempt: 7 })).toBe(false);
    expect(ok(dailyGuessBodySchema, { ...body, guess: "" })).toBe(false);
    expect(ok(dailyGuessBodySchema, { ...body, guess: "x".repeat(41) })).toBe(false);
  });

  it("names the refusal reasons", () => {
    expect(DAILY_ANSWER_CONFLICTS).toEqual(["period_over", "changed", "out_of_order", "answered"]);
    expect(DAILY_GUESS_CONFLICTS).toContain("other_language");
    expect(DAILY_GUESS_REFUSALS).toEqual(["length", "letters", "not_a_word"]);
    expect(DAILY_CONTENT_CONFLICTS).toEqual(["started", "scheduled", "used", "retired", "changed"]);
  });
});

describe("the player's reads and replies", () => {
  it("reads both games, either null", () => {
    expect(ownDailySchema.parse({ challenge: null, word: null })).toEqual({
      challenge: null,
      word: null,
    });
    const challenge = {
      id: 1,
      period: { startsOn: "2026-11-01", endsOn: "2026-11-07" },
      sponsor: { ar: "شركة", en: "Acme" },
      questions: [
        {
          id: QUESTION,
          position: 1,
          prompt: { ar: "س", en: "Q" },
          options: [
            { ar: "أ", en: "A" },
            { ar: "ب", en: "B" },
          ],
          answered: null,
        },
      ],
      finished: null,
    };
    const word = {
      period: { startsOn: "2026-11-01", endsOn: "2026-11-07" },
      length: 5,
      languages: ["ar"],
      words: [{ language: "ar", id: 4 }],
      play: {
        language: "ar",
        wordId: 4,
        guesses: [{ guess: "كتابة", marks: "20100" }],
        finished: null,
      },
    };
    expect(ownDailySchema.parse({ challenge, word })).toEqual({ challenge, word });
    expect(ok(ownDailySchema, { challenge, word: { ...word, length: 6 } })).toBe(false);
  });

  it("marks with five of 0, 1 and 2", () => {
    expect(marksSchema.parse("21000")).toBe("21000");
    for (const bad of ["2100", "210003", "21003", "abcde"])
      expect(ok(marksSchema, bad)).toBe(false);
  });

  it("replies with the move, the finish, the level, the streak and whether it replayed", () => {
    const streak = { days: 2, today: true, next: { days: 3, xp: 50 } };
    expect(
      ok(dailyAnswerReplySchema, {
        answer: { position: 3, choice: 2, correct: true, right: 2 },
        finished: { correct: 3, xp: 50 },
        levelUp: null,
        dailyStreak: streak,
        replayed: false,
      }),
    ).toBe(true);
    expect(
      ok(dailyGuessReplySchema, {
        guess: { attempt: 6, guess: "crane", marks: "00000" },
        finished: { solved: false, attempts: 6, xp: 0, word: "slate" },
        levelUp: null,
        dailyStreak: null,
        replayed: true,
      }),
    ).toBe(true);
  });
});

describe("the console's bodies", () => {
  const question = {
    prompt: { ar: "سؤال", en: "Question" },
    options: [
      { ar: "أ", en: "A" },
      { ar: "ب", en: "B" },
      { ar: "ج", en: "C" },
    ],
    answer: 3,
  };

  it("takes a question in both languages with 2 to 4 options and the right one among them", () => {
    expect(dailyQuestionBodySchema.parse(question)).toEqual(question);
    expect(ok(dailyQuestionBodySchema, { ...question, answer: 4 })).toBe(false);
    expect(
      ok(dailyQuestionBodySchema, { ...question, options: question.options.slice(0, 1) }),
    ).toBe(false);
    expect(ok(dailyQuestionBodySchema, { ...question, prompt: { ar: `س${RLO}`, en: "Q" } })).toBe(
      false,
    );
    expect(ok(dailyQuestionBodySchema, { ...question, prompt: { ar: " ", en: "Q" } })).toBe(false);
  });

  it("takes three different questions and an optional sponsor name", () => {
    const ids = [QUESTION, QUESTION.replace("01", "02"), QUESTION.replace("01", "03")];
    expect(ok(dailyChallengeBodySchema, { questionIds: ids, sponsor: null })).toBe(true);
    expect(
      ok(dailyChallengeBodySchema, {
        questionIds: ids,
        sponsor: { name: { ar: "شركة", en: "Acme" } },
      }),
    ).toBe(true);
    expect(
      ok(dailyChallengeBodySchema, { questionIds: [ids[0], ids[0], ids[1]], sponsor: null }),
    ).toBe(false);
    expect(ok(dailyChallengeBodySchema, { questionIds: ids.slice(0, 2), sponsor: null })).toBe(
      false,
    );
    expect(
      ok(dailyChallengeBodySchema, {
        questionIds: ids,
        sponsor: { name: { ar: "x".repeat(61), en: "A" } },
      }),
    ).toBe(false);
  });

  it("takes a word, list changes up to 20,000 each and a cadence", () => {
    expect(ok(dailyWordBodySchema, { word: "crane" })).toBe(true);
    expect(wordListBodySchema.parse({})).toEqual({ add: [], remove: [] });
    expect(WORD_LIST_MAX).toBe(20000);
    expect(ok(wordListBodySchema, { add: Array.from({ length: 20001 }, () => "crane") })).toBe(
      false,
    );
    expect(ok(dailyCadenceBodySchema, { kind: "word", cadence: "daily" })).toBe(true);
    expect(ok(dailyCadenceBodySchema, { kind: "word", cadence: "monthly" })).toBe(false);
  });

  it("reads the console's schedule", () => {
    const cover = { coveredDays: 7, coveredPeriods: 1, warn: true };
    const read = {
      status: {
        challenge: { cadence: "weekly", next: null, ...cover },
        word: {
          cadence: "weekly",
          next: { cadence: "daily", from: "2026-11-02" },
          ar: cover,
          en: cover,
        },
      },
      periods: [
        { kind: "challenge", startsOn: "2026-11-01", endsOn: "2026-11-07", challenge: null },
        { kind: "word", startsOn: "2026-11-01", endsOn: "2026-11-07", words: {} },
      ],
      unused: [{ kind: "word", language: "en", startsOn: "2026-11-03" }],
    };
    expect(dailyConsoleSchema.parse(read)).toEqual(read);
  });
});
