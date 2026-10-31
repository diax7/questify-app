import { z } from "zod";
import { toWesternDigits } from "#src/i18n/digits";
import { csvCell } from "#src/text/csv";
import { optionalPlainText as optionalText, plainText as plain } from "#src/text/plain-text";
import { toInstant } from "#src/time/event-time";

/**
 * The agenda (T-505, FR-808 to FR-810, FR-1787 to FR-1797, ADR-373): sessions an owner or editor adds by hand or from a
 * spreadsheet, that players see, register for and cancel. These types and checks are shared by the dashboard, the API
 * and the app; the database checks every field again.
 */

export const SESSION_KINDS = ["talk", "workshop", "activity"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export const SESSION_ACCESS = ["open", "registration"] as const;
export type SessionAccess = (typeof SESSION_ACCESS)[number];

/** Limits the database repeats. */
export const SESSION_LIMITS = {
  title: 120,
  description: 2000,
  place: 120,
  speakers: 10,
  speakerName: 80,
  seats: 100_000,
  reminderMinutes: { min: 1, max: 1440, default: 15 },
  /** The points a check-in pays (T-505b); 0 is none. */
  points: 100_000,
  maxHours: 24,
  importRows: 500,
} as const;

const instant = z.iso.datetime({ offset: true });

/** The fields as the dashboard sends them (`POST …/sessions`, `PUT …/sessions/{id}`). */
export const sessionBodySchema = z.strictObject({
  kind: z.enum(SESSION_KINDS),
  titleAr: optionalText(SESSION_LIMITS.title),
  titleEn: optionalText(SESSION_LIMITS.title),
  descriptionAr: optionalText(SESSION_LIMITS.description, true),
  descriptionEn: optionalText(SESSION_LIMITS.description, true),
  placeAr: optionalText(SESSION_LIMITS.place),
  placeEn: optionalText(SESSION_LIMITS.place),
  speakers: z
    .array(plain(SESSION_LIMITS.speakerName).min(1))
    .max(SESSION_LIMITS.speakers)
    .default([]),
  startsAt: instant,
  endsAt: instant,
  access: z.enum(SESSION_ACCESS),
  seats: z.number().int().min(1).max(SESSION_LIMITS.seats).nullable().optional(),
  closesAt: instant.nullable().optional(),
  walkIns: z.boolean().optional(),
  reminderMinutes: z
    .number()
    .int()
    .min(SESSION_LIMITS.reminderMinutes.min)
    .max(SESSION_LIMITS.reminderMinutes.max)
    .optional(),
  questId: z.uuid().nullable().optional(),
  points: z.number().int().min(0).max(SESSION_LIMITS.points).optional(),
});
export type SessionBody = z.input<typeof sessionBodySchema>;

/** `PUT …/sessions/{id}/registration`: open or closed, and the seat limit (null for none). */
export const sessionRegistrationSchema = z.strictObject({
  open: z.boolean(),
  seats: z.number().int().min(1).max(SESSION_LIMITS.seats).nullable(),
});

/** A session as the dashboard lists it, with its numbers (`session_team_item`). */
export const teamSessionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(SESSION_KINDS),
  titleAr: z.string().nullable(),
  titleEn: z.string().nullable(),
  descriptionAr: z.string().nullable(),
  descriptionEn: z.string().nullable(),
  placeAr: z.string().nullable(),
  placeEn: z.string().nullable(),
  speakers: z.array(z.string()),
  startsAt: z.string(),
  endsAt: z.string(),
  access: z.enum(SESSION_ACCESS),
  seats: z.number().nullable(),
  closesAt: z.string().nullable(),
  registrationOpen: z.boolean(),
  walkIns: z.boolean(),
  reminderMinutes: z.number(),
  questId: z.uuid().nullable(),
  points: z.number(),
  registered: z.number(),
  attended: z.number(),
  walkInCount: z.number(),
  noShows: z.number(),
});
export type TeamSession = z.infer<typeof teamSessionSchema>;

