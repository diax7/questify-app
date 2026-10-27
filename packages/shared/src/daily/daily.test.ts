import { describe, expect, it } from "vitest";
import {
  DAILY_ANSWER_CONFLICTS,
  DAILY_CONTENT_CONFLICTS,
  DAILY_GUESS_CONFLICTS,
  DAILY_GUESS_REFUSALS,
  WORD_LIST_MAX,
  adminDailyQuestionSchema,
  dailyAnswerBodySchema,
  dailyAnswerReplySchema,
  dailyCadenceBodySchema,
  dailyChallengeSchema,
  dailyConflictSchema,
  dailyContentConflictSchema,
  DAILY_CONTENT_FIELDS,
  invalidAnswerSchema,
  invalidDailySchema,
  invalidGuessSchema,
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

type Schema = { safeParse: (value: unknown) => { success: boolean } };
const set = (base: object, path: string[], value: unknown): object => {
  const [head, ...rest] = path;
  if (head === undefined) return value as object;
  const current = base as Record<string, unknown>;
  return { ...current, [head]: set((current[head] ?? {}) as object, rest, value) };
};
const withoutKey = (base: object, key: string): object =>
  Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
/** Accepts every `good` value and refuses every `bad` value at `path` of an otherwise valid `base`. */
const bounds = (schema: Schema, base: object, path: string[], good: unknown[], bad: unknown[]) => {
  for (const value of good)
    expect(ok(schema, set(base, path, value)), `${path.join(".")}=${String(value)}`).toBe(true);
  for (const value of bad)
    expect(ok(schema, set(base, path, value)), `${path.join(".")}=${String(value)}`).toBe(false);
};
const messages = (schema: { safeParse: (value: unknown) => unknown }, value: unknown) =>
  (schema.safeParse(value) as { error?: { issues: { message: string; path: PropertyKey[] }[] } })
    .error?.issues ?? [];

describe("the refusal shapes", () => {
  it("names a conflict reason of either game and no other", () => {
    for (const reason of [...DAILY_ANSWER_CONFLICTS, ...DAILY_GUESS_CONFLICTS])
      expect(dailyConflictSchema.parse({ reason })).toEqual({ reason });
    expect(ok(dailyConflictSchema, { reason: "nope" })).toBe(false);
    expect(ok(dailyConflictSchema, { reason: "" })).toBe(false);
    expect(ok(dailyConflictSchema, {})).toBe(false);
  });

  it("names a guess refusal, an answer field and a console field, and no other", () => {
    for (const reason of DAILY_GUESS_REFUSALS)
      expect(invalidGuessSchema.parse({ reason })).toEqual({ reason });
    expect(ok(invalidGuessSchema, { reason: "nope" })).toBe(false);
    expect(ok(invalidGuessSchema, {})).toBe(false);
    for (const field of ["position", "choice"])
      expect(invalidAnswerSchema.parse({ field })).toEqual({ field });
    for (const field of ["", "answer"]) expect(ok(invalidAnswerSchema, { field })).toBe(false);
    expect(ok(invalidAnswerSchema, {})).toBe(false);
    for (const field of DAILY_CONTENT_FIELDS)
      expect(invalidDailySchema.parse({ field })).toEqual({ field });
    expect(ok(invalidDailySchema, { field: "nope" })).toBe(false);
    expect(ok(invalidDailySchema, {})).toBe(false);
  });

  it("names a console conflict with the position of the question at fault (1 to 3)", () => {
    for (const reason of DAILY_CONTENT_CONFLICTS)
      expect(dailyContentConflictSchema.parse({ reason })).toEqual({ reason });
    const base = { reason: "used", position: 2 };
    expect(dailyContentConflictSchema.parse(base)).toEqual(base);
    bounds(dailyContentConflictSchema, base, ["position"], [1, 2, 3], [0, 4, 1.5]);
    expect(ok(dailyContentConflictSchema, { reason: "nope" })).toBe(false);
    expect(ok(dailyContentConflictSchema, {})).toBe(false);
  });
});

describe("the player's replies, field by field", () => {
  const streak = { days: 2, today: true, next: { days: 3, xp: 50 } };
  const level = { level: 2, title: { ar: "مغامر", en: "Adventurer" }, items: [] };
  const reward = { levelUp: level, dailyStreak: streak, replayed: false };
  const answer = {
    answer: { position: 2, choice: 1, correct: false, right: 4 },
    finished: { correct: 2, xp: 30 },
    ...reward,
  };
  const guess = {
    guess: { attempt: 3, guess: "crane", marks: "01201" },
    finished: { solved: true, attempts: 3, xp: 40, word: "crane" },
    ...reward,
  };

  it("keeps an answer reply's fields and their bounds", () => {
    expect(dailyAnswerReplySchema.parse(answer)).toEqual(answer);
    const at = (path: string[], good: unknown[], bad: unknown[]) =>
      bounds(dailyAnswerReplySchema, answer, path, good, bad);
    at(["answer", "position"], [1, 2, 3], [0, 4, 1.5]);
    at(["answer", "choice"], [1, 4], [0, 5]);
    at(["answer", "right"], [1, 4], [0, 5]);
    at(["answer", "correct"], [true], ["yes"]);
    at(["finished", "correct"], [0, 3], [-1, 4, 1.5]);
    at(["finished", "xp"], [0, 50], [-1, 1.5]);
    for (const missing of ["answer", "finished", "levelUp", "dailyStreak", "replayed"])
      expect(ok(dailyAnswerReplySchema, withoutKey(answer, missing)), missing).toBe(false);
    expect(ok(dailyAnswerReplySchema, set(answer, ["answer"], { position: 1 }))).toBe(false);
    expect(ok(dailyAnswerReplySchema, set(answer, ["finished"], {}))).toBe(false);
    expect(ok(dailyAnswerReplySchema, { ...answer, finished: null })).toBe(true);
  });

  it("keeps a guess reply's fields and their bounds", () => {
    expect(dailyGuessReplySchema.parse(guess)).toEqual(guess);
    const at = (path: string[], good: unknown[], bad: unknown[]) =>
      bounds(dailyGuessReplySchema, guess, path, good, bad);
    at(["guess", "attempt"], [1, 6], [0, 7, 1.5]);
    at(["guess", "marks"], ["22222"], ["2222", "22223"]);
    at(["finished", "attempts"], [1, 6], [0, 7]);
    at(["finished", "solved"], [false], ["yes"]);
    at(["finished", "xp"], [0], [-1]);
    for (const missing of ["guess", "finished", "levelUp", "dailyStreak", "replayed"])
      expect(ok(dailyGuessReplySchema, withoutKey(guess, missing)), missing).toBe(false);
    for (const key of ["attempt", "guess", "marks"])
      expect(ok(dailyGuessReplySchema, set(guess, ["guess"], withoutKey(guess.guess, key)))).toBe(
        false,
      );
    for (const key of ["solved", "attempts", "xp", "word"])
      expect(
        ok(dailyGuessReplySchema, set(guess, ["finished"], withoutKey(guess.finished, key))),
        key,
      ).toBe(false);
    expect(ok(dailyGuessReplySchema, { ...guess, finished: null })).toBe(true);
  });

  it("keeps a challenge question's position (1 to 3), options (2 to 4) and answered fields", () => {
    const option = { ar: "أ", en: "A" };
    const challenge = {
      id: 1,
      period: { startsOn: "2026-11-01", endsOn: "2026-11-01" },
      sponsor: null,
      questions: [{ id: QUESTION, position: 2, prompt: option, options: [option, option, option] }],
      finished: { correct: 0, xp: 0 },
    };
    const question = (patch: object) => ({
      ...challenge,
      questions: [{ ...challenge.questions[0], answered: null, ...patch }],
    });
    for (const position of [1, 2, 3])
      expect(ok(dailyChallengeSchema, question({ position }))).toBe(true);
    for (const position of [0, 4])
      expect(ok(dailyChallengeSchema, question({ position }))).toBe(false);
    for (const count of [2, 3, 4])
      expect(
        ok(
          dailyChallengeSchema,
          question({ options: Array.from({ length: count }, () => option) }),
        ),
      ).toBe(true);
    for (const count of [0, 1, 5])
      expect(
        ok(
          dailyChallengeSchema,
          question({ options: Array.from({ length: count }, () => option) }),
        ),
      ).toBe(false);
    const answered = { choice: 2, correct: true, right: 2 };
    expect(ok(dailyChallengeSchema, question({ answered }))).toBe(true);
    expect(ok(dailyChallengeSchema, question({ answered: { choice: 2 } }))).toBe(false);
    expect(ok(dailyChallengeSchema, question({ answered: { ...answered, right: 5 } }))).toBe(false);
  });
});

describe("the console's shapes, field by field", () => {
  const option = { ar: "أ", en: "A" };
  const question = {
    id: QUESTION,
    prompt: option,
    options: [option, option],
    answer: 2,
    status: "ready",
    scheduledOn: null,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };

  it("keeps a bank question's answer (1 to 4), status and required fields", () => {
    expect(adminDailyQuestionSchema.parse(question)).toEqual(question);
    bounds(adminDailyQuestionSchema, question, ["answer"], [1, 2, 3, 4], [0, 5, 1.5]);
    bounds(adminDailyQuestionSchema, question, ["status"], ["ready", "retired"], ["", "draft"]);
    bounds(adminDailyQuestionSchema, question, ["scheduledOn"], [null, "2026-11-08"], ["soon"]);
    for (const missing of Object.keys(question))
      expect(ok(adminDailyQuestionSchema, withoutKey(question, missing)), missing).toBe(false);
  });

  it("keeps a scheduled challenge and word with every field", () => {
    const cover = { coveredDays: 1, coveredPeriods: 1, warn: false };
    const challenge = {
      id: 3,
      startsOn: "2026-11-01",
      questions: [QUESTION],
      sponsor: option,
      finishes: 2,
    };
    const word = { id: 4, language: "ar", startsOn: "2026-11-01", word: "كتابة", finishes: 0 };
    const read = {
      status: {
        challenge: { cadence: "daily", next: null, ...cover },
        word: { cadence: "daily", next: null, ar: cover, en: cover },
      },
      periods: [
        {
          kind: "challenge",
          startsOn: "2026-11-01",
          endsOn: "2026-11-01",
          challenge,
        },
        {
          kind: "word",
          startsOn: "2026-11-01",
          endsOn: "2026-11-01",
          words: { ar: word, en: { ...word, id: 5, language: "en", word: "crane" } },
        },
      ],
      unused: [],
    };
    expect(dailyConsoleSchema.parse(read)).toEqual(read);
    const inChallenge = (patch: object) =>
      set(read, ["periods"], [{ ...read.periods[0], challenge: { ...challenge, ...patch } }]);
    for (const key of Object.keys(challenge))
      expect(ok(dailyConsoleSchema, inChallenge({ [key]: undefined })), key).toBe(false);
    expect(ok(dailyConsoleSchema, inChallenge({ id: 0 }))).toBe(false);
    const inWord = (patch: object) =>
      set(read, ["periods"], [{ ...read.periods[1], words: { ar: { ...word, ...patch } } }]);
    for (const key of Object.keys(word))
      expect(ok(dailyConsoleSchema, inWord({ [key]: undefined })), key).toBe(false);
    expect(ok(dailyConsoleSchema, inWord({ language: "fr" }))).toBe(false);
    expect(ok(dailyConsoleSchema, inWord({ id: 0 }))).toBe(false);
  });
});

describe("the console's bodies, down to the messages", () => {
  const options = [
    { ar: "أ", en: "A" },
    { ar: "ب", en: "B" },
  ];

  it("points a right answer beyond the options at the answer field", () => {
    const body = { prompt: { ar: "س", en: "Q" }, options, answer: 3 };
    expect(messages(dailyQuestionBodySchema, body).map((issue) => issue.path)).toEqual([
      ["answer"],
    ]);
  });

  it("says why a text or a challenge is refused", () => {
    const bad = { prompt: { ar: `س${RLO}`, en: "Q" }, options, answer: 1 };
    expect(messages(dailyQuestionBodySchema, bad).map((issue) => issue.message)).toEqual([
      "must hold no control or direction characters",
    ]);
    const twice = [QUESTION, QUESTION, QUESTION.replace("01", "02")];
    expect(
      messages(dailyChallengeBodySchema, { questionIds: twice, sponsor: null }).map(
        (issue) => issue.message,
      ),
    ).toEqual(["three different questions"]);
  });

  it("marks only the whole string of five marks", () => {
    for (const bad of ["321000", "x21000", "2100x", "21000\n"])
      expect(ok(marksSchema, bad)).toBe(false);
  });

  it("takes list changes of words up to 40 characters, add and remove alike", () => {
    const long = "x".repeat(41);
    expect(wordListBodySchema.parse({ add: ["crane"], remove: ["slate"] })).toEqual({
      add: ["crane"],
      remove: ["slate"],
    });
    expect(ok(wordListBodySchema, { remove: ["x".repeat(40)] })).toBe(true);
    expect(ok(wordListBodySchema, { add: [long] })).toBe(false);
    expect(ok(wordListBodySchema, { remove: [long] })).toBe(false);
    expect(ok(wordListBodySchema, { remove: Array.from({ length: 20001 }, () => "crane") })).toBe(
      false,
    );
    expect(ok(wordListBodySchema, { remove: Array.from({ length: 20000 }, () => "crane") })).toBe(
      true,
    );
  });
});
