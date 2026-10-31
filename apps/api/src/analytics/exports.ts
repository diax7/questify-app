import { Readable } from "node:stream";
import {
  MESSAGES,
  buildReport,
  completionPageSchema,
  completionsTable,
  createTranslator,
  csvLines,
  economySchema,
  exportStartSchema,
  participationSchema,
  playerRowSchema,
  playersTable,
  questsAnalyticsSchema,
  redemptionRowSchema,
  redemptionsTable,
  sponsorRows,
  submissionRowSchema,
  submissionsTable,
  surveyExportSchema,
  surveysRows,
  type CompletionRow,
  type ExportKind,
  type ExportStart,
  type ExportTable,
  type ExportTranslate,
  type Language,
  type Report,
} from "@questify/shared";
import { z } from "zod";
import {
  callDoor,
  readAnalytics,
  readSponsorTotals,
  type AnalyticsDeps,
} from "#src/analytics/analytics";
import type { OrganizerContext } from "#src/organizers/store";

const translate = createTranslator(MESSAGES);

type CompletionPage = z.infer<typeof completionPageSchema>;

/** Rows written to the file per piece, and completions read per page (the door allows up to 10,000). */
const PIECE_ROWS = 5000;
const PAGE_ROWS = 5000;
const BYTE_ORDER_MARK = "﻿";

/**
 * Opens an export or the report: the database checks the caller's seat, writes the audit entry (FR-1206: every export
 * is audited) and answers the event's names and zone. Undefined when the event, or the sponsor of a sponsor's totals,
 * is not the caller's to reach.
 */
export async function startExport(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  input: Readonly<{
    eventId: string;
    kind: ExportKind | "report";
    sponsorId: string | undefined;
    requestId: string;
  }>,
): Promise<ExportStart | undefined> {
  const answer = await callDoor(deps, team, "export_start($1, $2, $3, $4)", [
    input.eventId,
    input.kind,
    input.sponsorId ?? null,
    input.requestId,
  ]);
  return answer === undefined ? undefined : exportStartSchema.parse(answer);
}

/** A door of an export already opened: the seat was checked at the start, so a refusal now is a fault. */
async function rowsOf<T>(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  schema: z.ZodType<T>,
  sql: string,
  values: readonly unknown[],
): Promise<T> {
  const answer = await callDoor(deps, team, sql, values);
  if (answer === undefined) {
    throw new Error(`The export door ${sql} refused an opened export.`);
  }
  return schema.parse(answer);
}

const head = (table: Readonly<{ header: readonly string[] }>) =>
  `${BYTE_ORDER_MARK}${csvLines([table.header])}`;
const door = (name: string) => `${name}($1)`;

function* pieces<Row>(table: ExportTable<Row>, rows: readonly Row[]): Generator<string> {
  for (let from = 0; from < rows.length; from += PIECE_ROWS) {
    yield csvLines(rows.slice(from, from + PIECE_ROWS).map((row) => table.cells(row)));
  }
}

async function* completionPieces(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  eventId: string,
  table: ExportTable<CompletionRow>,
): AsyncGenerator<string> {
  let cursor: { at: string; id: number } | null = { at: "-infinity", id: 0 };
  while (cursor !== null) {
    const page: CompletionPage = await rowsOf(
      deps,
      team,
      completionPageSchema,
      "export_completions($1, $2, $3, $4)",
      [eventId, cursor.at, cursor.id, PAGE_ROWS],
    );
    yield* pieces(table, page.rows);
    cursor = page.next;
  }
}

type FileSource = Readonly<{
  deps: AnalyticsDeps;
  team: OrganizerContext;
  eventId: string;
  sponsorId: string | undefined;
  language: Language;
  start: ExportStart;
  t: ExportTranslate;
}>;

