import {
  adminInvitationCampaignSchema,
  adminInvitationDetailSchema,
  adminInvitationQueueSchema,
  invitationCampaignSchema,
  invitationCampaignsSchema,
  invitationNameIssue,
  invitationOpenSchema,
  type AdminInvitationCampaign,
  type AdminInvitationDetail,
  type InvitationApproveBody,
  type InvitationCampaign,
  type InvitationCampaigns,
  type InvitationChannel,
  type InvitationNameIssue,
  type InvitationOpen,
  type InvitationRequestBody,
  type Language,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  approvalNotEligible,
  channelUnavailable,
  invalidApproval,
  invalidInvitation,
  invalidRequest,
  invitationAlreadyOpen,
  invitationEnded,
  invitationEventName,
  invitationEventRenamed,
  invitationKeyMismatch,
  invitationNotEligible,
  invitationWrongState,
  notFound,
  ownerOnly,
  platformFeatureOff,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";
import { previewInvitation, readInvitationToken } from "#src/invitation-campaigns/message";
import { invitationSmsTime } from "#src/invitation-campaigns/quiet-hours";
import type { SmsSender } from "#src/players/sms";

/**
 * The invitation doors of migration 0073 from the API (T-409): the owner's request, cancel and list; the console's
 * queue, detail, approval, refusal and cancel; the landing page's open. Every door checks its caller again in the
 * database; answers are parsed with their strict shared schemas, so a field the organizer must not see (an exact
 * count, a player) can never pass through by accident.
 */

export type InvitationDeps = Readonly<{
  pool: Pool;
  /** The promotional Msegat sender (`MSEGAT_PROMO_SENDER`); without it SMS cannot be approved. */
  promoSms?: SmsSender;
}>;

type Invalid = (details?: Readonly<Record<string, unknown>>) => HttpError;
type PgError = Readonly<{ code?: string; detail?: string; hint?: string }>;

const CONFLICTS: ReadonlyMap<string, Invalid> = new Map([
  ["wrong_state", invitationWrongState],
  ["invitation_open", invitationAlreadyOpen],
  ["event_renamed", invitationEventRenamed],
  ["idempotency_mismatch", invitationKeyMismatch],
]);

/** IV403's reasons a caller may see; `system_only` is a server fault (a door called from the wrong seat). */
function forbidden(detail: string | undefined): HttpError | undefined {
  if (detail === "owner_only") return ownerOnly();
  if (detail === "feature_off") return platformFeatureOff();
  return undefined;
}

function conflict(detail: string | undefined, hint: string | undefined): HttpError | undefined {
  if (detail === "event_not_eligible") return invitationNotEligible({ reason: hint });
  return CONFLICTS.get(detail ?? "")?.();
}

/** IV422: the approval's event refusal (422 there), or the door's field refusal with its field. */
function invalidOf(error: PgError, invalid: Invalid): HttpError | undefined {
  if (error.code !== "IV422") return undefined;
  if (error.detail === "event_not_eligible") return approvalNotEligible({ reason: error.hint });
  return invalid({ field: error.detail });
}

function answerFor(error: PgError, invalid: Invalid): HttpError | undefined {
  switch (error.code) {
    case "IV403":
      return forbidden(error.detail);
    case "IV409":
      return conflict(error.detail, error.hint);
    default:
      return invalidOf(error, invalid);
  }
}

/** A door's refusal as an HTTP answer; anything else (a real 42501, a lost grant) is a server fault and is rethrown. */
export function refusalOf(error: unknown, invalid: Invalid): never {
  const failure = error as PgError;
  // Another tenant's campaign, an event outside the caller's scope and a non-admin in the console all look missing.
  if (failure.code === "IV404" || failure.code === "QY403") throw notFound();
  const answer = answerFor(failure, invalid);
  if (answer !== undefined) throw answer;
  throw error;
}

async function door<T>(
  pool: Pool,
  context: RequestContext,
  invalid: Invalid,
  work: (client: PoolClient) => Promise<unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  let answer: unknown;
  try {
    answer = await withConnection(pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
  } catch (error) {
    return refusalOf(error, invalid);
  }
  return schema.parse(answer);
}

const one = async (client: PoolClient, sql: string, values: unknown[]): Promise<unknown> =>
  (await client.query<{ r: unknown }>(sql, values)).rows[0]?.r;

/** The channels this server can send invitations by: SMS when the promotional sender is set up (ADR-331 (1)). */
export const availableChannels = (deps: Pick<InvitationDeps, "promoSms">): InvitationChannel[] =>
  deps.promoSms === undefined ? [] : ["sms"];

export type NameProblem = Readonly<{ language: Language; reason: InvitationNameIssue }>;

/** The first event name the SMS could not carry (the name rule), or null; a blank name is never sent. */
export function eventNameProblem(
  names: Readonly<{ ar: string | null; en: string | null }>,
): NameProblem | null {
  for (const language of ["ar", "en"] as const) {
    const name = names[language];
    const reason = name === null || name.trim() === "" ? null : invitationNameIssue(name);
    if (reason !== null) return { language, reason };
  }
  return null;
}

/** Refuses a request early (422 `event_name`) when the event's live names could not be sent (FR-1112). */
async function checkLiveNames(client: PoolClient, eventId: string): Promise<void> {
  const { rows } = await client.query<{ ar: string | null; en: string | null }>(
    // The caller's own organizer only: another tenant's public event answers 404 from the door, never `event_name`.
    "SELECT name_ar AS ar, name_en AS en FROM event WHERE id = $1 AND organizer_id = app_organizer_id()",
    [eventId],
  );
  const problem = rows[0] === undefined ? null : eventNameProblem(rows[0]);
  if (problem !== null) throw invitationEventName(problem);
}

export type TeamWrite<B> = Readonly<{ eventId: string; body: B; requestId: string }>;

/** The owner asks for a campaign; the event's names are checked first, then the door. */
export const requestCampaign = (
  pool: Pool,
  context: RequestContext,
  write: TeamWrite<InvitationRequestBody>,
): Promise<InvitationCampaign> =>
  door(
    pool,
    context,
    invalidInvitation,
    async (client) => {
      await checkLiveNames(client, write.eventId);
      return one(client, "SELECT invitation_request($1, $2::jsonb, $3) AS r", [
        write.eventId,
        JSON.stringify(write.body),
        write.requestId,
      ]);
    },
    invitationCampaignSchema,
  );

/** The owner withdraws a campaign that has not started. */
export const cancelCampaign = (
  pool: Pool,
  context: RequestContext,
  write: TeamWrite<{ campaignId: string }>,
): Promise<InvitationCampaign> =>
  door(
    pool,
    context,
    invalidInvitation,
    (client) =>
      one(client, "SELECT invitation_cancel($1, $2, $3) AS r", [
        write.eventId,
        write.body.campaignId,
        write.requestId,
      ]),
    invitationCampaignSchema,
  );

/** The event's campaigns with rounded counts, for its owners and editors in scope. */
export const listCampaigns = (
  pool: Pool,
  context: RequestContext,
  eventId: string,
): Promise<InvitationCampaigns> =>
  door(
    pool,
    context,
    invalidInvitation,
    (client) => one(client, "SELECT invitation_list($1) AS r", [eventId]),
    invitationCampaignsSchema,
  );

const adminContext = (adminId: string): RequestContext => ({ isAdmin: true, staffUserId: adminId });

/** The console's queue: open campaigns first, then the latest 100 closed ones. */
export const campaignQueue = (
  pool: Pool,
  adminId: string,
): Promise<z.infer<typeof adminInvitationQueueSchema>> =>
  door(
    pool,
    adminContext(adminId),
    invalidApproval,
    (client) => one(client, "SELECT invitation_admin_queue() AS r", []),
    adminInvitationQueueSchema,
  );

/** The detail door's answer: the console's names come back as the event's current names, nothing rendered yet. */
const rawDetailSchema = adminInvitationDetailSchema
  .omit({ names: true, messages: true, availableChannels: true })
  .extend({ names: z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() }) });

