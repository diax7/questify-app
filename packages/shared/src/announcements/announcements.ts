import { z } from "zod";
import { toWesternDigits } from "#src/i18n/digits";
import { textIssue, type InvitationNameIssue } from "#src/invitation-campaigns/name-rule";

/**
 * Organizer announcements (T-502, FR-1107, FR-1108, ADR-358): the text an owner or editor writes in Arabic and English,
 * sent by push and into the app's center and list, never by email or SMS. The text goes to up to 50,000 phones under
 * Questify's name, so it is cleaned, bounded and run through the T-409 name rule before it is stored; the dashboard's
 * preview and the API use these same functions, and the database stores what the API sends and bounds it again.
 */

/** The title and the full text (shown in the app's list), counted in code points. */
export const ANNOUNCEMENT_TITLE_MAX = 60;
export const ANNOUNCEMENT_BODY_MAX = 500;
/** The push and the center carry the text cut to this many code points, `...` included. */
export const ANNOUNCEMENT_PUSH_BODY_MAX = 140;
/** A scheduled announcement goes out at least this long from now, and at most this long. */
export const ANNOUNCEMENT_SCHEDULE_MIN_MINUTES = 2;
export const ANNOUNCEMENT_SCHEDULE_MAX_DAYS = 180;
/** The most announcements the app lists for an event. */
export const ANNOUNCEMENT_LIST_MAX = 50;

export const ANNOUNCEMENT_FIELDS = ["titleAr", "titleEn", "bodyAr", "bodyEn"] as const;
export type AnnouncementField = (typeof ANNOUNCEMENT_FIELDS)[number];

/** Why a field cannot be sent: empty, over its limit, or the name rule's findings (an address, a phone number...). */
export type AnnouncementIssue = "required" | "too_long" | InvitationNameIssue;

