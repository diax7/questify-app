import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "#src/http-error";
import {
  answerQuestion,
  finishDueQuizzes,
  nextQuestion,
  readQuiz,
  startQuiz,
} from "#src/plays/quizzes";
import { refuse } from "#src/plays/routes";
import { run, textOf, type PlayRefusal } from "#src/plays/run";

type Answer = (sql: string, values: unknown[]) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each call through `answer`, keeping each statement (T-302 mutation follow-up). */
function fakePool(answer: Answer) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      statements.push(sql);
      const rows = answer(sql, values);
      if (rows instanceof Error) {
        throw rows;
      }
      return { rows };
    }),
    release: vi.fn(),
  };
  return { deps: { pool: { connect: async () => client } as unknown as Pool }, statements };
}

const pgError = (code?: string, detail?: string) =>
  Object.assign(new Error("database refusal"), { code, detail });

const PLAYER = "11111111-1111-4111-8111-111111111111";
const QUEST = "22222222-2222-4222-8222-222222222222";
const STEP = { playerId: PLAYER, questId: QUEST };
const NOW = new Date("2030-01-01T10:00:00Z");

const refusalOf = async (error: Error) =>
  run(fakePool(() => []).deps, {}, async () => {
    throw error;
  });

describe("run", () => {
  it("answers the work's value as done", async () => {
    const { deps } = fakePool(() => []);
    expect(await run(deps, { playerId: PLAYER }, async () => 7)).toEqual({
      kind: "done",
      value: 7,
    });
  });

  it("turns each database refusal into its result", async () => {
    const cases: [string, string | undefined, PlayRefusal][] = [
      ["QC404", undefined, { kind: "not_found" }],
      ["AQ404", undefined, { kind: "not_found" }],
      ["AN404", undefined, { kind: "not_found" }],
      ["QC403", "banned", { kind: "enrollment_inactive", reason: "banned" }],
      ["QC403", undefined, { kind: "enrollment_inactive", reason: "" }],
      ["QN403", "ended", { kind: "quest_not_open", reason: "ended" }],
      ["QP403", undefined, { kind: "operator_not_playing" }],
      ["QT422", "vote", { kind: "not_vote_quest" }],
      ["QT422", "quiz", { kind: "not_quiz_quest" }],
      ["QT422", "survey", { kind: "not_survey_quest" }],
      ["QT422", "share", { kind: "not_share_quest" }],
      ["SA422", "fav", { kind: "bad_answer", question: "fav" }],
      ["QF403", undefined, { kind: "feature_off" }],
      ["PF403", "feature_off", { kind: "feature_off" }],
      ["VO422", undefined, { kind: "unknown_option" }],
      ["VC422", "too_many_choices", { kind: "too_many_choices" }],
      ["QO422", undefined, { kind: "unknown_option" }],
      ["QD409", "1", { kind: "already_completed" }],
      ["QK422", undefined, { kind: "key_reused" }],
      ["QA404", undefined, { kind: "quiz_not_started" }],
      ["QA409", "answered", { kind: "already_answered" }],
      ["QA409", "closed", { kind: "question_closed" }],
      ["QA409", "not_served", { kind: "question_not_served" }],
    ];
    for (const [code, detail, expected] of cases) {
      expect(await refusalOf(pgError(code, detail)), `${code}:${detail}`).toEqual(expected);
    }
  });

  it("throws anything that is not a known refusal", async () => {
    for (const error of [
      pgError(),
      pgError("23505"),
      pgError("QT422", "submission"),
      pgError("QA409", "other"),
    ]) {
      await expect(refusalOf(error)).rejects.toBe(error);
    }
  });
});

describe("textOf", () => {
  it("keeps each language written and nulls the rest", () => {
    expect(textOf(undefined)).toEqual({ ar: null, en: null });
    expect(textOf(null)).toEqual({ ar: null, en: null });
    expect(textOf({ ar: "سؤال" })).toEqual({ ar: "سؤال", en: null });
    expect(textOf({ en: "Question" })).toEqual({ ar: null, en: "Question" });
    expect(textOf({ ar: "سؤال", en: "Question" })).toEqual({ ar: "سؤال", en: "Question" });
  });
});

const answerOf = (result: PlayRefusal, voting?: boolean) => {
  try {
    refuse(result, voting);
  } catch (error) {
    const http = error as HttpError;
    expect(http).toBeInstanceOf(HttpError);
    return [http.status, http.envelope.code, http.envelope.details];
  }
  throw new Error("refuse returned");
};

