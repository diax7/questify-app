import { z } from "zod";

/**
 * Questify invitations (T-409, ADR-329 to ADR-333): the owner requests a campaign for one public event on the web, a
 * Questify admin approves it in the console with a message cap and a send time, and Questify sends one SMS to each
 * chosen player who opted in. Organizers see only rounded, daily-published counts; admins see exact ones. Nothing here
 * holds a price: the Questify team agrees it outside the platform (ADR-076).
 */

/** A campaign asks for, and is capped at, 50 to 100,000 messages; fewer than 50 matching players are not sent. */
export const INVITATION_MIN_SIZE = 50;
export const INVITATION_MAX_SIZE = 100_000;
/** At most this many interests in a campaign's criteria (any of them). */
export const INVITATION_MAX_INTERESTS = 3;

export const INVITATION_HISTORIES = ["none", "recent", "own"] as const;
export type InvitationHistory = (typeof INVITATION_HISTORIES)[number];
export const INVITATION_STATES = [
  "requested",
  "approved",
  "sending",
  "sent",
  "cancelled",
  "refused",
] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];
export const INVITATION_END_REASONS = [
  "owner",
  "admin",
  "too_small",
  "event_changed",
  "event_over",
] as const;
/** The channels an invitation can go by in v1 (ADR-331 (1)); T-501 adds push. */
export const INVITATION_CHANNELS = ["sms"] as const;
export type InvitationChannel = (typeof INVITATION_CHANNELS)[number];
/** Why an event cannot take an invitation (`invitation_event_ok`, migration 0073). */
export const INVITATION_EVENT_REASONS = [
  "not_public",
  "not_running",
  "ends_soon",
  "link_off",
  "guest_list_only",
  "email_domains",
] as const;

/** The bearer token in an invitation link's fragment: the recipient's link id, 16 bytes in base64url. */
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{22}$/;

const instant = z.iso.datetime({ offset: true });
const interestId = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/);
const size = z.number().int().min(INVITATION_MIN_SIZE).max(INVITATION_MAX_SIZE);
const note = z.string().trim().min(1).max(500);
const bilingual = z.object({ ar: z.string().nullable(), en: z.string().nullable() });

/** `POST …/events/{eventId}/invitation-campaigns`: who to invite; every criterion is optional and they all apply. */
export const invitationRequestBodySchema = z.strictObject({
  cityId: z.string().min(1).max(40).nullable().default(null),
  interests: z
    .array(interestId)
    .max(INVITATION_MAX_INTERESTS)
    .refine((ids) => new Set(ids).size === ids.length, "each interest once")
    .default([]),
  history: z.enum(INVITATION_HISTORIES).default("none"),
  size,
  /** The earliest send; before the event's end. */
  sendAfter: instant.nullable().default(null),
});
export type InvitationRequestBody = z.infer<typeof invitationRequestBodySchema>;

/**
 * A count an organizer may see: below 10 as "fewer than 10", otherwise rounded down to a multiple of 10; null before
 * the first daily publish. Exact counts never leave the database for an organizer (ADR-332 (4)).
 */
const fewerThanTen = z.strictObject({ fewerThan: z.literal(10) });
const atLeast = z.strictObject({ atLeast: z.number().int().min(10).multipleOf(10) });
// `.or`, not `z.union`: the app's Hermes check refuses any call named `union` (hermes-runtime.test.ts).
export const invitationCountSchema = fewerThanTen.or(atLeast).nullable();
export type InvitationCount = z.infer<typeof invitationCountSchema>;

/** A campaign as its organizer sees it: criteria, state and rounded published counts, never a player. */
export const invitationCampaignSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(INVITATION_STATES),
  endReason: z.enum(INVITATION_END_REASONS).nullable(),
  cityId: z.string().nullable(),
  interests: z.array(interestId),
  history: z.enum(INVITATION_HISTORIES),
  size: z.number().int(),
  sendAfter: z.string().nullable(),
  cap: z.number().int().nullable(),
  sendAt: z.string().nullable(),
  note: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  counts: z.strictObject({
    sent: invitationCountSchema,
    opened: invitationCountSchema,
    joined: invitationCountSchema,
  }),
});
export type InvitationCampaign = z.infer<typeof invitationCampaignSchema>;

/** `GET …/events/{eventId}/invitation-campaigns`: whether requests are open, and the event's campaigns, newest first. */
export const invitationCampaignsSchema = z.strictObject({
  enabled: z.boolean(),
  campaigns: z.array(invitationCampaignSchema),
});
export type InvitationCampaigns = z.infer<typeof invitationCampaignsSchema>;

