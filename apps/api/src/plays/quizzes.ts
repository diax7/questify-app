import type { StreakBonus } from "@questify/shared";
import type { PoolClient } from "pg";
import {
  itemGiven,
  boostApplied,
  levelReached,
  quizBonus,
  type Boosted,
  type Bonus,
  type ItemGiven,
  type LevelUp,
} from "#src/completions/complete";
import { run, textOf, type Bilingual, type Done, type PlayDeps } from "#src/plays/run";
import { firstBonusPaid, type OwnFirstBonus } from "#src/quests/first-bonus";
import { streakBonusPaid } from "#src/streaks/streaks";

export type QuizChoice = Readonly<{ id: string; text: Bilingual }>;

/** The question being asked: never its right answer (FR-209). */
export type QuizQuestion = Readonly<{
  position: number;
  id: string;
  text: Bilingual;
  choices: readonly QuizChoice[];
  servedAt: string;
  /** When its time runs out (FR-210), or null for a quiz without a timer. */
  closesAt: string | null;
}>;

/** A question answered or closed: the right answer is shown now. */
export type QuizAnswered = Omit<QuizQuestion, "servedAt" | "closesAt"> &
  Readonly<{ choiceId: string | null; rightChoiceId: string; right: boolean; closed: boolean }>;

export type QuizView = Readonly<{
  status: "none" | "open" | "finished" | "void";
  total: number;
  pointsEach: number;
  timerSeconds: number | null;
  rightCount: number;
  earned: number;
  /** Set once a finished quiz paid (no right answers pays nothing, FR-208). */
  completionId: string | null;
  serverNow: Date;
  current: QuizQuestion | null;
  answered: readonly QuizAnswered[];
}>;

/** A step's answer: the quiz after it, and the level its payment reached, if it paid. */
export type QuizPlay = Readonly<{
  quiz: QuizView;
  levelUp: LevelUp | null;
  bonus: Bonus | null;
  /** The quest item a paid finish gave or missed (T-304d), or null. */
  item: ItemGiven | null;
  /** The boost that doubled a paid finish (T-307), judged at the quiz's start; or null. */
  boost: Boosted | null;
  /** The first-N bonus a paid finish earned, or missed when `place` is null (T-313). */
  firstBonus: OwnFirstBonus | null;
  /** The event streak bonus a paid finish paid with its streak day (T-405), or null; the same on a replay. */
  streakBonus: StreakBonus | null;
}>;

/** A step's answer and whether this very step paid (a replay, or a read after the payment, did not). */
export type QuizStep = QuizPlay & Readonly<{ paid: boolean }>;

export type QuizAnswer = QuizStep &
  Readonly<{ result: Readonly<{ right: boolean; rightChoiceId: string; replayed: boolean }> }>;

type QuizRow = {
  status: QuizView["status"];
  total: number;
  points_each: number;
  timer_seconds: number | null;
  right_count: number;
  earned: string;
  completion_id: string | null;
  server_now: Date;
  current: Record<string, unknown> | null;
  answered: Record<string, unknown>[];
};

const choicesOf = (value: unknown): QuizChoice[] =>
  ((value ?? []) as { id: string; text: unknown }[]).map((choice) => ({
    id: choice.id,
    text: textOf(choice.text),
  }));

const questionOf = (item: Record<string, unknown>) => ({
  position: Number(item["position"]),
  id: String(item["id"]),
  text: textOf(item["text"]),
  choices: choicesOf(item["choices"]),
});

const currentOf = (item: Record<string, unknown> | null): QuizQuestion | null =>
  item === null
    ? null
    : {
        ...questionOf(item),
        servedAt: String(item["servedAt"]),
        closesAt: item["closesAt"] === null ? null : String(item["closesAt"]),
      };

const answeredOf = (item: Record<string, unknown>): QuizAnswered => ({
  ...questionOf(item),
  choiceId: item["choiceId"] === null ? null : String(item["choiceId"]),
  rightChoiceId: String(item["rightChoiceId"]),
  right: item["right"] === true,
  closed: item["closed"] === true,
});