/** `GET …/sessions` for the dashboard. */
export const teamSessionListSchema = z.object({ sessions: z.array(teamSessionSchema) });

const bilingual = z.object({ ar: z.string().nullable(), en: z.string().nullable() });

/** Where a player stands with a session: `open` needs no registration. */
export const SESSION_STATUSES = ["open", "available", "registered", "full", "closed"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** A session as the app lists it for a member (`member_sessions`). */
export const memberSessionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(SESSION_KINDS),
  title: bilingual,
  description: bilingual,
  place: bilingual,
  speakers: z.array(z.string()),
  startsAt: z.string(),
  endsAt: z.string(),
  access: z.enum(SESSION_ACCESS),
  seats: z.number().nullable(),
  seatsLeft: z.number().nullable(),
  points: z.number(),
  registered: z.boolean(),
  checkedIn: z.boolean(),
  started: z.boolean(),
  cancellable: z.boolean(),
  status: z.enum(SESSION_STATUSES),
  quest: z.object({ id: z.uuid(), title: bilingual }).nullable(),
});
export type MemberSession = z.infer<typeof memberSessionSchema>;

/** `GET /v1/events/{id}/sessions` for the app. */
export const memberSessionListSchema = z.object({ sessions: z.array(memberSessionSchema) });

/** A session the door can check players in to now (`GET /v1/operator/events/{id}/sessions`). */
export const operatorSessionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(SESSION_KINDS),
  title: bilingual,
  startsAt: z.string(),
  endsAt: z.string(),
  access: z.enum(SESSION_ACCESS),
  walkIns: z.boolean(),
  points: z.number(),
});
export type OperatorSession = z.infer<typeof operatorSessionSchema>;
export const operatorSessionListSchema = z.object({ sessions: z.array(operatorSessionSchema) });

/** What the door's check-in route answers: an outcome, or a refusal with its reason, and who was scanned. */
export const doorAnswerSchema = z.object({
  result: z.string(),
  reason: z.string().optional(),
  walkIn: z.boolean().optional(),
  /** The session's points the player holds after this scan (`checked_in`, `already`); 0 when none. */
  points: z.number().default(0),
  player: z.object({ username: z.string() }).nullable().optional(),
});

/** What registering answers: registered, or an overlap with sessions already held (nothing written yet). */
export const sessionRegisterSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("registered"), replayed: z.boolean() }),
  z.object({
    outcome: z.literal("overlap"),
    overlaps: z.array(z.object({ id: z.uuid(), title: bilingual })),
  }),
]);
export type SessionRegisterAnswer = z.infer<typeof sessionRegisterSchema>;

/** What the door answers for a scanned player (`session_check_in`). */
export const SESSION_CHECK_IN_OUTCOMES = [
  "checked_in",
  "already",
  "not_registered",
  "too_early",
  "ended",
] as const;
export const sessionCheckInSchema = z.object({
  outcome: z.enum(SESSION_CHECK_IN_OUTCOMES),
  walkIn: z.boolean().optional(),
  points: z.number().optional(),
  player: z.object({ username: z.string(), avatar: z.string() }),
});
export type SessionCheckInAnswer = z.infer<typeof sessionCheckInSchema>;

/** What a session or a spreadsheet row is checked against: the event's dates (a field is null when the event has none). */
export type SessionWindow = Readonly<{ startsAt: string | null; endsAt: string | null }>;

function timingIssue(starts: number, ends: number, window: SessionWindow): string | null {
  if (ends <= starts) return "endsAt:before_start";
  if (ends - starts > SESSION_LIMITS.maxHours * 3_600_000) return "endsAt:too_long";
  const before = window.startsAt !== null && starts < Date.parse(window.startsAt);
  const after = window.endsAt !== null && ends > Date.parse(window.endsAt);
  return before || after ? "startsAt:outside_event" : null;
}

const hasText = (value: string | null | undefined): boolean => (value ?? "").trim() !== "";

