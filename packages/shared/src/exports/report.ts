import { z } from "zod";
import { groupCount, groupParts } from "#src/analytics/sponsor";
import type { Economy, Participation, QuestsAnalytics } from "#src/analytics/analytics";
import type { ExportStart, SurveyExport } from "#src/exports/exports";

/**
 * The event's one-page report (T-608, FR-1208, ADR-393): the headline numbers, the most popular quests and rewards and
 * each survey's results, for a client or a sponsor. It holds no player. Event-wide figures are shown as they are (the
 * reader ran the event); the count of one quest, one reward or one answer choice is left out when it is one to four
 * players, and a survey with fewer than that many responses shows no result at all.
 */

/** How many quests, rewards, surveys, questions and choices fit on the page. */
export const REPORT_LIMITS = {
  quests: 5,
  rewards: 5,
  surveys: 3,
  questions: 3,
  choices: 4,
} as const;

const count = z.number().int().min(0);
const shown = count.nullable();
const text = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });

const surveyQuestionSchema = z.strictObject({
  text,
  kind: z.enum(["choice", "rating", "text"]),
  /** Players who answered; null when fewer than the floor. */
  answered: shown,
  average: z.number().nullable(),
  choices: z.array(z.strictObject({ text, count: shown })).nullable(),
  /** Written answers are counted, never quoted: free text can point at a person. */
  written: shown,
});

const surveySchema = z.strictObject({
  title: text,
  /** Responses; null when fewer than the floor, in which case no result is given. */
  responses: shown,
  questions: z.array(surveyQuestionSchema),
});

/** `POST …/events/{id}/report`. */
export const reportSchema = z.strictObject({
  event: z.strictObject({
    name: text,
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    zone: z.string(),
  }),
  rehearsal: z.boolean(),
  generatedAt: z.string(),
  headline: z.strictObject({
    joined: count,
    active: count,
    activation: z.number().int().min(0).max(100).nullable(),
    returning: count,
    earned: count,
    spent: count,
    redeemed: count,
  }),
  quests: z.array(z.strictObject({ title: text, done: shown })),
  rewards: z.array(z.strictObject({ name: text, redeemed: shown })),
  surveys: z.array(surveySchema),
  moreSurveys: count,
});
export type Report = z.infer<typeof reportSchema>;
export type ReportSurvey = z.infer<typeof surveySchema>;

type SurveyQuestion = SurveyExport["results"]["questions"][number];

function reportQuestion(question: SurveyQuestion): ReportSurvey["questions"][number] {
  return {
    text: question.text,
    kind: question.kind,
    answered: groupCount(question.answered),
    average:
      question.average !== null && groupCount(question.answered) !== null ? question.average : null,
    choices:
      question.choices === null
        ? null
        : question.choices
            .slice(0, REPORT_LIMITS.choices)
            .map((choice) => ({ text: choice.text, count: groupCount(choice.count) })),
    written: question.kind === "text" ? groupCount(question.texts?.length ?? 0) : null,
  };
}

function reportSurvey(survey: SurveyExport): ReportSurvey {
  const responses = groupCount(survey.results.total);
  return {
    title: survey.quest,
    responses,
    questions:
      responses === null || responses === 0
        ? []
        : survey.results.questions.slice(0, REPORT_LIMITS.questions).map(reportQuestion),
  };
}

/** The report from the event's names, its three analytics answers and its surveys. */
export function buildReport(
  input: Readonly<{
    start: ExportStart;
    participation: Participation;
    quests: QuestsAnalytics;
    economy: Economy;
    surveys: readonly SurveyExport[];
    generatedAt: string;
  }>,
): Report {
  const { start, participation, quests, economy, surveys } = input;
  const popular = quests.categories
    .flatMap((category) => category.quests)
    .sort((a, b) => b.done - a.done)
    .slice(0, REPORT_LIMITS.quests);
  const redeemedParts = groupParts(economy.rewards.map((reward) => reward.redeemed));
  const rewards = economy.rewards
    .map((reward, index) => ({
      name: reward.name,
      redeemed: redeemedParts[index] ?? null,
      order: reward.redeemed,
    }))
    .sort((a, b) => b.order - a.order)
    .slice(0, REPORT_LIMITS.rewards)
    .map(({ name, redeemed }) => ({ name, redeemed }));
  return {
    event: { name: start.name, startsAt: start.startsAt, endsAt: start.endsAt, zone: start.zone },
    rehearsal: participation.rehearsal,
    generatedAt: input.generatedAt,
    headline: {
      joined: participation.joined,
      active: participation.active,
      activation: participation.activation,
      returning: participation.returning,
      earned: economy.earned,
      spent: economy.spent,
      redeemed: economy.rewards.reduce((sum, reward) => sum + reward.redeemed, 0),
    },
    quests: popular.map((quest) => ({ title: quest.title, done: groupCount(quest.done) })),
    rewards,
    surveys: surveys.slice(0, REPORT_LIMITS.surveys).map(reportSurvey),
    moreSurveys: Math.max(0, surveys.length - REPORT_LIMITS.surveys),
  };
}
