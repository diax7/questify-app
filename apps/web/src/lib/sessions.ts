import {
  SESSION_CSV_COLUMNS,
  sessionBodySchema,
  sessionIssue,
  sessionReportCsv,
  toInstant,
  toLocalInput,
  type MessageKey,
  type SessionAccess,
  type SessionBody,
  type SessionKind,
  type SessionWindow,
  type TeamSession,
} from "@questify/shared";

/** The form's fields as typed: text, a local time in the event's zone, and numbers as digits. */
export type SessionDraft = {
  kind: SessionKind;
  titleAr: string;
  titleEn: string;
  descriptionAr: string;
  descriptionEn: string;
  placeAr: string;
  placeEn: string;
  speakers: string;
  startsAt: string;
  endsAt: string;
  access: SessionAccess;
  seats: string;
  closesAt: string;
  walkIns: boolean;
  reminderMinutes: string;
  questId: string;
};

export const blankSession = (): SessionDraft => ({
  kind: "talk",
  titleAr: "",
  titleEn: "",
  descriptionAr: "",
  descriptionEn: "",
  placeAr: "",
  placeEn: "",
  speakers: "",
  startsAt: "",
  endsAt: "",
  access: "open",
  seats: "",
  closesAt: "",
  walkIns: false,
  reminderMinutes: "",
  questId: "",
});

const localOf = (instant: string | null, zone: string): string =>
  instant === null ? "" : toLocalInput(new Date(instant), zone);

const orEmpty = (text: string | null): string => text ?? "";

/** A saved session as the form shows it, its times in the event's zone. */
export function draftOf(session: TeamSession, zone: string): SessionDraft {
  return {
    kind: session.kind,
    titleAr: orEmpty(session.titleAr),
    titleEn: orEmpty(session.titleEn),
    descriptionAr: orEmpty(session.descriptionAr),
    descriptionEn: orEmpty(session.descriptionEn),
    placeAr: orEmpty(session.placeAr),
    placeEn: orEmpty(session.placeEn),
    speakers: session.speakers.join("\n"),
    startsAt: localOf(session.startsAt, zone),
    endsAt: localOf(session.endsAt, zone),
    access: session.access,
    seats: session.seats === null ? "" : String(session.seats),
    closesAt: localOf(session.closesAt, zone),
    walkIns: session.walkIns,
    reminderMinutes: String(session.reminderMinutes),
    questId: orEmpty(session.questId),
  };
}

export type SessionPayload =
  | Readonly<{ ok: true; body: SessionBody }>
  | Readonly<{ ok: false; issue: string }>;

const orNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** A local time as an ISO instant, "" as null, and undefined when the zone cannot read it. */
function instantOf(local: string, zone: string): string | null | undefined {
  if (local.trim() === "") return null;
  try {
    return toInstant(local, zone).toISOString();
  } catch {
    return undefined;
  }
}

const wholeNumber = (text: string): number | null | undefined => {
  if (text.trim() === "") return null;
  return /^[0-9]{1,6}$/u.test(text.trim()) ? Number(text.trim()) : undefined;
};

type Moments = Readonly<{ startsAt: string; endsAt: string; closesAt: string | null }>;

function momentsOf(draft: SessionDraft, zone: string): Moments | string {
  const startsAt = instantOf(draft.startsAt, zone);
  const endsAt = instantOf(draft.endsAt, zone);
  const closesAt = instantOf(draft.closesAt, zone);
  if (startsAt == null) return "startsAt";
  if (endsAt == null) return "endsAt";
  if (closesAt === undefined) return "closesAt";
  return { startsAt, endsAt, closesAt };
}