const verdict = (name: string | null) => ({
  name,
  issue: name === null || name.trim() === "" ? null : invitationNameIssue(name),
});

/**
 * One campaign for the console: the door's answer plus the event's current names with the name rule's verdicts and
 * the messages rendered from them (placeholder tokens), so the admin approves the exact text (Finding 1).
 */
export async function campaignDetail(
  deps: InvitationDeps,
  adminId: string,
  campaignId: string,
): Promise<AdminInvitationDetail> {
  const raw = await door(
    deps.pool,
    adminContext(adminId),
    invalidApproval,
    (client) => one(client, "SELECT invitation_admin_get($1) AS r", [campaignId]),
    rawDetailSchema,
  );
  return adminInvitationDetailSchema.parse({
    ...raw,
    names: { ar: verdict(raw.names.ar), en: verdict(raw.names.en) },
    messages: { ar: previewInvitation(raw.names, "ar"), en: previewInvitation(raw.names, "en") },
    availableChannels: availableChannels(deps),
  });
}

export type AdminWrite<B> = Readonly<{ campaignId: string; body: B; requestId: string }>;

/**
 * The admin approves (Finding 1 (a)): every channel must be one this server can send (422 `channel_unavailable`), the
 * names the console showed must pass the name rule (422 `event_name`), and the send time moves out of quiet hours
 * (`sendAtMoved`). The door then proves the names are still the event's and copies them.
 */