describe("refuse", () => {
  it("answers each refusal with its status, code and details", () => {
    const cases: [PlayRefusal, number, string, object][] = [
      [{ kind: "not_found" }, 404, "not_found", {}],
      [
        { kind: "enrollment_inactive", reason: "banned" },
        403,
        "enrollment_inactive",
        { reason: "banned" },
      ],
      [{ kind: "quest_not_open", reason: "ended" }, 403, "quest_not_open", { reason: "ended" }],
      [{ kind: "operator_not_playing" }, 403, "operator_play_off", {}],
      [{ kind: "not_vote_quest" }, 422, "not_vote_quest", {}],
      [{ kind: "not_quiz_quest" }, 422, "not_quiz_quest", {}],
      [{ kind: "not_survey_quest" }, 422, "not_survey_quest", {}],
      [{ kind: "not_share_quest" }, 422, "not_share_quest", {}],
      [{ kind: "not_passport_quest" }, 422, "not_passport_quest", {}],
      [{ kind: "not_meet_quest" }, 422, "not_meet_quest", {}],
      [{ kind: "not_game_quest" }, 422, "not_game_quest", {}],
      [{ kind: "bad_answer", question: "fav" }, 422, "bad_answer", { question: "fav" }],
      [{ kind: "unknown_option" }, 422, "unknown_option", {}],
      [{ kind: "too_many_choices" }, 422, "too_many_choices", {}],
      [{ kind: "already_completed" }, 409, "already_completed", {}],
      [{ kind: "key_reused" }, 422, "idempotency_key_reused", {}],
      [{ kind: "quiz_not_started" }, 404, "quiz_not_started", {}],
      [{ kind: "already_answered" }, 409, "already_answered", {}],
      [{ kind: "question_closed" }, 409, "question_closed", {}],
      [{ kind: "question_not_served" }, 409, "question_not_served", {}],
    ];
    for (const [result, status, code, details] of cases) {
      expect(answerOf(result), result.kind).toEqual([status, code, details]);
    }
    expect(answerOf({ kind: "feature_off" })[1]).toBe("feature_off");
  });

  it("calls a vote's spent cap already voted, and nothing else", () => {
    expect(answerOf({ kind: "already_completed" }, true)[1]).toBe("already_voted");
    expect(answerOf({ kind: "already_completed" }, false)[1]).toBe("already_completed");
    expect(answerOf({ kind: "key_reused" }, true)[1]).toBe("idempotency_key_reused");
  });
});

const QUESTION = {
  position: 1,
  id: "q1",
  text: { en: "Which?" },
  choices: [
    { id: "r", text: { ar: "صح", en: "Right" } },
    { id: "w", text: { en: "Wrong" } },
  ],
};
const quizRow = (overrides: Record<string, unknown> = {}) => ({
  status: "open",
  total: 2,
  points_each: 10,
  timer_seconds: 30,
  right_count: 0,
  earned: "0",
  completion_id: null,
  server_now: NOW,
  current: null,
  answered: [],
  ...overrides,
});
const answered = (overrides: Record<string, unknown> = {}) => ({
  ...QUESTION,
  choiceId: "w",
  rightChoiceId: "r",
  right: false,
  closed: false,
  ...overrides,
});

/** A quiz database: `member_quiz` answers `row`, `own_level` a level 3 for a paid quiz, the step its `step` rows. */
const quizDb = (row: Record<string, unknown> | undefined, step: Record<string, unknown>[] = []) =>
  fakePool((sql) => {
    if (sql.includes("member_quiz")) {
      return row === undefined ? [] : [row];
    }
    if (sql.includes("own_level")) {
      return [{ level_up: 3, up_title_ar: "مستكشف", up_title_en: "Explorer" }];
    }
    if (sql.includes("own_category_bonus")) {
      return [{ category_id: "c1", points: "40", name_ar: "المرحلة", name_en: null }];
    }
    return step;
  });

