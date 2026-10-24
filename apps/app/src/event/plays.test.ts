import { describe, expect, it } from "vitest";
import {
  REVEAL_WAIT_MS,
  announces,
  quizStage,
  quizStepOf,
  quizViewOf,
  secondsLeft,
  voteViewOf,
  votedOf,
  type QuizView,
} from "#src/event/plays.ts";

const text = (en: string) => ({ ar: null, en });
const choices = [
  { id: "r", text: text("Right") },
  { id: "w", text: text("Wrong") },
];
const question = {
  position: 1,
  id: "q1",
  text: text("Q1"),
  choices,
  closesAt: null,
  servedAt: "x",
};
const answered = {
  position: 1,
  id: "q1",
  text: text("Q1"),
  choices,
  choiceId: "w",
  rightChoiceId: "r",
  right: false,
  closed: false,
};
const quiz = (fields: Partial<QuizView> = {}) => ({
  status: "open" as QuizView["status"],
  total: 2,
  pointsEach: 10,
  timerSeconds: null,
  rightCount: 0,
  earned: 0,
  completionId: null,
  serverNow: "2030-01-01T10:00:00.000Z",
  current: null,
  answered: [],
  ...fields,
});

const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });
const refused = {
  kind: "error" as const,
  status: 409,
  code: "already_voted",
  message: { ar: "ع", en: "e" },
  details: {},
  headers: new Headers(),
};

describe("the vote", () => {
  it("reads the options and the player's choice, and refuses anything malformed", () => {
    expect(voteViewOf({ options: choices, mine: [] })).toEqual({ options: choices, mine: [] });
    expect(voteViewOf({ options: choices, mine: ["r", "w"] })?.mine).toEqual(["r", "w"]);
    expect(voteViewOf({ options: [{ id: 1 }], mine: [] })).toBeUndefined();
    expect(voteViewOf({ options: choices, mine: "r" })).toBeUndefined();
    expect(voteViewOf({ options: choices, mine: [3] })).toBeUndefined();
    expect(voteViewOf(null)).toBeUndefined();
  });

  it("answers a vote with its points, or the refusal's own words", () => {
    expect(votedOf(ok({ points: 25, levelUp: null }))).toEqual({
      kind: "voted",
      points: 25,
      levelUp: null,
      bonus: null,
      item: null,
      boost: null,
    });
    expect(votedOf(ok({ points: 50, boost: { multiplier: 2 } }))).toMatchObject({
      boost: { multiplier: 2 },
    });
    expect(votedOf(ok({ points: 50, boost: { multiplier: 1 } }))).toMatchObject({ boost: null });
    const bonus = { points: 40, category: { ar: null, en: "Stage" } };
    expect(votedOf(ok({ points: 25, bonus: { categoryId: "c", ...bonus } }))).toMatchObject({
      bonus,
    });
    expect(votedOf(ok({}))).toEqual({ kind: "network" });
    expect(votedOf(refused)).toEqual({
      kind: "refused",
      code: "already_voted",
      message: { ar: "ع", en: "e" },
    });
    expect(votedOf({ kind: "network" })).toEqual({ kind: "network" });
    expect(votedOf({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });
});

describe("the quiz", () => {
  it("reads the quiz, and refuses a malformed one", () => {
    expect(quizViewOf(quiz({ current: question }))?.current).toEqual({
      position: 1,
      id: "q1",
      text: text("Q1"),
      choices,
      closesAt: null,
    });
    expect(quizViewOf(quiz({ answered: [answered] }))?.answered).toEqual([answered]);
    expect(quizViewOf({ ...quiz(), status: "lost" })).toBeUndefined();
    expect(quizViewOf({ ...quiz(), total: "2" })).toBeUndefined();
    expect(quizViewOf({ ...quiz(), timerSeconds: "30" })).toBeUndefined();
    expect(quizViewOf({ ...quiz(), current: { id: "q1" } })).toBeUndefined();
    expect(quizViewOf({ ...quiz(), answered: [{ ...answered, right: "no" }] })).toBeUndefined();
    expect(quizViewOf({ ...quiz(), serverNow: 1 })).toBeUndefined();
    expect(quizViewOf("x")).toBeUndefined();
  });

  it("reads a step with its result, level and refusal", () => {
    const step = quizStepOf(
      ok({ quiz: quiz(), levelUp: null, result: { right: true, rightChoiceId: "r" }, rank: 1 }),
    );
    expect(step).toMatchObject({ kind: "quiz", result: { right: true, rightChoiceId: "r" } });
    expect(quizStepOf(ok({ quiz: quiz(), levelUp: null }))).toMatchObject({
      result: null,
      bonus: null,
    });
    expect(
      quizStepOf(ok({ quiz: quiz(), bonus: { points: 30, category: { ar: "عام", en: null } } })),
    ).toMatchObject({ bonus: { points: 30, category: { ar: "عام", en: null } } });
    expect(quizStepOf(ok({ quiz: {} }))).toEqual({ kind: "network" });
    expect(quizStepOf(refused)).toMatchObject({ kind: "refused", code: "already_voted" });
  });

  it("names the stage the sheet shows", () => {
    expect(quizStage(quiz({ status: "none" }))).toEqual({ kind: "intro" });
    expect(quizStage(quiz())).toEqual({ kind: "intro" });
    expect(quizStage(quiz({ current: question }))).toMatchObject({ kind: "question" });
    expect(quizStage(quiz({ answered: [answered] }))).toEqual({ kind: "reveal", answered });
    expect(quizStage(quiz({ status: "finished", rightCount: 1, earned: 10 }))).toEqual({
      kind: "result",
      rightCount: 1,
      earned: 10,
      void: false,
    });
    expect(quizStage(quiz({ status: "void", rightCount: 1, earned: 10 }))).toMatchObject({
      earned: 0,
      void: true,
    });
  });

  it("counts seconds on the server's clock, never below zero", () => {
    const clock = { serverNow: "2030-01-01T10:00:00.000Z", receivedAt: 1000 };
    // The phone's clock is far off; only the time since the answer arrived counts.
    expect(secondsLeft("2030-01-01T10:00:30.000Z", clock, 1000)).toBe(30);
    expect(secondsLeft("2030-01-01T10:00:30.000Z", clock, 11_500)).toBe(20);
    expect(secondsLeft("2030-01-01T10:00:30.000Z", clock, 99_000)).toBe(0);
    expect(secondsLeft(null, clock, 1000)).toBeNull();
    expect(REVEAL_WAIT_MS).toBe(2500);
  });

  it("announces the time every 10 seconds and at 5", () => {
    expect([30, 20, 10, 5].every(announces)).toBe(true);
    expect([29, 6, 4, 0].some(announces)).toBe(false);
    expect(announces(null)).toBe(false);
  });
});
