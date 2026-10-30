import { z } from "zod";
import { textIssue } from "#src/invitation-campaigns/name-rule";
import { csvFile } from "#src/text/csv";

/**
 * Quest ratings and survey results (T-508, FR-1209 to FR-1211, FR-1623, FR-1624, ADR-376). A player who completed a
 * quest may rate it with a thumb or skip; the team reads each quest's counts. The team reads a survey's results, exports
 * them, and shares one quest's results with its speaker through a link that holds no account. Nothing here carries a
 * player: only counts, averages and the text answers, names not shown.
 */

/** What a player sends for a quest they completed. A skip is remembered so the prompt does not come back. */
export const QUEST_THUMBS = ["up", "down", "skip"] as const;
export type QuestThumb = (typeof QUEST_THUMBS)[number];

/** `PUT /v1/quests/{questId}/rating`. */
export const questRatingBodySchema = z.strictObject({ thumb: z.enum(QUEST_THUMBS) });
export type QuestRatingBody = z.input<typeof questRatingBodySchema>;

/** `GET /v1/quests/{questId}/rating`: whether to ask, and what the player already said. */
export const memberQuestRatingSchema = z.strictObject({
  on: z.boolean(),
  thumb: z.enum(QUEST_THUMBS).nullable(),
});
export type MemberQuestRating = z.infer<typeof memberQuestRatingSchema>;

const scoreSchema = z.strictObject({
  questId: z.uuid(),
  up: z.number().int().min(0),
  down: z.number().int().min(0),
});

/** `GET …/events/{id}/quest-ratings`: the switch and each rated quest's counts. */
export const questRatingScoresSchema = z.strictObject({
  on: z.boolean(),
  scores: z.array(scoreSchema),
});
export type QuestRatingScores = z.infer<typeof questRatingScoresSchema>;
export type QuestRatingScore = z.infer<typeof scoreSchema>;

/** A quest's score as a whole percent of thumbs up among the thumbs, or null when nobody gave a thumb. */
export function questScorePercent(score: Pick<QuestRatingScore, "up" | "down">): number | null {
  const total = score.up + score.down;
  return total === 0 ? null : Math.round((score.up * 100) / total);
}

/** A share link's token: 32 random bytes, base64url. */
export const SURVEY_SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/** `POST /v1/public/survey-results`: the token the speaker's page read from the link's fragment. */
export const surveyResultsOpenBodySchema = z.strictObject({
  token: z.string().regex(SURVEY_SHARE_TOKEN),
});

/** `GET/POST/DELETE …/quests/{id}/survey-share`. */
export const surveyShareStateSchema = z.strictObject({
  shared: z.boolean(),
  createdAt: z.string().nullable().optional(),
});
export type SurveyShareState = z.infer<typeof surveyShareStateSchema>;

const textSchema = z.object({
  ar: z.string().nullable().default(null),
  en: z.string().nullable().default(null),
});

const questionSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["choice", "rating", "text"]),
  text: textSchema,
  answered: z.number().int().min(0),
  choices: z
    .array(z.strictObject({ id: z.string(), text: textSchema, count: z.number().int().min(0) }))
    .nullable(),
  average: z.number().nullable(),
  texts: z.array(z.string()).nullable(),
  /** Text answers left out because they look like a contact detail (the speaker's view only). */
  hiddenTexts: z.number().int().min(0).optional(),
});
export type SharedSurveyQuestion = z.infer<typeof questionSchema>;

/** What the speaker's page shows: the survey's names and its results. */
export const sharedSurveyResultsSchema = z.strictObject({
  quest: textSchema,
  event: textSchema,
  total: z.number().int().min(0),
  questions: z.array(questionSchema),
});
export type SharedSurveyResults = z.infer<typeof sharedSurveyResultsSchema>;

/**
 * The results with every text answer that looks like a contact detail left out (an address, a phone number or hidden
 * characters, the same rule that guards what goes out under Questify's name), and the number left out beside each
 * question. The speaker's view is the only caller: the team sees every answer.
 */
export function withoutContactDetails(results: SharedSurveyResults): SharedSurveyResults {
  return {
    ...results,
    questions: results.questions.map((question) => {
      if (question.texts === null) return { ...question, hiddenTexts: 0 };
      const kept = question.texts.filter((text) => textIssue(text) === null);
      return { ...question, texts: kept, hiddenTexts: question.texts.length - kept.length };
    }),
  };
}

type Plain = Readonly<{ ar: string | null; en: string | null }>;

/** The words the spreadsheet's header and fixed cells use, in the dashboard's language. */
export type SurveyCsvLabels = Readonly<{
  question: string;
  kind: string;
  answer: string;
  count: string;
  choice: string;
  rating: string;
  text: string;
  average: string;
  responses: string;
  noAnswers: string;
}>;

/** The shape both the team's results and the speaker's share. */
export type SurveyResultsRows = Readonly<{
  total: number;
  questions: readonly Readonly<{
    text: Plain;
    kind: "choice" | "rating" | "text";
    answered: number;
    choices: readonly Readonly<{ text: Plain; count: number }>[] | null;
    average: number | null;
    texts: readonly string[] | null;
  }>[];
}>;

const pick = (text: Plain, language: "ar" | "en"): string =>
  (language === "ar" ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? "";

type CsvQuestion = SurveyResultsRows["questions"][number];

/** One question's lines: a line a choice, one for a rating's average, or a line a text answer. */
function questionLines(
  question: CsvQuestion,
  language: "ar" | "en",
  labels: SurveyCsvLabels,
): (string | number)[][] {
  const title = pick(question.text, language);
  if (question.choices !== null) {
    return question.choices.map((choice) => [
      title,
      labels.choice,
      pick(choice.text, language),
      choice.count,
    ]);
  }
  if (question.kind === "rating") {
    const answered = question.average !== null;
    return [
      [title, labels.rating, answered ? labels.average : labels.noAnswers, question.average ?? ""],
    ];
  }
  const texts = question.texts ?? [];
  return texts.length === 0
    ? [[title, labels.text, labels.noAnswers, 0]]
    : texts.map((text) => [title, labels.text, text, ""]);
}

/**
 * A survey's results as a spreadsheet (FR-1624): one line for the number of responses, then each question's choice
 * counts, rating average or text answers, one line each. A survey nobody answered is one line that says so. Numbers are
 * Western digits.
 */
export function surveyResultsCsv(
  results: SurveyResultsRows,
  language: "ar" | "en",
  labels: SurveyCsvLabels,
): string {
  const header = [labels.question, labels.kind, labels.answer, labels.count];
  if (results.total === 0) {
    return csvFile([header, [labels.noAnswers, "", "", 0]]);
  }
  return csvFile([
    header,
    [labels.responses, "", "", results.total],
    ...results.questions.flatMap((question) => questionLines(question, language, labels)),
  ]);
}