/** The fields as the dashboard sends them (`POST …/announcements`); `sendAt` null or absent means now. */
export const announcementBodySchema = z.strictObject({
  titleAr: z.string().max(1000),
  titleEn: z.string().max(1000),
  bodyAr: z.string().max(5000),
  bodyEn: z.string().max(5000),
  sendAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type AnnouncementBody = z.infer<typeof announcementBodySchema>;

/** The checked draft: the cleaned fields and the cut texts the push and the center carry. */
export type AnnouncementDraft = Readonly<Record<AnnouncementField, string>> &
  Readonly<{ pushBodyAr: string; pushBodyEn: string }>;

export type AnnouncementCheck =
  | Readonly<{ ok: true; draft: AnnouncementDraft }>
  | Readonly<{ ok: false; field: AnnouncementField; issue: AnnouncementIssue }>;

/** Format and default-ignorable characters (joiners, variation selectors, bidi marks): built on first use (Hermes). */
let invisible: RegExp | undefined;
const invisiblePattern = (): RegExp =>
  (invisible ??= new RegExp(String.raw`[\p{Cf}\p{Default_Ignorable_Code_Point}]`, "gu"));

const codePoints = (text: string): string[] => Array.from(text);

/**
 * The text as it is stored and sent: invisible characters removed (they can hide `example.\uFE0Fcom` from a reader), runs
 * of whitespace and line breaks made one space, the ends trimmed, Arabic-Indic digits made Western (ADR-018). An emoji
 * that needs a joiner or a variation selector loses it; a single-code-point emoji is untouched.
 */
export function cleanAnnouncementText(raw: string): string {
  return toWesternDigits(raw.replace(invisiblePattern(), "").replace(/\s+/gu, " ").trim());
}

/**
 * The cut text the push and the center carry: the text itself when it fits in 140 code points, else its first 137 with
 * `...`. Never splits a surrogate pair.
 */
export function announcementPushBody(body: string): string {
  const points = codePoints(body);
  return points.length <= ANNOUNCEMENT_PUSH_BODY_MAX
    ? body
    : `${points
        .slice(0, ANNOUNCEMENT_PUSH_BODY_MAX - 3)
        .join("")
        .trimEnd()}...`;
}

/** Why one cleaned field cannot be sent, or null: empty, too long, or refused by the name rule. */
export function announcementTextIssue(
  text: string,
  field: AnnouncementField,
): AnnouncementIssue | null {
  const max = field.startsWith("title") ? ANNOUNCEMENT_TITLE_MAX : ANNOUNCEMENT_BODY_MAX;
  if (text === "") return "required";
  if (codePoints(text).length > max) return "too_long";
  return textIssue(text);
}

/**
 * Cleans the four fields and checks each in order (Arabic title, English title, Arabic text, English text); the first
 * that fails is named with why. On success the draft holds the cleaned fields and the two cut texts.
 */
export function checkAnnouncement(
  body: Pick<AnnouncementBody, AnnouncementField>,
): AnnouncementCheck {
  const clean: Record<AnnouncementField, string> = {
    titleAr: cleanAnnouncementText(body.titleAr),
    titleEn: cleanAnnouncementText(body.titleEn),
    bodyAr: cleanAnnouncementText(body.bodyAr),
    bodyEn: cleanAnnouncementText(body.bodyEn),
  };
  for (const field of ANNOUNCEMENT_FIELDS) {
    const issue = announcementTextIssue(clean[field], field);
    if (issue !== null) return { ok: false, field, issue };
  }
  return {
    ok: true,
    draft: {
      ...clean,
      pushBodyAr: announcementPushBody(clean.bodyAr),
      pushBodyEn: announcementPushBody(clean.bodyEn),
    },
  };
}

/** Whether a title and a cut text, as frozen on a notice, may still be pushed (the renderer asks again). */
export function announcementRenderable(title: string, pushBody: string): boolean {
  return (
    codePoints(title).length <= ANNOUNCEMENT_TITLE_MAX &&
    codePoints(pushBody).length <= ANNOUNCEMENT_PUSH_BODY_MAX &&
    announcementTextIssue(title, "titleEn") === null &&
    announcementTextIssue(pushBody, "bodyEn") === null
  );
}

/** The most announcements an event may send in a rolling hour and in a rolling day (the database's door enforces it). */
export const ANNOUNCEMENT_RATE = { perHour: 3, perDay: 10 } as const;

/** The states an announcement can be in (`announcement.status`). */
export const ANNOUNCEMENT_STATES = ["scheduled", "sent", "cancelled", "skipped"] as const;
export type AnnouncementState = (typeof ANNOUNCEMENT_STATES)[number];

/** Why a scheduled announcement was not sent (`announcement.skip_reason`). */
export const ANNOUNCEMENT_SKIP_REASONS = ["event_closed", "not_live", "late"] as const;
export type AnnouncementSkipReason = (typeof ANNOUNCEMENT_SKIP_REASONS)[number];

/** One announcement as the dashboard lists it (`GET …/announcements`). */
export const announcementViewSchema = z.strictObject({
  id: z.uuid(),
  titleAr: z.string(),
  titleEn: z.string(),
  bodyAr: z.string(),
  bodyEn: z.string(),
  status: z.enum(ANNOUNCEMENT_STATES),
  sendAt: z.string(),
  sentAt: z.string().nullable(),
  /** Sent during the rehearsal: only the rehearsal accounts were told. */
  rehearsal: z.boolean(),
  skipReason: z.enum(ANNOUNCEMENT_SKIP_REASONS).nullable(),
  /** The players it reached in the app, rounded (exact below 10, else the nearest 10); null until it is sent. */
  delivered: z.number().int().nonnegative().nullable(),
  /** True while the fan-out is still writing center rows. */
  delivering: z.boolean(),
});
export type AnnouncementView = z.infer<typeof announcementViewSchema>;

/** One announcement as a member reads it (`GET /v1/events/{id}/announcements`). */
export const memberAnnouncementSchema = z.strictObject({
  id: z.uuid(),
  title: z.strictObject({ ar: z.string(), en: z.string() }),
  body: z.strictObject({ ar: z.string(), en: z.string() }),
  sentAt: z.string(),
});
export type MemberAnnouncement = z.infer<typeof memberAnnouncementSchema>;