export async function approveCampaign(
  deps: InvitationDeps,
  adminId: string,
  write: AdminWrite<InvitationApproveBody>,
): Promise<Readonly<{ campaign: AdminInvitationCampaign; sendAtMoved: boolean }>> {
  const { body } = write;
  const missing = body.channels.find((channel) => !availableChannels(deps).includes(channel));
  if (missing !== undefined) throw channelUnavailable({ channel: missing });
  const problem = eventNameProblem({ ar: body.expectedNameAr, en: body.expectedNameEn });
  if (problem !== null) throw invitationEventName(problem);
  const asked = new Date(body.sendAt);
  const sendAt = invitationSmsTime(asked);
  const campaign = await door(
    deps.pool,
    adminContext(adminId),
    invalidApproval,
    (client) =>
      one(client, "SELECT invitation_approve($1, $2::text[], $3, $4, $5, $6, $7, $8) AS r", [
        write.campaignId,
        body.channels,
        body.cap,
        sendAt,
        body.note ?? null,
        body.expectedNameAr,
        body.expectedNameEn,
        write.requestId,
      ]),
    adminInvitationCampaignSchema,
  );
  return { campaign, sendAtMoved: sendAt.getTime() !== asked.getTime() };
}

/** The admin refuses a requested campaign, or cancels one that has not ended, with a note the owner reads. */
export const closeCampaign = (
  pool: Pool,
  adminId: string,
  action: "refuse" | "cancel",
  write: AdminWrite<Readonly<{ note: string }>>,
): Promise<AdminInvitationCampaign> =>
  door(
    pool,
    adminContext(adminId),
    invalidApproval,
    (client) =>
      one(
        client,
        action === "refuse"
          ? "SELECT invitation_refuse($1, $2, $3) AS r"
          : "SELECT invitation_admin_cancel($1, $2, $3) AS r",
        [write.campaignId, write.body.note, write.requestId],
      ),
    adminInvitationCampaignSchema,
  );

/**
 * The landing page's open (ADR-332 (2)): the token's link, counted once while the results are open; the public event
 * card, or 404 `invitation_ended` for an unknown or removed link and an event that is over.
 */
export async function openInvitation(pool: Pool, token: string): Promise<InvitationOpen> {
  const link = readInvitationToken(token);
  if (link === null) throw invalidRequest();
  const card = await withConnection(pool, (client) =>
    withRequestContext(client, {}, () => one(client, "SELECT invitation_open($1) AS r", [link])),
  );
  if (card === null || card === undefined) throw invitationEnded();
  return invitationOpenSchema.parse({ event: card });
}