/** `POST /v1/admin/invitation-campaigns/{id}/approve`: the names are the ones the console showed (Finding 1 (a)). */
export const invitationApproveBodySchema = z.strictObject({
  channels: z
    .array(z.enum(INVITATION_CHANNELS))
    .min(1)
    .refine((list) => new Set(list).size === list.length, "each channel once"),
  cap: size,
  sendAt: instant,
  note: note.nullable().optional(),
  expectedNameAr: z.string().max(200).nullable(),
  expectedNameEn: z.string().max(200).nullable(),
});
export type InvitationApproveBody = z.infer<typeof invitationApproveBodySchema>;

/** `POST /v1/admin/invitation-campaigns/{id}/refuse` and `/cancel`: the note the owner reads. */
export const invitationNoteBodySchema = z.strictObject({ note });
export type InvitationNoteBody = z.infer<typeof invitationNoteBodySchema>;

const exact = z.number().int().min(0);

/** A campaign in the console: everything the organizer sees, plus exact counts and the frozen names. */
export const adminInvitationCampaignSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(INVITATION_STATES),
  endReason: z.enum(INVITATION_END_REASONS).nullable(),
  organizer: z.strictObject({ id: z.uuid(), name: z.string() }),
  event: z.strictObject({ id: z.uuid(), joinCode: z.string(), name: bilingual }),
  cityId: z.string().nullable(),
  interests: z.array(interestId),
  history: z.enum(INVITATION_HISTORIES),
  size: z.number().int(),
  sendAfter: z.string().nullable(),
  channels: z.array(z.enum(INVITATION_CHANNELS)).nullable(),
  cap: z.number().int().nullable(),
  sendAt: z.string().nullable(),
  note: z.string().nullable(),
  /** The names copied at approval: every message is rendered from these, never from the event. */
  approvedNames: bilingual,
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  finalAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  counts: z.strictObject({
    planned: exact,
    sent: exact,
    unknown: exact,
    failed: exact,
    skipped: exact,
    cancelled: exact,
    opened: exact,
    joined: exact,
  }),
});
export type AdminInvitationCampaign = z.infer<typeof adminInvitationCampaignSchema>;

/** `GET /v1/admin/invitation-campaigns`: open campaigns first, then the latest 100 closed ones. */
export const adminInvitationQueueSchema = z.strictObject({
  campaigns: z.array(adminInvitationCampaignSchema),
});

const nameVerdict = z.strictObject({
  name: z.string().nullable(),
  issue: z.enum(["control_characters", "looks_like_address", "looks_like_phone"]).nullable(),
});
const rendered = z.strictObject({ text: z.string(), parts: z.number().int().min(1) });

/**
 * `GET /v1/admin/invitation-campaigns/{id}`: the campaign, the event's current names with the name rule's verdict,
 * the messages (placeholder tokens, never a real one), the audience estimate, the channels this server can send and
 * the channel hold. The messages are rendered from the current names while the campaign is `requested` (what Approve
 * will freeze) and from the frozen `approvedNames` in every later state; a campaign never approved has none.
 */
export const adminInvitationDetailSchema = z.strictObject({
  campaign: adminInvitationCampaignSchema,
  eventIssue: z.enum(INVITATION_EVENT_REASONS).nullable(),
  eventEndsAt: z.string().nullable(),
  names: z.strictObject({ ar: nameVerdict, en: nameVerdict }),
  messages: z.strictObject({ ar: rendered.nullable(), en: rendered.nullable() }),
  estimate: z.number().int().min(0).nullable(),
  queued: exact,
  availableChannels: z.array(z.enum(INVITATION_CHANNELS)),
  hold: z.strictObject({ channel: z.string(), holdUntil: z.string(), code: z.string() }).nullable(),
});
export type AdminInvitationDetail = z.infer<typeof adminInvitationDetailSchema>;

/** The approval's answer: `sendAtMoved` when quiet hours moved the send time (FR-1738). */
export const invitationApprovedSchema = z.strictObject({
  campaign: adminInvitationCampaignSchema,
  sendAtMoved: z.boolean(),
});

/** `POST /v1/public/invitation-open`: the token the landing page read from the link's fragment. */
export const invitationOpenBodySchema = z.strictObject({
  token: z.string().regex(INVITATION_TOKEN),
});

/** The public event card the landing page shows (never anything about the player). */
export const invitationOpenSchema = z.strictObject({
  event: z.strictObject({
    id: z.uuid(),
    joinCode: z.string(),
    name: bilingual,
    venue: bilingual,
    kind: z.string(),
    timezone: z.string(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    statusNow: z.string(),
  }),
});
export type InvitationOpen = z.infer<typeof invitationOpenSchema>;
