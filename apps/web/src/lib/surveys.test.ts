import { describe, expect, it } from "vitest";
import { surveyResultsOf } from "#src/lib/surveys.ts";

const text = (en: string) => ({ ar: null, en });
const choice = {
  id: "fav",
  kind: "choice",
  text: text("Favourite?"),
  answered: 2,
  choices: [{ id: "ai", text: text("AI"), count: 2 }],
  average: null,
  texts: null,
};
const rating = {
  id: "stars",
  kind: "rating",
  text: text("Rate"),
  answered: 2,
  choices: null,
  average: 4.5,
  texts: null,
};
const written = {
  id: "note",
  kind: "text",
  text: text("Notes"),
  answered: 1,
  choices: null,
  average: null,
  texts: ["Great"],
};
const results = { total: 2, questions: [choice, rating, written] };

describe("survey results (T-303)", () => {
  it("reads the totals, counts, averages and texts", () => {
    expect(surveyResultsOf(results)).toEqual(results);
    expect(surveyResultsOf({ total: 0, questions: [] })).toEqual({ total: 0, questions: [] });
  });

  it.each([
    ["no total", { questions: [] }],
    ["an unknown kind", { total: 1, questions: [{ ...rating, kind: "stars" }] }],
    [
      "a count that is text",
      { total: 1, questions: [{ ...choice, choices: [{ id: "a", text: text("A"), count: "2" }] }] },
    ],
    ["an average that is text", { total: 1, questions: [{ ...rating, average: "4" }] }],
    ["a text that is a number", { total: 1, questions: [{ ...written, texts: [3] }] }],
    ["nothing", null],
  ])("reads %s as nothing", (_name, body) => {
    expect(surveyResultsOf(body)).toBeUndefined();
  });
});
