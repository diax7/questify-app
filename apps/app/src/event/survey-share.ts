import type { AuthedResult, Session } from "#src/api/session.ts";
import {
  votedOf,
  type PlayChoice,
  type PlayFailure,
  type PlayText,
  type Voted,
} from "#src/event/plays.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const nullableString = (value: unknown) => value === null || typeof value === "string";
const isText = (value: unknown): value is PlayText =>
  isRecord(value) && nullableString(value["ar"]) && nullableString(value["en"]);
const isChoices = (value: unknown): value is PlayChoice[] =>
  Array.isArray(value) &&
  value.every(
    (choice) => isRecord(choice) && typeof choice["id"] === "string" && isText(choice["text"]),
  );

// ================================================================ the survey (FR-214, ADR-198)

export type SurveyKind = "choice" | "rating" | "text";

export type SurveyQuestion = Readonly<{
  id: string;
  kind: SurveyKind;
  text: PlayText;
  required: boolean;
  choices: readonly PlayChoice[] | null;
}>;

export type SurveyView = Readonly<{ questions: readonly SurveyQuestion[]; answered: boolean }>;

/** The ratings a survey takes, lowest first. */
export const RATINGS = [1, 2, 3, 4, 5] as const;

const KINDS: readonly string[] = ["choice", "rating", "text"];

const surveyQuestionOf = (value: unknown): SurveyQuestion | undefined => {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["kind"] !== "string" ||
    !KINDS.includes(value["kind"]) ||
    !isText(value["text"]) ||
    typeof value["required"] !== "boolean" ||
    !(value["choices"] === null || isChoices(value["choices"]))
  ) {
    return undefined;
  }
  return {
    id: value["id"],
    kind: value["kind"] as SurveyKind,
    text: value["text"],
    required: value["required"],
    choices: value["choices"] as PlayChoice[] | null,
  };
};

export function surveyViewOf(body: unknown): SurveyView | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body["questions"]) ||
    typeof body["answered"] !== "boolean"
  ) {
    return undefined;
  }
  const questions = body["questions"].map(surveyQuestionOf);
  if (questions.some((question) => question === undefined)) {
    return undefined;
  }
  return { questions: questions as SurveyQuestion[], answered: body["answered"] };
}

/** What the player has written or picked so far, by question id. */
export type SurveyDraft = Readonly<Record<string, string | number | undefined>>;

const blank = (value: string | number | undefined) =>
  value === undefined || (typeof value === "string" && value.trim() === "");

/** The required questions still unanswered (blank text counts as unanswered, as on the server). */
export function missingAnswers(questions: readonly SurveyQuestion[], draft: SurveyDraft): string[] {
  return questions
    .filter((question) => question.required && blank(draft[question.id]))
    .map((question) => question.id);
}

/** The answers to send: only the answered questions, text trimmed. */
export function answersOf(
  questions: readonly SurveyQuestion[],
  draft: SurveyDraft,
): Record<string, string | number> {
  const answers: Record<string, string | number> = {};
  for (const question of questions) {
    const value = draft[question.id];
    if (!blank(value) && value !== undefined) {
      answers[question.id] = typeof value === "string" ? value.trim() : value;
    }
  }
  return answers;
}

/** A refused answer names its question (`bad_answer`), so the form can point at it. */
export type SurveyFailure = PlayFailure & Readonly<{ question?: string }>;

export function surveyPaidOf(answer: AuthedResult): Voted | SurveyFailure {
  const paid = votedOf(answer);
  if (answer.kind === "error" && answer.code === "bad_answer" && isRecord(answer.details)) {
    const question = answer.details["question"];
    return typeof question === "string" ? ({ ...paid, question } as SurveyFailure) : paid;
  }
  return paid;
}

const path = (questId: string, play: "survey" | "share") =>
  `/v1/quests/${encodeURIComponent(questId)}/${play}`;

export async function fetchSurvey(
  session: Pick<Session, "request">,
  questId: string,
): Promise<SurveyView | undefined> {
  const answer = await session.request({ method: "GET", path: path(questId, "survey") });
  return answer.kind === "ok" ? surveyViewOf(answer.body) : undefined;
}

export async function sendSurvey(
  session: Pick<Session, "request">,
  questId: string,
  answers: Record<string, string | number>,
  key: string,
): Promise<Voted | SurveyFailure> {
  return surveyPaidOf(
    await session.request({
      method: "POST",
      path: path(questId, "survey"),
      body: { answers },
      headers: { "idempotency-key": key },
    }),
  );
}

// ================================================================ the share (FR-220, ADR-199)

export type ShareView = Readonly<{ message: PlayText; link: string | null; done: boolean }>;

export function shareViewOf(body: unknown): ShareView | undefined {
  if (
    !isRecord(body) ||
    !isText(body["message"]) ||
    !nullableString(body["link"]) ||
    typeof body["done"] !== "boolean"
  ) {
    return undefined;
  }
  return { message: body["message"], link: body["link"] as string | null, done: body["done"] };
}

/** What goes to the share sheet: the organizer's message, and the link on its own line. */
export function shareText(message: string, link: string | null): string {
  return link === null ? message : `${message}\n${link}`;
}

/** The share sheet's answer pays only when the player shared (`sharedAction`); a dismissed sheet pays nothing. */
export const shared = (action: string): boolean => action === "sharedAction";

export async function fetchShare(
  session: Pick<Session, "request">,
  questId: string,
): Promise<ShareView | undefined> {
  const answer = await session.request({ method: "GET", path: path(questId, "share") });
  return answer.kind === "ok" ? shareViewOf(answer.body) : undefined;
}

export async function sendShare(
  session: Pick<Session, "request">,
  questId: string,
  key: string,
): Promise<Voted | PlayFailure> {
  return votedOf(
    await session.request({
      method: "POST",
      path: path(questId, "share"),
      body: {},
      headers: { "idempotency-key": key },
    }),
  );
}