function bodyOf(
  draft: SessionDraft,
  moments: Moments,
  seats: number | null,
  reminder: number | null,
): SessionBody {
  const registration = draft.access === "registration";
  return {
    kind: draft.kind,
    titleAr: orNull(draft.titleAr),
    titleEn: orNull(draft.titleEn),
    descriptionAr: orNull(draft.descriptionAr),
    descriptionEn: orNull(draft.descriptionEn),
    placeAr: orNull(draft.placeAr),
    placeEn: orNull(draft.placeEn),
    speakers: draft.speakers
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    startsAt: moments.startsAt,
    endsAt: moments.endsAt,
    access: draft.access,
    seats: registration ? seats : null,
    closesAt: registration ? moments.closesAt : null,
    walkIns: registration && draft.walkIns,
    ...(reminder === null ? {} : { reminderMinutes: reminder }),
    questId: orNull(draft.questId),
  };
}

/** The request body for a draft, or the first issue (the database's names) that stops it. */
export function sessionPayload(
  draft: SessionDraft,
  zone: string,
  window: SessionWindow,
): SessionPayload {
  const moments = momentsOf(draft, zone);
  if (typeof moments === "string") return { ok: false, issue: moments };
  const seats = wholeNumber(draft.seats);
  const reminder = wholeNumber(draft.reminderMinutes);
  if (seats === undefined) return { ok: false, issue: "seats" };
  if (reminder === undefined) return { ok: false, issue: "reminderMinutes" };
  const body = bodyOf(draft, moments, seats, reminder);
  const checked = sessionBodySchema.safeParse(body);
  if (!checked.success) {
    return { ok: false, issue: String(checked.error.issues[0]?.path[0] ?? "session") };
  }
  const issue = sessionIssue(body, window);
  return issue === null ? { ok: true, body } : { ok: false, issue };
}

const ISSUE_KEYS: Readonly<Record<string, MessageKey>> = {
  session: "sessions.issue.session",
  kind: "sessions.issue.kind",
  title: "sessions.issue.title",
  titleAr: "sessions.issue.titleAr",
  titleEn: "sessions.issue.titleEn",
  descriptionAr: "sessions.issue.descriptionAr",
  descriptionEn: "sessions.issue.descriptionEn",
  placeAr: "sessions.issue.placeAr",
  placeEn: "sessions.issue.placeEn",
  startsAt: "sessions.issue.startsAt",
  endsAt: "sessions.issue.endsAt",
  "endsAt:before_start": "sessions.issue.endsAtBeforeStart",
  "endsAt:too_long": "sessions.issue.endsAtTooLong",
  "startsAt:outside_event": "sessions.issue.outsideEvent",
  access: "sessions.issue.access",
  seats: "sessions.issue.seats",
  speakers: "sessions.issue.speakers",
  closesAt: "sessions.issue.closesAt",
  questId: "sessions.issue.questId",
  reminderMinutes: "sessions.issue.reminderMinutes",
  rows: "sessions.issue.rows",
};

/** The message for an issue the form or the database named; an unknown one reads as the general refusal. */
export const sessionIssueKey = (issue: string): MessageKey =>
  ISSUE_KEYS[issue] ?? "sessions.issue.session";

/** The import file's first row and one example row, so a spreadsheet can start from it. */
export function sessionTemplateCsv(): string {
  const example = [
    "talk",
    "Opening talk",
    "كلمة الافتتاح",
    "2026-11-02 10:00",
    "2026-11-02 11:00",
    "Main hall",
    "القاعة الرئيسية",
    "Sara; Omar",
    "",
    "",
    "registration",
    "100",
  ];
  return `${SESSION_CSV_COLUMNS.join(",")}\r\n${example.join(",")}\r\n`;
}

/** The attendance report with the page's column names. */
export function sessionReport(
  sessions: readonly TeamSession[],
  zone: string,
  names: Readonly<
    Record<
      | "title"
      | "type"
      | "start"
      | "place"
      | "seats"
      | "registered"
      | "attended"
      | "walkIns"
      | "noShows",
      string
    >
  >,
): string {
  return sessionReportCsv(sessions, zone, [
    names.title,
    names.type,
    names.start,
    names.place,
    names.seats,
    names.registered,
    names.attended,
    names.walkIns,
    names.noShows,
  ]);
}
