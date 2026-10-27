import {
  INVITATION_MAX_SIZE,
  INVITATION_MIN_SIZE,
  adminInvitationDetailSchema,
  adminInvitationQueueSchema,
  invitationApprovedSchema,
  toInstant,
  toLocalInput,
  type AdminInvitationCampaign,
  type AdminInvitationDetail,
  type InvitationApproveBody,
  type MessageKey,
} from "@questify/shared";
import { SAUDI_ZONE } from "#src/lib/console-questify.ts";
import { wholeNumber } from "#src/lib/invitations.ts";
import { isTransientFailure, type PostResult } from "#src/lib/post-json.ts";
import type { Translate } from "#src/lib/language.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";

export const INVITATIONS_API = "/v1/admin/invitation-campaigns";
export const invitationPath = (campaignId: string): string => `${INVITATIONS_API}/${campaignId}`;

const CAMPAIGN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a path segment can name a request; anything else must never reach an API path in the admin's browser. */
export const isCampaignId = (value: string): boolean => CAMPAIGN_ID.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The queue (open requests first); undefined when the answer is not the expected shape. */
export function readQueue(body: unknown): AdminInvitationCampaign[] | undefined {
  const parsed = adminInvitationQueueSchema.safeParse(body);
  return parsed.success ? parsed.data.campaigns : undefined;
}

/** One request with its exact counts, names, messages and estimate; undefined when not the expected shape. */
export function readDetail(body: unknown): AdminInvitationDetail | undefined {
  const parsed = adminInvitationDetailSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The approval's answer; undefined when not the expected shape. */
export function readApproved(
  body: unknown,
): Readonly<{ campaign: AdminInvitationCampaign; sendAtMoved: boolean }> | undefined {
  const parsed = invitationApprovedSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What a failed first read of a request means for the page: "failed" when the page could not be loaded (a dropped
 * connection, a server fault, or an answer that is not a request), "missing" when the API answered that there is none.
 */
export function detailFailure(result: PostResult): "failed" | "missing" {
  return result.ok || isTransientFailure(result) ? "failed" : "missing";
}

/** How many requests wait for a decision, for the console home's link. */
export const waitingCount = (campaigns: readonly AdminInvitationCampaign[]): number =>
  campaigns.filter((one) => one.state === "requested").length;

/** Requests that can still change: the queue's first group. */
export const isOpen = (campaign: AdminInvitationCampaign): boolean =>
  campaign.state === "requested" || campaign.state === "approved" || campaign.state === "sending";

export type ApprovalDraft = Readonly<{
  sms: boolean;
  cap: string;
  /** Riyadh time, `YYYY-MM-DDTHH:mm`. */
  sendAt: string;
  note: string;
}>;

const HOUR_MS = 3_600_000;

/**
 * The form's start: SMS, the owner's size as the cap, and the top of the next hour (or of the next hour after the
 * owner's earliest send, when that is later). Riyadh is a whole-hour zone, so the hour is the same in UTC.
 */
export function approvalDraftOf(campaign: AdminInvitationCampaign, now: Date): ApprovalDraft {
  const earliest = campaign.sendAfter === null ? 0 : Date.parse(campaign.sendAfter);
  const base = Math.max(now.getTime(), earliest);
  return {
    sms: true,
    cap: String(campaign.size),
    sendAt: toLocalInput(new Date((Math.floor(base / HOUR_MS) + 1) * HOUR_MS), SAUDI_ZONE),
    note: "",
  };
}

export type ApprovalProblem = "channels" | "cap" | "sendAt" | "note";

/** The longest note the API takes. */
export const NOTE_MAX = 500;

/**
 * The approval the API takes, or the field that is wrong. The names are the ones the page showed (null where the event
 * has none): the API proves they are still the event's before it freezes them.
 */
export function approvalBodyOf(
  draft: ApprovalDraft,
  detail: AdminInvitationDetail,
): Readonly<{ body: InvitationApproveBody }> | Readonly<{ problem: ApprovalProblem }> {
  const cap = wholeNumber(draft.cap);
  if (!draft.sms) {
    return { problem: "channels" };
  }
  if (!(cap >= INVITATION_MIN_SIZE && cap <= INVITATION_MAX_SIZE)) {
    return { problem: "cap" };
  }
  let sendAt: string;
  try {
    sendAt = toInstant(draft.sendAt, SAUDI_ZONE).toISOString();
  } catch {
    return { problem: "sendAt" };
  }
  const note = draft.note.trim();
  if (note.length > NOTE_MAX) {
    return { problem: "note" };
  }
  return {
    body: {
      channels: ["sms"],
      cap,
      sendAt,
      ...(note === "" ? {} : { note }),
      expectedNameAr: detail.names.ar.name,
      expectedNameEn: detail.names.en.name,
    },
  };
}

const APPROVAL_FIELDS: Readonly<Record<string, MessageKey>> = {
  channels: "console.invCampaign.invalid.channels",
  cap: "console.invCampaign.invalid.cap",
  sendAt: "console.invCampaign.invalid.sendAt",
  note: "console.invCampaign.invalid.note",
  name: "console.invCampaign.invalid.name",
};

/** The approval's own refusals in this page's words: the field named, an SMS the server cannot send. */
export function approvalRefusalText(body: unknown, t: Translate): string | undefined {
  const code = errorCodeOf(body);
  if (code === "channel_unavailable") {
    return t("console.invCampaign.noSms");
  }
  const details = isRecord(body) && isRecord(body["details"]) ? body["details"] : {};
  const key = Object.entries(APPROVAL_FIELDS).find(([field]) => field === details["field"]);
  return code === "invalid_approval" && key !== undefined ? t(key[1]) : undefined;
}

/** Whether the API refused because the event was renamed after the page showed it (the page reads it again). */
export const isRenamed = (body: unknown): boolean => errorCodeOf(body) === "event_renamed";

export type ApprovalBlock = "noSms" | "event" | "name" | "noName";

/**
 * Why Approve is off, or null: SMS is not set up on this server, the event no longer qualifies, a name the SMS cannot
 * carry, or no name at all. The API refuses each of them too; this says so before the click.
 */
export function approvalBlock(detail: AdminInvitationDetail): ApprovalBlock | null {
  if (!detail.availableChannels.includes("sms")) {
    return "noSms";
  }
  if (detail.eventIssue !== null) {
    return "event";
  }
  if (detail.names.ar.issue !== null || detail.names.en.issue !== null) {
    return "name";
  }
  return detail.messages.ar === null && detail.messages.en === null ? "noName" : null;
}
