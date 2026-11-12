import { z } from "zod";

/**
 * Reports and moderation (T-705b; FR-1404, FR-1411, FR-1413, FR-1414): what a player reports, Questify's queue in the
 * console, the unpublish of a quest, a reward or an announcement, and the console's list of open anti-cheat flags. The
 * database doors (migration 0121) answer these shapes.
 */

/** What a player can report (STORE_COMPLIANCE 1.2): organizer content, the event's page, or a username. */
export const REPORT_KINDS = [
  "quest",
  "reward",
  "announcement",
  "category",
  "session",
  "sponsor",
  "event",
  "username",
  "media",
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const REPORT_REASONS = [
  "offensive",
  "hateful",
  "sexual",
  "spam",
  "misleading",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The longest note a reporter may add. */
export const REPORT_NOTE_MAX = 500;

/** What `POST /v1/reports` takes: a row's id for content, a username (and the event it was seen in) for a player. */
export const reportRequestSchema = z.strictObject({
  kind: z.enum(REPORT_KINDS),
  targetId: z.uuid().optional(),
  username: z.string().min(1).max(120).optional(),
  eventId: z.uuid().optional(),
  reason: z.enum(REPORT_REASONS),
  note: z
    .string()
    .max(REPORT_NOTE_MAX * 4)
    .optional(),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

/**
 * The kinds Questify can unpublish (ADR-434): a quest, a reward, an announcement, and a photo on an event's wall
 * (`media`, T-504b, ADR-830); the rest are handled by suspending the event.
 */
export const HOLD_KINDS = ["quest", "reward", "announcement", "media"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

/** Why Questify unpublished something; the organizer sees the code's words and the admin's note. */
export const HOLD_REASONS = REPORT_REASONS;
export type HoldReason = ReportReason;

/** How the console closes a target's open reports. */
export const REPORT_OUTCOMES = [
  "dismissed",
  "unpublished",
  "event_suspended",
  "username_changed",
  "player_banned",
] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

/** Whether Questify can unpublish this kind (the queue's Unpublish action). */
export const isHoldKind = (kind: string): kind is HoldKind =>
  (HOLD_KINDS as readonly string[]).includes(kind);

const instant = z.string().min(1);
const pair = z.strictObject({ ar: z.string().optional(), en: z.string().optional() });

/** What a report kept of its target: a title and a text in both languages, or a username. */
export const reportSnapshotSchema = z.strictObject({
  title: pair.optional(),
  text: pair.optional(),
  username: z.string().optional(),
});
export type ReportSnapshot = z.infer<typeof reportSnapshotSchema>;

const queueEventSchema = z.strictObject({ id: z.uuid(), name: pair, organizer: z.string() });

/**
 * One open target of the queue: how many reports, the oldest and newest, the latest snapshot, and (T-701b, ADR-493)
 * whether any open report is urgent, the earliest due time, and whether it passed.
 */
export const reportTargetSchema = z.strictObject({
  kind: z.enum(REPORT_KINDS),
  targetId: z.uuid(),
  reports: z.number().int().min(1),
  firstAt: instant,
  lastAt: instant,
  urgent: z.boolean(),
  dueAt: instant,
  overdue: z.boolean(),
  snapshot: reportSnapshotSchema,
  event: queueEventSchema.nullable(),
});
export type ReportTarget = z.infer<typeof reportTargetSchema>;

/** What `GET /v1/admin/reports` answers: 100 open targets (urgent first, then the earliest due) and the counts. */
export const reportQueueSchema = z.strictObject({
  targets: z.array(reportTargetSchema).max(100),
  total: z.number().int().min(0),
  urgentTotal: z.number().int().min(0),
});
export type ReportQueue = z.infer<typeof reportQueueSchema>;

export const reportEntrySchema = z.strictObject({
  id: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  note: z.string().nullable(),
  marked: z.boolean(),
  status: z.enum(["open", "actioned", "dismissed"]),
  outcome: z.enum(REPORT_OUTCOMES).nullable(),
  createdAt: instant,
  handledAt: instant.nullable(),
  snapshot: reportSnapshotSchema,
  urgent: z.boolean(),
  dueAt: instant,
  reporter: z.string().nullable(),
});
export type ReportEntry = z.infer<typeof reportEntrySchema>;

export const liveHoldSchema = z.strictObject({
  id: z.uuid(),
  reasonCode: z.enum(HOLD_REASONS),
  note: z.string(),
  heldAt: instant,
});
export type LiveHold = z.infer<typeof liveHoldSchema>;

/** What `GET /v1/admin/reports/:kind/:targetId` answers. */
export const reportDetailSchema = z.strictObject({
  kind: z.enum(REPORT_KINDS),
  targetId: z.uuid(),
  current: reportSnapshotSchema.nullable(),
  player: z
    .strictObject({ id: z.uuid(), status: z.enum(["active", "banned", "deleted"]) })
    .nullable(),
  event: queueEventSchema.extend({ suspended: z.boolean() }).nullable(),
  hold: liveHoldSchema.nullable(),
  reports: z.array(reportEntrySchema).max(200),
  /** A reported wall photo (`media`): a 5-minute signed read, null when it is gone or there is no bucket. */
  photo: z.strictObject({ url: z.string(), expiresAt: instant }).nullable().optional(),
});
export type ReportDetail = z.infer<typeof reportDetailSchema>;

/** The anti-cheat flag kinds (T-209 and later; the `flag` table's CHECK). */
export const CHEAT_FLAG_KINDS = [
  "shared_device",
  "burst",
  "far_from_venue",
  "impossible_speed",
  "minigame",
  "nfc_copy",
] as const;

/** One event with open flags, as the console's Flags page lists it. */
export const flagEventSchema = z.strictObject({
  eventId: z.uuid(),
  name: pair,
  organizer: z.string(),
  open: z.number().int().min(1),
  oldestAt: instant,
  kinds: z.array(z.enum(CHEAT_FLAG_KINDS)),
  suspended: z.boolean(),
});
export type FlagEvent = z.infer<typeof flagEventSchema>;

/** What `GET /v1/admin/flags` answers: the 100 events whose open flags are oldest, and all open flags counted. */
export const flagsAnswerSchema = z.strictObject({
  events: z.array(flagEventSchema).max(100),
  total: z.number().int().min(0),
});
export type FlagsAnswer = z.infer<typeof flagsAnswerSchema>;

/** A live hold as the event's team sees it on the dashboard (`GET /v1/events/:eventId/content-holds`). */
export const teamHoldSchema = z.strictObject({
  kind: z.enum(HOLD_KINDS),
  targetId: z.uuid(),
  reasonCode: z.enum(HOLD_REASONS),
  note: z.string(),
  heldAt: instant,
});
export type TeamHold = z.infer<typeof teamHoldSchema>;
export const teamHoldsSchema = z.strictObject({ holds: z.array(teamHoldSchema) });