/** The caller's quiz as `member_quiz` reports it, or undefined when they may not play it. */
async function quizOf(client: PoolClient, questId: string): Promise<QuizView | undefined> {
  const { rows } = await client.query<QuizRow>("SELECT * FROM member_quiz($1)", [questId]);
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return {
    status: row.status,
    total: row.total,
    pointsEach: row.points_each,
    timerSeconds: row.timer_seconds,
    rightCount: row.right_count,
    earned: Number(row.earned),
    completionId: row.completion_id,
    serverNow: row.server_now,
    current: currentOf(row.current),
    answered: row.answered.map(answeredOf),
  };
}

/** The quiz after a step, with the level its payment reached. Every step passed play_enter, so the read has a row. */
async function playOf(client: PoolClient, questId: string): Promise<QuizPlay> {
  const quiz = (await quizOf(client, questId)) as QuizView;
  return {
    quiz,
    levelUp: quiz.completionId === null ? null : await levelReached(client, quiz.completionId),
    bonus: quiz.status === "finished" ? await quizBonus(client, questId) : null,
    item: quiz.completionId === null ? null : await itemGiven(client, quiz.completionId),
    boost: quiz.completionId === null ? null : await boostApplied(client, quiz.completionId),
    firstBonus: quiz.completionId === null ? null : await firstBonusPaid(client, quiz.completionId),
    streakBonus:
      quiz.completionId === null ? null : await streakBonusPaid(client, quiz.completionId),
  };
}

/** The player's quiz, writing nothing (an overdue question shows as closed). Not found unless they may play it. */
export async function readQuiz(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<QuizView>> {
  const read = await run(deps, { playerId }, (client) => quizOf(client, questId));
  if (read.kind !== "done") {
    return read;
  }
  return read.value === undefined ? { kind: "not_found" } : { kind: "done", value: read.value };
}

type Step = Readonly<{ playerId: string; questId: string }>;

/** Starts the player's one attempt, or resumes it (ADR-191). */
export function startQuiz(deps: PlayDeps, step: Step): Promise<Done<QuizStep>> {
  return run(deps, { playerId: step.playerId }, async (client) => {
    await client.query("SELECT quiz_start($1)", [step.questId]);
    return { ...(await playOf(client, step.questId)), paid: false };
  });
}

/** Serves the next question, closing an overdue one first; after the last, the quiz finishes and pays. */
export function nextQuestion(deps: PlayDeps, step: Step): Promise<Done<QuizStep>> {
  return run(deps, { playerId: step.playerId }, async (client) => {
    const { rows } = await client.query<{ outcome: string }>("SELECT quiz_next($1) AS outcome", [
      step.questId,
    ]);
    return { ...(await playOf(client, step.questId)), paid: rows[0]?.outcome === "paid" };
  });
}

/** One try at the served question (FR-209); the answer carries the right one. The last answer finishes the quiz. */
export function answerQuestion(
  deps: PlayDeps,
  step: Step & Readonly<{ questionId: string; choiceId: string }>,
): Promise<Done<QuizAnswer>> {
  return run(deps, { playerId: step.playerId }, async (client) => {
    const { rows } = await client.query<{ replayed: boolean }>(
      "SELECT quiz_answer($1, $2, $3) AS replayed",
      [step.questId, step.questionId, step.choiceId],
    );
    const play = await playOf(client, step.questId);
    const answered = play.quiz.answered.find((item) => item.id === step.questionId);
    const replayed = rows[0]?.replayed === true;
    const last = answered?.position === play.quiz.total;
    return {
      ...play,
      paid: !replayed && last && play.quiz.completionId !== null,
      result: {
        right: answered?.right ?? false,
        rightChoiceId: answered?.rightChoiceId ?? "",
        replayed,
      },
    };
  });
}

/** Attempts finished per tick at most; the next tick takes the rest. */
const SWEEP_BATCH = 50;

/**
 * Finishes the quizzes left open past their quest's close, their event's end or their last question's time (ADR-193),
 * one per transaction, as the system. Answers how many it finished.
 */
export async function finishDueQuizzes(deps: PlayDeps): Promise<number> {
  let finished = 0;
  for (let i = 0; i < SWEEP_BATCH; i += 1) {
    const outcome = await run(deps, {}, async (client) => {
      const { rows } = await client.query<{ outcome: string | null }>(
        "SELECT finish_one_due_quiz() AS outcome",
      );
      return rows[0]?.outcome ?? null;
    });
    if (outcome.kind !== "done" || outcome.value === null) {
      break;
    }
    finished += 1;
  }
  return finished;
}