/**
 * The first reason a session cannot be saved, as the database names it (`endsAt:before_start`, `title`...), or null.
 * The text rules are the schema's; this is the part that compares fields.
 */
export function sessionIssue(body: SessionBody, window: SessionWindow): string | null {
  if (!hasText(body.titleAr) && !hasText(body.titleEn)) return "title";
  const starts = Date.parse(body.startsAt);
  const timing = timingIssue(starts, Date.parse(body.endsAt), window);
  if (timing !== null) return timing;
  const closes = body.access === "registration" ? body.closesAt : null;
  return closes != null && Date.parse(closes) > starts ? "closesAt" : null;
}

/** The spreadsheet's columns, in the order the template lists them. */
export const SESSION_CSV_COLUMNS = [
  "type",
  "title_en",
  "title_ar",
  "start",
  "end",
  "place_en",
  "place_ar",
  "speakers",
  "description_en",
  "description_ar",
  "access",
  "seats",
  "points",
] as const;
type CsvColumn = (typeof SESSION_CSV_COLUMNS)[number];

export type SessionImportFailure = Readonly<{ line: number; issue: string }>;
export type SessionImport = Readonly<{ rows: SessionBody[]; failed: SessionImportFailure[] }>;

/** The delimiter a spreadsheet saved as CSV uses: a comma, or a semicolon (Excel in Arabic and many other locales). */
function delimiterOf(header: string): string {
  const counts = [",", ";", "\t"].map((mark) => [mark, header.split(mark).length] as const);
  return counts.reduce((best, next) => (next[1] > best[1] ? next : best))[0];
}

/** Reads a quoted cell from just after its opening quote: its text (a doubled quote is one quote) and where it ends. */
function readQuoted(text: string, start: number): { value: string; next: number } {
  let value = "";
  let index = start;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char !== '"') {
      value += char;
      index += 1;
    } else if (text.charAt(index + 1) === '"') {
      value += '"';
      index += 2;
    } else return { value, next: index + 1 };
  }
  return { value, next: index };
}

