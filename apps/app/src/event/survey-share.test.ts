import { describe, expect, it } from "vitest";
import {
  answersOf,
  missingAnswers,
  shareText,
  shareViewOf,
  shared,
  surveyPaidOf,
  surveyViewOf,
  type SurveyQuestion,
} from "#src/event/survey-share.ts";

const text = (en: string) => ({ ar: null, en });
const questions: SurveyQuestion[] = [
  {
    id: "fav",
    kind: "choice",
    text: text("Favourite?"),
    required: true,
    choices: [{ id: "ai", text: text("AI") }],
  },
  { id: "stars", kind: "rating", text: text("How was it?"), required: true, choices: null },
  { id: "note", kind: "text", text: text("Anything else?"), required: false, choices: null },
];
const ok = (body: unknown) => ({ kind: "ok" as const, status: 201, body, headers: new Headers() });
const error = (code: string, details: Record<string, unknown> = {}) => ({
  kind: "error" as const,
  status: 422,
  code,
  message: { ar: "ع", en: "e" },
  details,
  headers: new Headers(),
});

describe("the survey form (T-303, FR-214)", () => {
  it("reads the questions and refuses a body that is not one", () => {
    expect(surveyViewOf({ questions, answered: false })).toEqual({ questions, answered: false });
    expect(surveyViewOf({ questions: [{ ...questions[0], kind: "stars" }], answered: false })).toBe(
      undefined,
    );
    expect(surveyViewOf({ questions: [{ ...questions[0], choices: "x" }], answered: false })).toBe(
      undefined,
    );
    expect(surveyViewOf({ questions })).toBeUndefined();
    expect(surveyViewOf(null)).toBeUndefined();
  });

  it("names the required questions still unanswered, blank text included", () => {
    expect(missingAnswers(questions, {})).toEqual(["fav", "stars"]);
    expect(missingAnswers(questions, { fav: "ai", stars: 3 })).toEqual([]);
    const strict = questions.map((question) => ({ ...question, required: true }));
    expect(missingAnswers(strict, { fav: "ai", stars: 3, note: "  " })).toEqual(["note"]);
  });

  it("sends only what was answered, text trimmed", () => {
    expect(answersOf(questions, { fav: "ai", stars: 4, note: "  Great  " })).toEqual({
      fav: "ai",
      stars: 4,
      note: "Great",
    });
    expect(answersOf(questions, { fav: "ai", stars: 4, note: " " })).toEqual({
      fav: "ai",
      stars: 4,
    });
  });

  it("points a refused answer at its question", () => {
    expect(surveyPaidOf(error("bad_answer", { question: "note" }))).toMatchObject({
      kind: "refused",
      code: "bad_answer",
      question: "note",
    });
    expect(surveyPaidOf(error("bad_answer"))).not.toHaveProperty("question");
    expect(surveyPaidOf(error("already_completed"))).not.toHaveProperty("question");
    expect(surveyPaidOf(ok({ points: 20, levelUp: null }))).toEqual({
      kind: "voted",
      points: 20,
      levelUp: null,
      bonus: null,
      item: null,
      boost: null,
      firstBonus: null,
    });
  });
});

describe("the share (T-303, FR-220)", () => {
  it("reads the organizer's message and link", () => {
    const view = { message: text("Join us"), link: "https://example.com", done: false };
    expect(shareViewOf(view)).toEqual(view);
    expect(shareViewOf({ ...view, link: null })).toMatchObject({ link: null });
    expect(shareViewOf({ ...view, done: "no" })).toBeUndefined();
    expect(shareViewOf({ ...view, link: 3 })).toBeUndefined();
  });

  it("puts the link on its own line and pays only a completed share", () => {
    expect(shareText("Join us", "https://example.com")).toBe("Join us\nhttps://example.com");
    expect(shareText("Join us", null)).toBe("Join us");
    expect(shared("sharedAction")).toBe(true);
    expect(shared("dismissedAction")).toBe(false);
  });
});
