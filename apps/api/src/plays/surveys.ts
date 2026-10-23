import type { OrganizerContext } from "#src/organizers/store";
import {
  paidOf,
  run,
  textOf,
  type Bilingual,
  type Done,
  type Paid,
  type PaidRow,
  type PlayDeps,
} from "#src/plays/run";

/** A survey question as a player reads it (ADR-198): never anyone's answers. */
export type SurveyQuestion = Readonly<{
  id: string;
  kind: "choice" | "rating" | "text";
  text: Bilingual;
  required: boolean;
  choices: readonly Readonly<{ id: string; text: Bilingual }>[] | null;
}>;

export type SurveyView = Readonly<{
  questions: readonly SurveyQuestion[];
  /** The player already answered (one response per player). */
  answered: boolean;
}>;

type StoredQuestion = {
  id: string;
  kind: SurveyQuestion["kind"];
  text?: unknown;
  required?: boolean;
  choices?: { id: string; text?: unknown }[];
};

const questionOf = (question: StoredQuestion): SurveyQuestion => ({
  id: question.id,
  kind: question.kind,
  text: textOf(question.text),
  required: question.required !== false,
  choices:
    question.choices?.map((choice) => ({ id: choice.id, text: textOf(choice.text) })) ?? null,
});

/** A survey quest's questions and whether the player answered (FR-214); not found unless they may play it. */
export async function readSurvey(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<SurveyView>> {
  const read = await run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<{
      survey: { questions: StoredQuestion[]; answered: boolean } | null;
    }>("SELECT member_survey($1) AS survey", [questId]);
    return rows[0]?.survey ?? null;
  });
  if (read.kind !== "done") {
    return read;
  }
  if (read.value === null) {
    return { kind: "not_found" };
  }
  return {
    kind: "done",
    value: { questions: read.value.questions.map(questionOf), answered: read.value.answered },
  };
}

/** An answer as the player sends it: a choice id, a rating, or text; null or left out for unanswered. */
export type SurveyAnswers = Readonly<Record<string, string | number | null>>;

/** The player answers a survey (FR-214): one response, paid as a completion by `submit_survey` (migration 0042). */
export function answerSurvey(
  deps: PlayDeps,
  request: Readonly<{
    playerId: string;
    questId: string;
    answers: SurveyAnswers;
    idempotencyKey: string;
  }>,
): Promise<Done<Paid>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<PaidRow>("SELECT * FROM submit_survey($1, $2, $3)", [
      request.questId,
      JSON.stringify(request.answers),
      request.idempotencyKey,
    ]);
    return paidOf(client, rows);
  });
}

/** One question's results: counts for a choice, the average for a rating, the newest 50 texts for text. */
export type SurveyQuestionResult = Readonly<{
  id: string;
  kind: SurveyQuestion["kind"];
  text: Bilingual;
  answered: number;
  choices: readonly Readonly<{ id: string; text: Bilingual; count: number }>[] | null;
  average: number | null;
  texts: readonly string[] | null;
}>;

/** A survey's results for the team, names not shown (ADR-198). */
export type SurveySummary = Readonly<{ total: number; questions: readonly SurveyQuestionResult[] }>;

type StoredResult = {
  id: string;
  kind: SurveyQuestion["kind"];
  text?: unknown;
  answered: number;
  choices: { id: string; text?: unknown; count: number }[] | null;
  average: number | null;
  texts: string[] | null;
};

/** A survey quest's results for the event's owners and editors (FR-214, ADR-198). */
export function surveySummary(
  deps: PlayDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; questId: string }>,
): Promise<Done<SurveySummary>> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  return run(deps, seat, async (client) => {
    const { rows } = await client.query<{
      summary: { total: number; questions: StoredResult[] };
    }>("SELECT survey_summary($1, $2) AS summary", [request.eventId, request.questId]);
    const summary = (rows[0] as { summary: { total: number; questions: StoredResult[] } }).summary;
    return {
      total: summary.total,
      questions: summary.questions.map((question) => ({
        id: question.id,
        kind: question.kind,
        text: textOf(question.text),
        answered: question.answered,
        choices:
          question.choices?.map((choice) => ({
            id: choice.id,
            text: textOf(choice.text),
            count: choice.count,
          })) ?? null,
        average: question.average,
        texts: question.texts,
      })),
    };
  });
}