/** Splits CSV text into rows of cells: quoted cells keep their delimiters, line breaks and doubled quotes. */
function csvRows(text: string, delimiter: string): string[][] {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let index = 0;
  while (index < lines.length) {
    const char = lines.charAt(index);
    if (char === '"') {
      const quoted = readQuoted(lines, index + 1);
      cell += quoted.value;
      index = quoted.next;
      continue;
    }
    index += 1;
    if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

const normalizeColumn = (name: string): string =>
  name
    .replace(/^﻿/u, "")
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/gu, "_");

/** A local time typed as `2026-11-02 14:30` (or with a `T`), in the event's zone, as an ISO instant; null when it is not one. */
function csvInstant(value: string, zone: string): string | null {
  const local = toWesternDigits(value.trim()).replace(" ", "T");
  try {
    return toInstant(local.length === 16 ? local : local.slice(0, 16), zone).toISOString();
  } catch {
    return null;
  }
}

/** The seat limit typed in a cell: null for none, undefined when it is not a whole number from 1 to 999999. */
function csvSeats(value: string): number | null | undefined {
  const text = toWesternDigits(value.trim());
  if (text === "") return null;
  const seats = /^[0-9]{1,6}$/u.test(text) ? Number(text) : 0;
  return seats === 0 ? undefined : seats;
}

/** The points typed in a cell: 0 for none, undefined when it is not a whole number from 0 to 100000. */
function csvPoints(value: string): number | undefined {
  const text = toWesternDigits(value.trim());
  if (text === "") return 0;
  const points = /^[0-9]{1,6}$/u.test(text) ? Number(text) : -1;
  return points >= 0 && points <= SESSION_LIMITS.points ? points : undefined;
}

/** The access typed in a cell: an empty cell is open; undefined when it is neither word. */
function csvAccess(value: string): SessionAccess | undefined {
  const text = value.trim().toLowerCase();
  return text === "" ? "open" : SESSION_ACCESS.find((known) => known === text);
}

const blankToNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

function csvRow(cells: Readonly<Record<CsvColumn, string>>, zone: string): SessionBody | string {
  const kind = SESSION_KINDS.find((known) => known === cells.type.trim().toLowerCase());
  const startsAt = csvInstant(cells.start, zone);
  const endsAt = csvInstant(cells.end, zone);
  const access = csvAccess(cells.access);
  const seats = csvSeats(cells.seats);
  const points = csvPoints(cells.points);
  if (kind === undefined) return "kind";
  if (startsAt === null) return "startsAt";
  if (endsAt === null) return "endsAt";
  if (access === undefined) return "access";
  if (seats === undefined) return "seats";
  if (points === undefined) return "points";
  return {
    kind,
    titleEn: blankToNull(cells.title_en),
    titleAr: blankToNull(cells.title_ar),
    placeEn: blankToNull(cells.place_en),
    placeAr: blankToNull(cells.place_ar),
    descriptionEn: blankToNull(cells.description_en),
    descriptionAr: blankToNull(cells.description_ar),
    speakers: cells.speakers
      .split(/[;|]/u)
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    startsAt,
    endsAt,
    access,
    seats: access === "registration" ? seats : null,
    points,
  };
}

/** One data line: the session it holds, or the issue that stops it (the database's issue names). */
function csvLine(
  cells: readonly string[],
  header: readonly string[],
  zone: string,
  window: SessionWindow,
): SessionBody | string {
  const named = Object.fromEntries(
    SESSION_CSV_COLUMNS.map((column) => [column, cells[header.indexOf(column)] ?? ""]),
  ) as Record<CsvColumn, string>;
  const parsed = csvRow(named, zone);
  if (typeof parsed === "string") return parsed;
  const issue = sessionIssue(parsed, window);
  if (issue !== null) return issue;
  const checked = sessionBodySchema.safeParse(parsed);
  return checked.success ? parsed : String(checked.error.issues[0]?.path[0] ?? "session");
}

/**
 * The sessions in a spreadsheet saved as CSV (FR-808, FR-1794): the first row names the columns (`SESSION_CSV_COLUMNS`),
 * times are local to the event's zone (`2026-11-02 14:30`), speakers are separated by `;`. A row that cannot be read is
 * listed with its line number and the reason (the database's issue names, so the same words apply); the others are
 * returned to import. More than 500 data rows are not read.
 */
export function parseSessionsCsv(text: string, zone: string, window: SessionWindow): SessionImport {
  const clean = text.replace(/^\uFEFF/u, "");
  const first = clean.split(/\r?\n/u, 1)[0] ?? "";
  const table = csvRows(clean, delimiterOf(first));
  const header = (table.shift() ?? []).map(normalizeColumn);
  const rows: SessionBody[] = [];
  const failed: SessionImportFailure[] = [];
  table.slice(0, SESSION_LIMITS.importRows).forEach((cells, position) => {
    const line = csvLine(cells, header, zone, window);
    if (typeof line === "string") failed.push({ line: position + 2, issue: line });
    else rows.push(line);
  });
  return { rows, failed };
}

/** The attendance report as CSV text (FR-1795): one line a session, with a byte-order mark first so Excel reads Arabic. */
export function sessionReportCsv(
  sessions: readonly TeamSession[],
  zone: string,
  header: readonly string[],
): string {
  const day = (value: string): string => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
  };
  const lines = sessions.map((session) =>
    [
      session.titleEn ?? session.titleAr ?? "",
      session.kind,
      day(session.startsAt),
      session.placeEn ?? session.placeAr ?? "",
      session.seats ?? "",
      session.registered,
      session.attended,
      session.walkInCount,
      session.noShows,
    ]
      .map((value) => csvCell(value))
      .join(","),
  );
  return `﻿${[header.map((value) => csvCell(value)).join(","), ...lines].join("\r\n")}\r\n`;
}
