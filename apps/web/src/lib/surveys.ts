import type { SurveyCsvLabels } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** One question's results, as `GET …/events/{id}/quests/{qid}/survey` gives them (T-303, ADR-198). */
export type SurveyQuestionResult = Readonly<{
  id: string;
  kind: "choice" | "rating" | "text";
  text: Text;
  answered: number;
  choices: readonly Readonly<{ id: string; text: Text; count: number }>[] | null;
  average: number | null;
  texts: readonly string[] | null;
}>;

/** A survey's results for the team, names not shown. */
export type SurveyResults = Readonly<{ total: number; questions: readonly SurveyQuestionResult[] }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isChoiceCount = (value: unknown) =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isText(value["text"]) &&
  typeof value["count"] === "number";

const isTexts = (value: unknown) =>
  value === null || (Array.isArray(value) && value.every((text) => typeof text === "string"));

const isQuestion = (value: unknown): value is SurveyQuestionResult =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  ["choice", "rating", "text"].includes(String(value["kind"])) &&
  isText(value["text"]) &&
  typeof value["answered"] === "number" &&
  (value["choices"] === null ||
    (Array.isArray(value["choices"]) && value["choices"].every(isChoiceCount))) &&
  (value["average"] === null || typeof value["average"] === "number") &&
  isTexts(value["texts"]);

/** Reads the results; anything malformed reads as nothing, so the panel stays hidden rather than guessing. */
export function surveyResultsOf(body: unknown): SurveyResults | undefined {
  if (
    !isRecord(body) ||
    typeof body["total"] !== "number" ||
    !Array.isArray(body["questions"]) ||
    !body["questions"].every(isQuestion)
  ) {
    return undefined;
  }
  return { total: body["total"], questions: body["questions"] };
}

/** The spreadsheet's words in the dashboard's language (FR-1624). */
export function surveyCsvLabels(t: Translate): SurveyCsvLabels {
  return {
    question: t("surveyResults.csv.question"),
    kind: t("surveyResults.csv.kind"),
    answer: t("surveyResults.csv.answer"),
    count: t("surveyResults.csv.count"),
    choice: t("surveyResults.csv.choice"),
    rating: t("surveyResults.csv.rating"),
    text: t("surveyResults.csv.text"),
    average: t("surveyResults.csv.average"),
    responses: t("surveyResults.csv.responses"),
    noAnswers: t("surveyResults.csv.noAnswers"),
  };
}