describe("readQuiz", () => {
  it("reads the served question with its time, and the answered ones with the right answer", async () => {
    const { deps } = quizDb(
      quizRow({
        current: { ...QUESTION, position: 2, id: "q2", servedAt: "S", closesAt: "C" },
        answered: [answered(), answered({ id: "q0", choiceId: null, right: true, closed: true })],
      }),
    );
    expect(await readQuiz(deps, PLAYER, QUEST)).toEqual({
      kind: "done",
      value: {
        status: "open",
        total: 2,
        pointsEach: 10,
        timerSeconds: 30,
        rightCount: 0,
        earned: 0,
        completionId: null,
        serverNow: NOW,
        current: {
          position: 2,
          id: "q2",
          text: { ar: null, en: "Which?" },
          choices: [
            { id: "r", text: { ar: "صح", en: "Right" } },
            { id: "w", text: { ar: null, en: "Wrong" } },
          ],
          servedAt: "S",
          closesAt: "C",
        },
        answered: [
          expect.objectContaining({ id: "q1", choiceId: "w", right: false, closed: false }),
          expect.objectContaining({ id: "q0", choiceId: null, right: true, closed: true }),
        ],
      },
    });
  });

  it("reads a question without a timer and one without choices", async () => {
    const { deps } = quizDb(
      quizRow({ current: { ...QUESTION, choices: null, servedAt: "S", closesAt: null } }),
    );
    const read = await readQuiz(deps, PLAYER, QUEST);
    expect(read.kind === "done" && read.value.current).toMatchObject({
      choices: [],
      closesAt: null,
    });
  });

  it("is not found when the player may not play it, and passes a refusal on", async () => {
    expect(await readQuiz(quizDb(undefined).deps, PLAYER, QUEST)).toEqual({ kind: "not_found" });
    const refused = fakePool(() => pgError("QC403", "banned")).deps;
    expect(await readQuiz(refused, PLAYER, QUEST)).toEqual({
      kind: "enrollment_inactive",
      reason: "banned",
    });
  });
});

describe("quiz steps", () => {
  it("reads no level before the quiz pays, and the level its payment reached after", async () => {
    const open = quizDb(quizRow());
    expect(await startQuiz(open.deps, STEP)).toMatchObject({
      kind: "done",
      value: { levelUp: null, paid: false },
    });
    expect(open.statements.some((sql) => sql.includes("own_level"))).toBe(false);
    const paid = quizDb(quizRow({ status: "finished", completion_id: "9" }), [{ outcome: "paid" }]);
    expect(await nextQuestion(paid.deps, STEP)).toMatchObject({
      kind: "done",
      value: {
        levelUp: { level: 3, title: { ar: "مستكشف", en: "Explorer" } },
        bonus: { categoryId: "c1", points: 40, category: { ar: "المرحلة", en: null } },
        paid: true,
      },
    });
    expect(await startQuiz(open.deps, STEP)).toMatchObject({ value: { bonus: null } });
    expect(open.statements.some((sql) => sql.includes("own_category_bonus"))).toBe(false);
    const served = quizDb(quizRow(), [{ outcome: "served" }]);
    expect(await nextQuestion(served.deps, STEP)).toMatchObject({ value: { paid: false } });
    expect(await nextQuestion(quizDb(quizRow(), []).deps, STEP)).toMatchObject({
      value: { paid: false },
    });
  });

  const answer = { ...STEP, questionId: "q1", choiceId: "w" };

  it("answers with the right answer, and pays only on the last question's first answer", async () => {
    const first = quizDb(quizRow({ answered: [answered()] }), [{ replayed: false }]);
    expect(await answerQuestion(first.deps, answer)).toMatchObject({
      value: { paid: false, result: { right: false, rightChoiceId: "r", replayed: false } },
    });
    const finished = quizRow({
      status: "finished",
      completion_id: "9",
      answered: [answered({ position: 2, choiceId: "r", right: true })],
    });
    expect(
      await answerQuestion(quizDb(finished, [{ replayed: false }]).deps, answer),
    ).toMatchObject({
      value: { paid: true, result: { right: true, rightChoiceId: "r", replayed: false } },
    });
    expect(await answerQuestion(quizDb(finished, [{ replayed: true }]).deps, answer)).toMatchObject(
      { value: { paid: false, result: { replayed: true } } },
    );
  });

  it("answers nothing right when the question is not among the answered ones", async () => {
    const { deps } = quizDb(quizRow({ answered: [answered({ id: "other", right: true })] }), []);
    expect(await answerQuestion(deps, answer)).toMatchObject({
      value: { paid: false, result: { right: false, rightChoiceId: "", replayed: false } },
    });
  });
});

describe("finishDueQuizzes", () => {
  it("finishes one at a time until none is due", async () => {
    let left = 3;
    const { deps } = fakePool(() => {
      left -= 1;
      return left >= 0 ? [{ outcome: "paid" }] : [{ outcome: null }];
    });
    expect(await finishDueQuizzes(deps)).toBe(3);
    expect(await finishDueQuizzes(fakePool(() => []).deps)).toBe(0);
  });

  it("stops at 50 a tick, and at a refusal", async () => {
    expect(await finishDueQuizzes(fakePool(() => [{ outcome: "void" }]).deps)).toBe(50);
    expect(await finishDueQuizzes(fakePool(() => pgError("QC404")).deps)).toBe(0);
  });
});
