import { z } from "zod";
import { MIN_GROUP_SIZE, type SponsorTotals } from "#src/analytics/sponsor";
import type { Language } from "#src/i18n/digits";
import type { MessageKey } from "#src/i18n/messages";
import { joinFieldLabel } from "#src/join/fields";
import {
  surveyCsvLabelsOf,
  surveyResultsLines,
  surveyResultsSchema,
} from "#src/survey-results/survey-results";

/**
 * The event's spreadsheets (T-608, FR-1206, FR-1207, FR-1306, FR-1626, ADR-393). Every file is built from rows the
 * database door answered and checked here against a strict schema, so a column the join card did not disclose cannot
 * reach a file: a player is a username, the join answers, and what they did in the event; never a phone number, an
 * email address or an id.
 */

export const EXPORT_KINDS = [
  "players",
  "completions",
  "redemptions",
  "submissions",
  "surveys",
  "sponsor",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** `POST …/events/{id}/exports/{kind}`: the language of the headers and, for a sponsor's totals, the sponsor. */
export const exportBodySchema = z.strictObject({
  language: z.enum(["ar", "en"]),
  sponsorId: z.uuid().optional(),
});
export type ExportBody = z.input<typeof exportBodySchema>;

const text = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });
const moment = z.string().min(1).max(32);

/** What `export_start` answers: the event's names and zone, and the join fields the players export has columns for. */
export const exportStartSchema = z.strictObject({
  name: text,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  zone: z.string(),
  fields: z.array(z.strictObject({ id: z.uuid(), kind: z.string(), label: text })),
});
export type ExportStart = z.infer<typeof exportStartSchema>;

export const playerRowSchema = z.strictObject({
  username: z.string(),
  status: z.string(),
  joinedAt: moment,
  points: z.number().int().min(0),
  answers: z.record(z.uuid(), z.string()),
});
export const completionRowSchema = z.strictObject({
  username: z.string(),
  quest: text,
  category: text,
  completedAt: moment,
  occurrence: z.number().int().min(1),
  method: z.string(),
  removed: z.boolean(),
});
/**
 * A page of an export door (FOLLOWUPS batch 30, migration 0182): its rows, and where the next page starts (the
 * timestamp exactly as the database wrote it, and the row's own id: a number for completions and submissions, a uuid
 * for players and redemptions); null on the last.
 */
const pageOf = <Row extends z.ZodType, Id extends z.ZodType>(row: Row, id: Id) =>
  z.strictObject({
    rows: z.array(row),
    next: z.strictObject({ at: z.string(), id }).nullable(),
  });
const serial = z.number().int();
export const completionPageSchema = pageOf(completionRowSchema, serial);
export const redemptionRowSchema = z.strictObject({
  username: z.string(),
  reward: text,
  price: z.number().int().min(0),
  status: z.string(),
  reservedAt: moment,
  endedAt: moment.nullable(),
});
export const submissionRowSchema = z.strictObject({
  username: z.string(),
  quest: text,
  submittedAt: moment,
  status: z.string(),
  /** What the player sent (migration 0196): a photo's own file is never in the export, only its caption. */
  kind: z.enum(["text", "photo"]),
  answer: z.string().nullable(),
});
export const playerPageSchema = pageOf(playerRowSchema, z.uuid());
export const redemptionPageSchema = pageOf(redemptionRowSchema, z.uuid());
export const submissionPageSchema = pageOf(submissionRowSchema, serial);
export const surveyExportSchema = z.strictObject({ quest: text, results: surveyResultsSchema });

export type PlayerRow = z.infer<typeof playerRowSchema>;
export type CompletionRow = z.infer<typeof completionRowSchema>;
export type RedemptionRow = z.infer<typeof redemptionRowSchema>;
export type SubmissionRow = z.infer<typeof submissionRowSchema>;
export type SurveyExport = z.infer<typeof surveyExportSchema>;

/** A file's header line, and how one row of it becomes cells. */
export type ExportTable<Row> = Readonly<{
  header: readonly string[];
  cells: (row: Row) => (string | number)[];
}>;

/** A translator in the file's language. */
export type ExportTranslate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;

const pick = (value: Readonly<{ ar: string | null; en: string | null }>, language: Language) =>
  (language === "ar" ? (value.ar ?? value.en) : (value.en ?? value.ar)) ?? "";

