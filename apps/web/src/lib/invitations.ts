import {
  INVITATION_END_REASONS,
  INVITATION_EVENT_REASONS,
  INVITATION_MAX_SIZE,
  INVITATION_MIN_SIZE,
  formatEventTime,
  formatNumber,
  invitationCampaignSchema,
  invitationCampaignsSchema,
  toInstant,
  type InvitationCampaign,
  type InvitationCampaigns,
  type InvitationCount,
  type InvitationHistory,
  type InvitationNameIssue,
  type InvitationRequestBody,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { SAUDI_ZONE } from "#src/lib/console-questify.ts";
import type { Translate } from "#src/lib/language.ts";
import type { PostResult } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

/** The API path of one event's invitation requests (T-409). */
export const invitationsPath = (organizerId: string, eventId: string): string =>
  `/v1/organizers/${organizerId}/events/${eventId}/invitation-campaigns`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The event's requests and whether the platform switch is on; undefined when the answer is not the expected shape. */
export function readCampaigns(body: unknown): InvitationCampaigns | undefined {
  const parsed = invitationCampaignsSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The request the API answers a new request with (`{campaign}`); undefined when not the expected shape. */
export function readCampaign(body: unknown): InvitationCampaign | undefined {
  const parsed = invitationCampaignSchema.safeParse(isRecord(body) ? body["campaign"] : undefined);
  return parsed.success ? parsed.data : undefined;
}

/** Whether the event page should link to Invitations: only when the list was read and the platform switch is on. */
export function invitationsOpen(result: PostResult): boolean {
  return result.ok && readCampaigns(result.body)?.enabled === true;
}

/** Whether a failed answer says the staff session is over (the page then goes to the sign-in page). */
export function sessionLost(body: unknown): boolean {
  const code = errorCodeOf(body);
  return code === "unauthenticated" || code === "session_expired";
}

/** A moment for people in Riyadh time, with the zone named (the quiet hours and the send times are Riyadh hours). */
export const riyadhTime = (iso: string, language: Language): string =>
  formatEventTime(new Date(iso), SAUDI_ZONE, language);

/** The count an organizer may see, in words: "Fewer than 10", "120+", or "Not published yet". */
export function countText(count: InvitationCount, language: Language, t: Translate): string {
  if (count === null) {
    return t("invCampaign.count.none");
  }
  if ("fewerThan" in count) {
    return t("invCampaign.count.fewer", { count: count.fewerThan });
  }
  return t("invCampaign.count.atLeast", { count: formatNumber(count.atLeast, language) });
}

export type RequestDraft = Readonly<{
  cityId: string;
  interests: readonly string[];
  history: InvitationHistory;
  size: string;
  /** Riyadh time, `YYYY-MM-DDTHH:mm`, or empty. */
  sendAfter: string;
}>;

export const BLANK_REQUEST: RequestDraft = {
  cityId: "",
  interests: [],
  history: "none",
  size: "",
  sendAfter: "",
};

export type DraftProblem = "size" | "sendAfter";

/** Whole numbers only, read from what was typed: anything else is not a count. */
export function wholeNumber(text: string): number {
  const typed = text.trim();
  return /^\d{1,7}$/.test(typed) ? Number(typed) : Number.NaN;
}

/** The request body for a draft, or the field that is wrong; the API checks the same bounds. */
export function requestBodyOf(
  draft: RequestDraft,
): Readonly<{ body: InvitationRequestBody }> | Readonly<{ problem: DraftProblem }> {
  const size = wholeNumber(draft.size);
  if (!(size >= INVITATION_MIN_SIZE && size <= INVITATION_MAX_SIZE)) {
    return { problem: "size" };
  }
  let sendAfter: string | null = null;
  if (draft.sendAfter !== "") {
    try {
      sendAfter = toInstant(draft.sendAfter, SAUDI_ZONE).toISOString();
    } catch {
      return { problem: "sendAfter" };
    }
  }
  return {
    body: {
      cityId: draft.cityId === "" ? null : draft.cityId,
      interests: [...draft.interests],
      history: draft.history,
      size,
      sendAfter,
    },
  };
}

/** The words for how a request ended. */
export const END_REASON_KEYS: Readonly<
  Record<(typeof INVITATION_END_REASONS)[number], MessageKey>
> = {
  owner: "invCampaign.end.owner",
  admin: "invCampaign.end.admin",
  too_small: "invCampaign.end.tooSmall",
  event_changed: "invCampaign.end.eventChanged",
  event_over: "invCampaign.end.eventOver",
};

/** The words for why an event cannot take invitations. */
export const NOT_ELIGIBLE_KEYS: Readonly<
  Record<(typeof INVITATION_EVENT_REASONS)[number], MessageKey>
> = {
  not_public: "invCampaign.notEligible.notPublic",
  not_running: "invCampaign.notEligible.notRunning",
  ends_soon: "invCampaign.notEligible.endsSoon",
  link_off: "invCampaign.notEligible.linkOff",
  guest_list_only: "invCampaign.notEligible.guestListOnly",
  email_domains: "invCampaign.notEligible.emailDomains",
};

/** The words for why a name cannot go in an SMS. */
export const NAME_REASON_KEYS: Readonly<Record<InvitationNameIssue, MessageKey>> = {
  control_characters: "invCampaign.nameReason.controlCharacters",
  looks_like_address: "invCampaign.nameReason.looksLikeAddress",
  looks_like_phone: "invCampaign.nameReason.looksLikePhone",
};

const NAME_PROBLEMS: Readonly<Record<Language, MessageKey>> = {
  ar: "invCampaign.nameProblem.ar",
  en: "invCampaign.nameProblem.en",
};

const detailsOf = (body: unknown): Record<string, unknown> =>
  isRecord(body) && isRecord(body["details"]) ? body["details"] : {};

/** "The event's Arabic name can't go in a text message: it looks like a phone number", from `event_name`'s details. */
function nameRefusalText(details: Record<string, unknown>, t: Translate): string | undefined {
  const problem = Object.entries(NAME_PROBLEMS).find(([one]) => one === details["language"]);
  const reason = Object.entries(NAME_REASON_KEYS).find(([one]) => one === details["reason"]);
  return problem === undefined || reason === undefined
    ? undefined
    : t(problem[1], { reason: t(reason[1]) });
}

/**
 * The words for the two refusals that name what to fix in the event (an event the invitations cannot cover, a name the
 * SMS cannot carry); undefined for every other answer. Shared by the request and the approval.
 */
export function eventRefusalText(body: unknown, t: Translate): string | undefined {
  const code = errorCodeOf(body);
  const details = detailsOf(body);
  if (code === "event_name") {
    return nameRefusalText(details, t);
  }
  if (code !== "event_not_eligible") {
    return undefined;
  }
  const reason = INVITATION_EVENT_REASONS.find((one) => one === details["reason"]);
  return reason === undefined ? undefined : t(NOT_ELIGIBLE_KEYS[reason]);
}

/** What to tell the owner after a failed call: the event refusals in this page's words, else the API's message. */
export function invitationProblemText(body: unknown, language: Language, t: Translate): string {
  const refusal = eventRefusalText(body, t);
  if (refusal === undefined) {
    return describeProblem(body, language, t).text;
  }
  return errorCodeOf(body) === "event_name" ? `${refusal} ${t("invCampaign.nameFix")}` : refusal;
}
