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
const rating = { ...choice, id: "stars", kind: "rating", choices: null, average: 4.5 };
const written = { ...choice, id: "note", kind: "text", choices: null, texts: ["Great"] };

describe("survey results, one broken part at a time", () => {
  it.each([
    ["a question without a text id", { ...rating, id: 1 }],
    ["a question text of the wrong shape", { ...rating, text: { ar: 1, en: null } }],
    ["a question text missing en", { ...rating, text: { ar: null } }],
    ["an answered count that is text", { ...rating, answered: "2" }],
    ["choices that are not a list", { ...choice, choices: "AI" }],
    ["a choice without an id", { ...choice, choices: [{ text: text("AI"), count: 2 }] }],
    ["a choice text that is not a text", { ...choice, choices: [{ id: "a", text: 1, count: 2 }] }],
    ["choices missing", { ...rating, choices: undefined }],
    ["an average missing", { ...rating, average: undefined }],
    ["texts that are not a list", { ...written, texts: "Great" }],
    ["texts missing", { ...written, texts: undefined }],
    ["a question that is not an object", "q"],
  ])("reads %s as nothing", (_name, question) => {
    expect(surveyResultsOf({ total: 1, questions: [question] })).toBeUndefined();
  });

  it("reads each valid kind and refuses a total or list of the wrong type", () => {
    const all = { total: 1, questions: [choice, rating, written] };
    expect(surveyResultsOf(all)).toEqual(all);
    expect(surveyResultsOf({ total: "2", questions: [] })).toBeUndefined();
    expect(surveyResultsOf({ total: 2, questions: {} })).toBeUndefined();
    expect(surveyResultsOf("results")).toBeUndefined();
  });
});
