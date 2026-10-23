import { QUIZ_GRACE_SECONDS, type LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import { bonusOf, type Bonus } from "#src/event/quests-api.ts";
import { levelUpOf, type LevelUp } from "#src/questify/level.ts";

/** Organizer text as the API sends it: null where a language was not written. */
export type PlayText = Readonly<{ ar: string | null; en: string | null }>;
export type PlayChoice = Readonly<{ id: string; text: PlayText }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const nullableString = (value: unknown) => value === null || typeof value === "string";
const isText = (value: unknown): value is PlayText =>
  isRecord(value) && nullableString(value["ar"]) && nullableString(value["en"]);
const isChoice = (value: unknown): value is PlayChoice =>
  isRecord(value) && typeof value["id"] === "string" && isText(value["text"]);
const isChoices = (value: unknown): value is PlayChoice[] =>
  Array.isArray(value) && value.every(isChoice);

/** The play's outcome in the sheet's words; a refusal carries the server's own message. */
export type PlayFailure =
  | Readonly<{ kind: "refused"; code: string; message: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const failureOf = (answer: Exclude<AuthedResult, { kind: "ok" }>): PlayFailure =>
  answer.kind === "error"
    ? { kind: "refused", code: answer.code, message: answer.message }
    : { kind: answer.kind };

// ================================================================ the vote

export type VoteView = Readonly<{ options: readonly PlayChoice[]; mine: string | null }>;

export function voteViewOf(body: unknown): VoteView | undefined {
  if (!isRecord(body) || !isChoices(body["options"]) || !nullableString(body["mine"])) {
    return undefined;
  }
  return { options: body["options"], mine: body["mine"] as string | null };
}

export type Voted = Readonly<{
  kind: "voted";
  points: number;
  levelUp: LevelUp | null;
  /** The category bonus this vote paid (T-304), or null. */
  bonus: Bonus | null;
}>;

export function votedOf(answer: AuthedResult): Voted | PlayFailure {
  if (answer.kind !== "ok") {
    return failureOf(answer);
  }
  const body = answer.body;
  if (!isRecord(body) || typeof body["points"] !== "number") {
    return { kind: "network" };
  }
  return {
    kind: "voted",
    points: body["points"],
    levelUp: levelUpOf(body["levelUp"]),
    bonus: bonusOf(body["bonus"]),
  };
}

export async function fetchVote(
  session: Pick<Session, "request">,
  questId: string,
): Promise<VoteView | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/quests/${encodeURIComponent(questId)}/vote`,
  });
  return answer.kind === "ok" ? voteViewOf(answer.body) : undefined;
}

export async function castVote(
  session: Pick<Session, "request">,
  questId: string,
  optionId: string,
  key: string,
): Promise<Voted | PlayFailure> {
  return votedOf(
    await session.request({
      method: "POST",
      path: `/v1/quests/${encodeURIComponent(questId)}/vote`,
      body: { optionId },
      headers: { "idempotency-key": key },
    }),
  );
}

// ================================================================ the quiz

export type QuizQuestion = Readonly<{
  position: number;
  id: string;
  text: PlayText;
  choices: readonly PlayChoice[];
  closesAt: string | null;
}>;

export type QuizAnswered = Readonly<{
  position: number;
  id: string;
  text: PlayText;
  choices: readonly PlayChoice[];
  choiceId: string | null;
  rightChoiceId: string;
  right: boolean;
  closed: boolean;
}>;

export type QuizView = Readonly<{
  status: "none" | "open" | "finished" | "void";
  total: number;
  pointsEach: number;
  timerSeconds: number | null;
  rightCount: number;
  earned: number;
  serverNow: string;
  current: QuizQuestion | null;
  answered: readonly QuizAnswered[];
}>;

const STATUSES = ["none", "open", "finished", "void"] as const;

const questionOf = (value: unknown): QuizQuestion | undefined =>
  isRecord(value) &&
  typeof value["position"] === "number" &&
  typeof value["id"] === "string" &&
  isText(value["text"]) &&
  isChoices(value["choices"]) &&
  nullableString(value["closesAt"])
    ? {
        position: value["position"],
        id: value["id"],
        text: value["text"],
        choices: value["choices"],
        closesAt: value["closesAt"] as string | null,
      }
    : undefined;

const isAnswered = (value: unknown): value is QuizAnswered =>
  isRecord(value) &&
  typeof value["position"] === "number" &&
  typeof value["id"] === "string" &&
  isText(value["text"]) &&
  isChoices(value["choices"]) &&
  nullableString(value["choiceId"]) &&
  typeof value["rightChoiceId"] === "string" &&
  typeof value["right"] === "boolean" &&
  typeof value["closed"] === "boolean";

const NUMBERS = ["total", "pointsEach", "rightCount", "earned"] as const;

/** Reads the quiz; anything malformed reads as nothing, so the sheet shows a load failure, not a guess. */
export function quizViewOf(body: unknown): QuizView | undefined {
  if (
    !isRecord(body) ||
    !(STATUSES as readonly unknown[]).includes(body["status"]) ||
    !NUMBERS.every((name) => typeof body[name] === "number") ||
    !(body["timerSeconds"] === null || typeof body["timerSeconds"] === "number") ||
    typeof body["serverNow"] !== "string" ||
    !Array.isArray(body["answered"]) ||
    !body["answered"].every(isAnswered)
  ) {
    return undefined;
  }
  const current = body["current"] === null ? null : questionOf(body["current"]);
  if (current === undefined) {
    return undefined;
  }
  return {
    status: body["status"] as QuizView["status"],
    total: body["total"] as number,
    pointsEach: body["pointsEach"] as number,
    timerSeconds: body["timerSeconds"] as number | null,
    rightCount: body["rightCount"] as number,
    earned: body["earned"] as number,
    serverNow: body["serverNow"],
    current,
    answered: body["answered"],
  };
}

export type QuizStep = Readonly<{
  kind: "quiz";
  quiz: QuizView;
  levelUp: LevelUp | null;
  /** The category bonus the finished quiz paid, also with no right answers (T-304), or null. */
  bonus: Bonus | null;
  /** Set on an answer: whether it was right and the right choice (FR-209). */
  result: Readonly<{ right: boolean; rightChoiceId: string }> | null;
}>;

export function quizStepOf(answer: AuthedResult): QuizStep | PlayFailure {
  if (answer.kind !== "ok") {
    return failureOf(answer);
  }
  const body = answer.body;
  const quiz = isRecord(body) ? quizViewOf(body["quiz"]) : undefined;
  if (!isRecord(body) || quiz === undefined) {
    return { kind: "network" };
  }
  const result = body["result"];
  return {
    kind: "quiz",
    quiz,
    levelUp: levelUpOf(body["levelUp"]),
    bonus: bonusOf(body["bonus"]),
    result:
      isRecord(result) &&
      typeof result["right"] === "boolean" &&
      typeof result["rightChoiceId"] === "string"
        ? { right: result["right"], rightChoiceId: result["rightChoiceId"] }
        : null,
  };
}

/** What the quiz sheet shows now. */
export type QuizStage =
  | Readonly<{ kind: "intro" }>
  | Readonly<{ kind: "question"; question: QuizQuestion }>
  /** The last question was answered or closed: its right answer shows, and Next serves the one after. */
  | Readonly<{ kind: "reveal"; answered: QuizAnswered }>
  | Readonly<{ kind: "result"; rightCount: number; earned: number; void: boolean }>;

export function quizStage(quiz: QuizView): QuizStage {
  if (quiz.status === "none") {
    return { kind: "intro" };
  }
  if (quiz.status === "finished" || quiz.status === "void") {
    return {
      kind: "result",
      rightCount: quiz.rightCount,
      earned: quiz.status === "void" ? 0 : quiz.earned,
      void: quiz.status === "void",
    };
  }
  if (quiz.current !== null) {
    return { kind: "question", question: quiz.current };
  }
  const last = quiz.answered.at(-1);
  return last === undefined ? { kind: "intro" } : { kind: "reveal", answered: last };
}

/**
 * Whole seconds left on a question, on the server's clock: the phone's clock may be wrong, so the offset between the
 * server's `serverNow` and the moment the answer arrived is applied. Null without a timer; never below 0.
 */
export function secondsLeft(
  closesAt: string | null,
  clock: Readonly<{ serverNow: string; receivedAt: number }>,
  now: number,
): number | null {
  if (closesAt === null) {
    return null;
  }
  const serverNow = Date.parse(clock.serverNow) + (now - clock.receivedAt);
  return Math.max(0, Math.ceil((Date.parse(closesAt) - serverNow) / 1000));
}

/** The wait after time runs out before the closed question's answer is asked for: the server's grace, and a bit. */
export const REVEAL_WAIT_MS = (QUIZ_GRACE_SECONDS + 0.5) * 1000;

/** Screen readers hear the time left every 10 seconds and at 5 (the visible count changes every second). */
export const announces = (seconds: number | null): boolean =>
  seconds !== null && seconds > 0 && (seconds % 10 === 0 || seconds === 5);

export type QuizAction = "start" | "next";

export async function fetchQuiz(
  session: Pick<Session, "request">,
  questId: string,
): Promise<QuizView | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/quests/${encodeURIComponent(questId)}/quiz`,
  });
  return answer.kind === "ok" ? quizViewOf(answer.body) : undefined;
}

/** Starts or moves the quiz on. Each is idempotent on the server by its own natural key, so a retry is safe. */
export async function quizAction(
  session: Pick<Session, "request">,
  questId: string,
  action: QuizAction,
  key: string,
): Promise<QuizStep | PlayFailure> {
  return quizStepOf(
    await session.request({
      method: "POST",
      path: `/v1/quests/${encodeURIComponent(questId)}/quiz/${action}`,
      body: {},
      headers: { "idempotency-key": key },
    }),
  );
}

export async function answerQuiz(
  session: Pick<Session, "request">,
  questId: string,
  answer: Readonly<{ questionId: string; choiceId: string }>,
  key: string,
): Promise<QuizStep | PlayFailure> {
  return quizStepOf(
    await session.request({
      method: "POST",
      path: `/v1/quests/${encodeURIComponent(questId)}/quiz/answer`,
      body: answer,
      headers: { "idempotency-key": key },
    }),
  );
}
