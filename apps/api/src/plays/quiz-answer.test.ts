import { describe, expect, it } from "vitest";
import { answerPaid, answerResultOf } from "#src/plays/quizzes";

describe("answerPaid", () => {
  const quiz = { total: 3, completionId: "c1" };

  it("pays on the last question of a quiz with its completion", () => {
    expect(answerPaid(quiz, { position: 3 }, false)).toBe(true);
  });

  it("does not pay on a replay", () => {
    expect(answerPaid(quiz, { position: 3 }, true)).toBe(false);
  });

  it("does not pay before the last question or for an unlisted question", () => {
    expect(answerPaid(quiz, { position: 2 }, false)).toBe(false);
    expect(answerPaid(quiz, undefined, false)).toBe(false);
  });

  it("does not pay without a completion", () => {
    expect(answerPaid({ total: 3, completionId: null }, { position: 3 }, false)).toBe(false);
  });
});

describe("answerResultOf", () => {
  it("reports the answered question's verdict and right choice", () => {
    expect(answerResultOf({ right: true, rightChoiceId: "b" }, false)).toEqual({
      right: true,
      rightChoiceId: "b",
      replayed: false,
    });
    expect(answerResultOf({ right: false, rightChoiceId: "c" }, true)).toEqual({
      right: false,
      rightChoiceId: "c",
      replayed: true,
    });
  });

  it("reads an unlisted question as wrong with no right choice", () => {
    expect(answerResultOf(undefined, false)).toEqual({
      right: false,
      rightChoiceId: "",
      replayed: false,
    });
  });
});