async function* playersFile(source: FileSource): AsyncGenerator<string> {
  const { deps, team, eventId, language, t } = source;
  const table = playersTable(source.start.fields, language, t);
  yield head(table);
  const rows = await rowsOf(deps, team, z.array(playerRowSchema), door("export_players"), [
    eventId,
  ]);
  yield* pieces(table, rows);
}

async function* completionsFile(source: FileSource): AsyncGenerator<string> {
  const table = completionsTable(source.language, source.t);
  yield head(table);
  yield* completionPieces(source.deps, source.team, source.eventId, table);
}

async function* redemptionsFile(source: FileSource): AsyncGenerator<string> {
  const { deps, team, eventId } = source;
  const table = redemptionsTable(source.language, source.t);
  yield head(table);
  const rows = await rowsOf(deps, team, z.array(redemptionRowSchema), door("export_redemptions"), [
    eventId,
  ]);
  yield* pieces(table, rows);
}

async function* submissionsFile(source: FileSource): AsyncGenerator<string> {
  const { deps, team, eventId } = source;
  const table = submissionsTable(source.language, source.t);
  yield head(table);
  const rows = await rowsOf(deps, team, z.array(submissionRowSchema), door("export_submissions"), [
    eventId,
  ]);
  yield* pieces(table, rows);
}

async function* surveysFile(source: FileSource): AsyncGenerator<string> {
  const { deps, team, eventId } = source;
  const surveys = await rowsOf(deps, team, z.array(surveyExportSchema), door("export_surveys"), [
    eventId,
  ]);
  yield `${BYTE_ORDER_MARK}${csvLines(surveysRows(surveys, source.language, source.t))}`;
}

async function* sponsorFile(source: FileSource): AsyncGenerator<string> {
  const { deps, team, eventId } = source;
  const totals = await readSponsorTotals(deps, team, eventId, source.sponsorId ?? "");
  if (totals === undefined) {
    throw new Error("The sponsor of an opened export is no longer there.");
  }
  yield `${BYTE_ORDER_MARK}${csvLines(sponsorRows(totals, source.language, source.t))}`;
}

const FILES: Readonly<Record<ExportKind, (source: FileSource) => AsyncGenerator<string>>> = {
  players: playersFile,
  completions: completionsFile,
  redemptions: redemptionsFile,
  submissions: submissionsFile,
  surveys: surveysFile,
  sponsor: sponsorFile,
};

/**
 * The file of an opened export, written in pieces as the rows are read so a 500,000-completion event is never held in
 * memory whole. The first piece carries the byte-order mark Excel needs for Arabic.
 */
export function exportStream(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  input: Readonly<{
    eventId: string;
    kind: ExportKind;
    sponsorId: string | undefined;
    language: Language;
    start: ExportStart;
  }>,
): Readable {
  const t: ExportTranslate = (key, params) => translate(key, input.language, params);
  return Readable.from(FILES[input.kind]({ ...input, deps, team, t }));
}

/**
 * The one-page report's data (FR-1208): the audit entry, then the three analytics answers and the surveys, with every
 * count a client or sponsor may not see left out (ADR-393). Undefined for an event the caller cannot reach.
 */
export async function readReport(
  deps: AnalyticsDeps,
  team: OrganizerContext,
  input: Readonly<{ eventId: string; requestId: string }>,
): Promise<Report | undefined> {
  const { eventId } = input;
  const start = await startExport(deps, team, { ...input, kind: "report", sponsorId: undefined });
  if (start === undefined) {
    return undefined;
  }
  const participation = participationSchema.parse(
    await readAnalytics(deps, team, eventId, "participation"),
  );
  const quests = questsAnalyticsSchema.parse(await readAnalytics(deps, team, eventId, "quests"));
  const economy = economySchema.parse(await readAnalytics(deps, team, eventId, "economy"));
  const surveys = await rowsOf(deps, team, z.array(surveyExportSchema), "export_surveys($1)", [
    eventId,
  ]);
  return buildReport({
    start,
    participation,
    quests,
    economy,
    surveys,
    generatedAt: new Date().toISOString(),
  });
}
