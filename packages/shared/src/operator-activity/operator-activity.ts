import { z } from "zod";
import { cleanAnnouncementText } from "#src/announcements/announcements";
import { textIssue, type InvitationNameIssue } from "#src/invitation-campaigns/name-rule";

/**
 * Operator activity and the staff briefing (T-617, FR-1844, ADR-402). The activity is what the Operators page reads
 * (`GET …/operators/activity`): per operator the numbers of the event's day and the last thing they did, and the latest
 * actions of all of them. Usernames and counts only: never a player an operator served. The briefing is a short push to
 * the event's operators; its text is cleaned and run through the name rule like an announcement, and is short enough
 * that the push and the center carry it whole.
 */

/** A briefing's title and text, counted in code points; the text is the whole push, never cut. */
export const STAFF_BRIEFING_TITLE_MAX = 60;
export const STAFF_BRIEFING_BODY_MAX = 140;
/** The most briefings an event may send in a rolling hour and in a rolling day (the database's door enforces it). */
export const STAFF_BRIEFING_RATE = { perHour: 3, perDay: 10 } as const;
/** An operator with no action for this long is shown as quiet. */
export const OPERATOR_QUIET_MINUTES = 30;
/** The latest actions shown at first, and the most the page can ask for. */
export const OPERATOR_RECENT_FIRST = 5;
export const OPERATOR_RECENT_MAX = 50;

export const STAFF_BRIEFING_FIELDS = ["titleAr", "titleEn", "bodyAr", "bodyEn"] as const;
export type StaffBriefingField = (typeof STAFF_BRIEFING_FIELDS)[number];

/** Why a field cannot be sent: empty, over its limit, or the name rule's findings (an address, a phone number...). */
export type StaffBriefingIssue = "required" | "too_long" | InvitationNameIssue;

/** The fields as the dashboard sends them (`POST …/operators/briefing`). */
export const staffBriefingBodySchema = z.strictObject({
  titleAr: z.string().max(1000),
  titleEn: z.string().max(1000),
  bodyAr: z.string().max(1000),
  bodyEn: z.string().max(1000),
});
export type StaffBriefingBody = z.infer<typeof staffBriefingBodySchema>;

export type StaffBriefingCheck =
  | Readonly<{ ok: true; draft: StaffBriefingBody }>
  | Readonly<{ ok: false; field: StaffBriefingField; issue: StaffBriefingIssue }>;

export const blankStaffBriefing = (): StaffBriefingBody => ({
  titleAr: "",
  titleEn: "",
  bodyAr: "",
  bodyEn: "",
});

/** Why one cleaned field cannot be sent, or null. */
export function staffBriefingTextIssue(
  text: string,
  field: StaffBriefingField,
): StaffBriefingIssue | null {
  const max = field.startsWith("title") ? STAFF_BRIEFING_TITLE_MAX : STAFF_BRIEFING_BODY_MAX;
  if (text === "") return "required";
  if (Array.from(text).length > max) return "too_long";
  return textIssue(text);
}

/** Cleans the four fields as an announcement's are and checks each in order; the first that fails is named. */
export function checkStaffBriefing(body: StaffBriefingBody): StaffBriefingCheck {
  const draft: StaffBriefingBody = {
    titleAr: cleanAnnouncementText(body.titleAr),
    titleEn: cleanAnnouncementText(body.titleEn),
    bodyAr: cleanAnnouncementText(body.bodyAr),
    bodyEn: cleanAnnouncementText(body.bodyEn),
  };
  for (const field of STAFF_BRIEFING_FIELDS) {
    const issue = staffBriefingTextIssue(draft[field], field);
    if (issue !== null) return { ok: false, field, issue };
  }
  return { ok: true, draft };
}

/** What an operator did: the ledger's operator entries (a scan, a session check-in, an award, a hand-over, a cancel), a review, an answer. */
export const OPERATOR_ACTIONS = [
  "scan",
  "check_in",
  "award",
  "hand_over",
  "cancel",
  "review",
  "answer",
] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const count = z.number().int().min(0);
const title = z.string().nullable();

/** One station an operator scanned today. */
export const operatorStationSchema = z.strictObject({
  questId: z.uuid(),
  titleAr: title,
  titleEn: title,
  scans: count,
  lastAt: z.string(),
});

/** One operator: the numbers of the event's day, the last thing they did and their busiest stations. */
export const operatorActivityRowSchema = z.strictObject({
  /** The staff assignment's id, the same as the operators list. */
  id: z.uuid(),
  username: z.string(),
  scansHour: count,
  scans: count,
  awards: count,
  handOvers: count,
  /** Submissions reviewed and help requests answered today. */
  handled: count,
  lastAt: z.string().nullable(),
  lastAction: z.enum(OPERATOR_ACTIONS).nullable(),
  stations: operatorStationSchema.array().max(5),
});
export type OperatorActivityRow = z.infer<typeof operatorActivityRowSchema>;

export const operatorRecentSchema = z.strictObject({
  at: z.string(),
  action: z.enum(OPERATOR_ACTIONS),
  operatorId: z.uuid(),
  username: z.string(),
  questId: z.uuid().nullable(),
  titleAr: title,
  titleEn: title,
});
export type OperatorRecent = z.infer<typeof operatorRecentSchema>;

export const staffBriefingViewSchema = z.strictObject({
  id: z.uuid(),
  titleAr: z.string(),
  titleEn: z.string(),
  bodyAr: z.string(),
  bodyEn: z.string(),
  recipients: count,
  sentAt: z.string(),
});
export type StaffBriefingView = z.infer<typeof staffBriefingViewSchema>;

/** `GET …/operators/activity`. */
export const operatorActivitySchema = z.strictObject({
  asOf: z.string(),
  operators: operatorActivityRowSchema.array(),
  recent: operatorRecentSchema.array().max(OPERATOR_RECENT_MAX),
  briefings: staffBriefingViewSchema.array().max(5),
});
export type OperatorActivity = z.infer<typeof operatorActivitySchema>;

/** `POST …/operators/briefing`. */
export const staffBriefingSentSchema = z.strictObject({
  id: z.uuid(),
  recipients: count,
  replayed: z.boolean(),
});
export type StaffBriefingSent = z.infer<typeof staffBriefingSentSchema>;