/** Players: the username, the join answers in the card's order, the status, when they joined and their points. */
export function playersTable(
  fields: ExportStart["fields"],
  language: Language,
  t: ExportTranslate,
): ExportTable<PlayerRow> {
  return {
    header: [
      t("exports.csv.username"),
      ...fields.map((field) => joinFieldLabel(field, language)),
      t("exports.csv.status"),
      t("exports.csv.joinedAt"),
      t("exports.csv.points"),
    ],
    cells: (row) => [
      row.username,
      ...fields.map((field) => row.answers[field.id] ?? ""),
      row.status,
      row.joinedAt,
      row.points,
    ],
  };
}

export function completionsTable(
  language: Language,
  t: ExportTranslate,
): ExportTable<CompletionRow> {
  return {
    header: [
      t("exports.csv.username"),
      t("exports.csv.quest"),
      t("exports.csv.category"),
      t("exports.csv.completedAt"),
      t("exports.csv.occurrence"),
      t("exports.csv.method"),
      t("exports.csv.removed"),
    ],
    cells: (row) => [
      row.username,
      pick(row.quest, language),
      pick(row.category, language),
      row.completedAt,
      row.occurrence,
      row.method,
      row.removed ? t("exports.csv.yes") : "",
    ],
  };
}

export function redemptionsTable(
  language: Language,
  t: ExportTranslate,
): ExportTable<RedemptionRow> {
  return {
    header: [
      t("exports.csv.username"),
      t("exports.csv.reward"),
      t("exports.csv.price"),
      t("exports.csv.status"),
      t("exports.csv.reservedAt"),
      t("exports.csv.endedAt"),
    ],
    cells: (row) => [
      row.username,
      pick(row.reward, language),
      row.price,
      row.status,
      row.reservedAt,
      row.endedAt ?? "",
    ],
  };
}

export function submissionsTable(
  language: Language,
  t: ExportTranslate,
): ExportTable<SubmissionRow> {
  return {
    header: [
      t("exports.csv.username"),
      t("exports.csv.quest"),
      t("exports.csv.submittedAt"),
      t("exports.csv.status"),
      t("exports.csv.kind"),
      t("exports.csv.answer"),
    ],
    cells: (row) => [
      row.username,
      pick(row.quest, language),
      row.submittedAt,
      row.status,
      t(row.kind === "photo" ? "exports.csv.kindPhoto" : "exports.csv.kindText"),
      row.answer ?? "",
    ],
  };
}

/** Every survey of the event, each line led by its quest's name (counts and answers, never a player). */
export function surveysRows(
  surveys: readonly SurveyExport[],
  language: Language,
  t: ExportTranslate,
): (string | number)[][] {
  const labels = surveyCsvLabelsOf(t);
  const header = [
    t("exports.csv.quest"),
    labels.question,
    labels.kind,
    labels.answer,
    labels.count,
  ];
  return [
    header,
    ...surveys.flatMap((survey) =>
      surveyResultsLines(survey.results, language, labels).map((line) => [
        pick(survey.quest, language),
        ...line,
      ]),
    ),
  ];
}

/** A sponsor's totals as rows: no player, and a count under the floor reads "fewer than 5" (FR-1626). */
export function sponsorRows(
  totals: SponsorTotals,
  language: Language,
  t: ExportTranslate,
): (string | number)[][] {
  const count = (value: number | null) =>
    value ?? t("analytics.sponsor.fewer", { count: MIN_GROUP_SIZE });
  const group = t("exports.csv.totals");
  const players = t("exports.csv.players");
  return [
    [
      t("exports.csv.group"),
      t("exports.csv.item"),
      t("exports.csv.measure"),
      t("exports.csv.count"),
    ],
    [
      group,
      pick(totals.sponsor.name, language),
      t("analytics.sponsor.visits"),
      count(totals.visits),
    ],
    [group, "", t("analytics.sponsor.completions"), count(totals.completions)],
    [group, "", t("analytics.sponsor.redemptions"), count(totals.redemptions)],
    ...totals.quests.map((quest) => [
      t("exports.csv.quest"),
      pick(quest.title, language),
      players,
      count(quest.players),
    ]),
    ...totals.categories.map((category) => [
      t("exports.csv.category"),
      pick(category.name, language),
      players,
      count(category.players),
    ]),
    ...totals.rewards.map((reward) => [
      t("exports.csv.reward"),
      pick(reward.name, language),
      t("exports.csv.redeemed"),
      count(reward.redeemed),
    ]),
    ...totals.souvenirs.map((souvenir) => [
      t("exports.csv.souvenir"),
      pick(souvenir.name, language),
      players,
      count(souvenir.earned),
    ]),
  ];
}
