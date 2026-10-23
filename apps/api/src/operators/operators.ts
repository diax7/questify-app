import type { Pool, PoolClient } from "pg";
import { isEventFull } from "#src/activation/activation";
import { operatorInviteEmail } from "#src/auth/email/templates";
import type { EmailSender } from "#src/auth/email/sender";
import { takeOutboundMail } from "#src/auth/outbound";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import type { OrganizerContext } from "#src/organizers/store";
import { inviteCode, inviteCodeUrl, type InviteCodeKey } from "#src/quests/qr";

/** FR-908: every ability an operator can hold; all on for a new operator unless a preset says otherwise. */
export const ABILITIES = [
  "scan_quests",
  "award",
  "hand_over",
  "review",
  "help_desk",
  "write_nfc",
  "show_rotating_qr",
] as const;
export type Ability = (typeof ABILITIES)[number];

/** FR-1720: the presets a batch of personal QRs (or any invite) can carry. */
export const PRESETS = {
  full: ABILITIES,
  scanner: ["scan_quests"],
  prize_desk: ["hand_over"],
  moderator: ["review", "help_desk"],
} as const satisfies Record<string, readonly Ability[]>;
export type Preset = keyof typeof PRESETS;

export type OperatorsDeps = Readonly<{
  pool: Pool;
  inviteKey: InviteCodeKey;
  email: EmailSender;
  dashboardOrigin: string;
}>;

export type Operator = Readonly<{
  id: string;
  playerId: string;
  username: string;
  avatar: string;
  abilities: readonly string[];
  canPlay: boolean;
  questIds: readonly string[];
  claimedVia: Readonly<{ inviteId: string; label: string }> | null;
  createdAt: Date;
}>;

export type InviteStatus = "open" | "claimed" | "revoked" | "expired";

export type Invite = Readonly<{
  id: string;
  kind: "personal" | "email";
  label: string;
  /** Masked: the first character and the domain. Cleared once the invite is no longer open. */
  email: string | null;
  abilities: readonly string[];
  batchId: string | null;
  status: InviteStatus;
  claimedBy: Readonly<{ username: string }> | null;
  createdAt: Date;
  expiresAt: Date;
  /** The claim address, for the owner only and only while a personal invite is open (FR-902: show or print again). */
  url?: string;
}>;

export type NewInvite =
  | Readonly<{ kind: "personal"; label: string; preset: Preset; count: number }>
  | Readonly<{ kind: "email"; email: string; preset: Preset; lang: "ar" | "en" }>;

export type CreateResult =
  | Readonly<{ kind: "created"; ids: readonly string[] }>
  | Readonly<{
      kind: "not_found" | "not_owner" | "event_closed" | "full" | "email_unavailable" | "mail_cap";
    }>;

export type ChangeOutcome = "changed" | "unchanged" | "not_found" | "not_owner" | "bad_quest";
export type RemoveOutcome = "removed" | "not_found" | "not_owner";
export type RevokeOutcome = "revoked" | "not_found" | "not_owner" | "not_open";

const asOrganizer = <T>(
  deps: OperatorsDeps,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: context.organizerId, staffUserId: context.staffUserId },
      () => work(client),
    ),
  );

const asPlayer = <T>(
  deps: Pick<OperatorsDeps, "pool">,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId } satisfies RequestContext, () => work(client)),
  );

/** The SQLSTATEs of create_operator_invites (migration 0026). */
const CREATE_REFUSALS: Readonly<Record<string, CreateResult["kind"]>> = {
  ON404: "not_found",
  OO403: "not_owner",
  OE409: "event_closed",
  OI409: "full",
};

/** Shows an email as its first character and its domain: enough for the owner to tell invites apart. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

function statusOf(row: {
  claimed_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}): InviteStatus {
  if (row.claimed_at !== null) {
    return "claimed";
  }
  if (row.revoked_at !== null) {
    return "revoked";
  }
  return row.expires_at.getTime() <= Date.now() ? "expired" : "open";
}

/** The claim address of an invite: the dashboard's `/op` page with the signed token in the fragment. */
export function inviteUrl(
  deps: Pick<OperatorsDeps, "inviteKey" | "dashboardOrigin">,
  inviteId: string,
  lang: "ar" | "en",
) {
  return inviteCodeUrl(deps.dashboardOrigin, lang, inviteCode(deps.inviteKey, inviteId));
}

/**
 * The event's operators and invites for its team (FR-904); null when the event is not the caller's to see. Only the
 * owner gets the claim addresses: an editor holding one could make themselves an operator (CTO review, M1).
 */
export async function listOperators(
  deps: OperatorsDeps,
  context: OrganizerContext & Readonly<{ isOwner: boolean; lang: "ar" | "en" }>,
  eventId: string,
): Promise<Readonly<{ operators: Operator[]; invites: Invite[] }> | null> {
  return asOrganizer(deps, context, async (client) => {
    const { rowCount } = await client.query(
      "SELECT 1 FROM event WHERE id = $1 AND organizer_id = $2 AND in_event_scope(id, app_event_scope())",
      [eventId, context.organizerId],
    );
    if (rowCount !== 1) {
      return null;
    }
    const invites = await client.query<{
      id: string;
      kind: "personal" | "email";
      label: string;
      email: string | null;
      abilities: string[];
      batch_id: string | null;
      created_at: Date;
      expires_at: Date;
      claimed_at: Date | null;
      revoked_at: Date | null;
      claimed_by_username: string | null;
    }>("SELECT * FROM event_operator_invites($1)", [eventId]);
    const labels = new Map(invites.rows.map((row) => [row.id, row.label]));
    const operators = await client.query<{
      id: string;
      player_id: string;
      username: string;
      avatar: string;
      abilities: string[];
      can_play: boolean;
      quest_ids: string[];
      invite_id: string | null;
      created_at: Date;
    }>("SELECT * FROM event_operators($1)", [eventId]);
    return {
      operators: operators.rows.map((row) => ({
        id: row.id,
        playerId: row.player_id,
        username: row.username,
        avatar: row.avatar,
        abilities: row.abilities,
        canPlay: row.can_play,
        questIds: row.quest_ids,
        claimedVia:
          row.invite_id === null
            ? null
            : { inviteId: row.invite_id, label: labels.get(row.invite_id) ?? "" },
        createdAt: row.created_at,
      })),
      invites: invites.rows.map((row) => {
        const status = statusOf(row);
        const printable = context.isOwner && status === "open" && row.kind === "personal";
        return {
          id: row.id,
          kind: row.kind,
          label: row.label,
          email: row.email === null ? null : maskEmail(row.email),
          abilities: row.abilities,
          batchId: row.batch_id,
          status,
          claimedBy:
            row.claimed_by_username === null ? null : { username: row.claimed_by_username },
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          ...(printable ? { url: inviteUrl(deps, row.id, context.lang) } : {}),
        };
      }),
    };
  });
}

async function createRows(
  client: PoolClient,
  eventId: string,
  invite: NewInvite,
  requestId: string | undefined,
): Promise<CreateResult> {
  try {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM create_operator_invites($1, $2, $3, $4, $5, $6, $7) AS id",
      [
        eventId,
        invite.kind,
        invite.kind === "personal" ? invite.label : invite.email,
        invite.kind === "email" ? invite.email : null,
        PRESETS[invite.preset],
        invite.kind === "personal" ? invite.count : 1,
        requestId ?? null,
      ],
    );
    return { kind: "created", ids: rows.map((row) => row.id) };
  } catch (error) {
    const refusal = CREATE_REFUSALS[(error as { code?: string }).code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    return { kind: refusal } as CreateResult;
  }
}

/**
 * Creates personal QRs (one, or a batch with a preset) or one email invite. The email goes out after the invite is
 * stored; when it cannot (the daily budget, the senders down) the invite is revoked again, so no open invite exists
 * that nobody received.
 */
export async function createInvites(
  deps: OperatorsDeps,
  context: OrganizerContext,
  eventId: string,
  invite: NewInvite,
  caller: Caller,
): Promise<CreateResult> {
  const created = await asOrganizer(deps, context, (client) =>
    createRows(client, eventId, invite, caller.requestId),
  );
  if (created.kind !== "created" || invite.kind !== "email") {
    return created;
  }
  const inviteId = created.ids[0] ?? "";
  const undo = (reason: "mail_cap" | "email_unavailable") =>
    asOrganizer(deps, context, async (client) => {
      await client.query("SELECT revoke_operator_invite($1, $2, $3)", [
        eventId,
        inviteId,
        caller.requestId ?? null,
      ]);
      return { kind: reason } as const;
    });
  if (!(await takeOutboundMail(deps.pool))) {
    caller.log("operator.invite_not_sent", { reason: "mail_cap" });
    return undo("mail_cap");
  }
  try {
    await deps.email.send({
      to: invite.email,
      ...operatorInviteEmail({ link: inviteUrl(deps, inviteId, invite.lang), validForDays: 7 }),
    });
  } catch (error) {
    caller.log("operator.invite_not_sent", {
      reason: error instanceof Error ? error.name : "unknown",
    });
    return undo("email_unavailable");
  }
  return created;
}

export async function revokeInvite(
  deps: OperatorsDeps,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; inviteId: string }>,
  requestId: string,
): Promise<RevokeOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: RevokeOutcome }>(
      "SELECT revoke_operator_invite($1, $2, $3) AS outcome",
      [target.eventId, target.inviteId, requestId],
    );
    return onlyRow(rows, "operator outcome").outcome;
  });
}

export async function updateOperator(
  deps: OperatorsDeps,
  context: OrganizerContext,
  target: Readonly<{
    eventId: string;
    operatorId: string;
    abilities: readonly Ability[];
    canPlay: boolean;
    questIds: readonly string[];
  }>,
  requestId: string,
): Promise<ChangeOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: ChangeOutcome }>(
      "SELECT set_operator($1, $2, $3, $4, $5, $6) AS outcome",
      [
        target.eventId,
        target.operatorId,
        target.abilities,
        target.canPlay,
        target.questIds,
        requestId,
      ],
    );
    return onlyRow(rows, "operator outcome").outcome;
  });
}

export async function removeOperator(
  deps: OperatorsDeps,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; operatorId: string }>,
  requestId: string,
): Promise<RemoveOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: RemoveOutcome }>(
      "SELECT remove_operator($1, $2, $3) AS outcome",
      [target.eventId, target.operatorId, requestId],
    );
    return onlyRow(rows, "operator outcome").outcome;
  });
}

// ================================================================ the player's side

/** Why an invite cannot be used by this person (preview_operator_invite, claim_operator_invite). */
export type InviteRefusal =
  | "not_found"
  | "used"
  | "expired"
  | "email_mismatch"
  | "already_operator";

export type InvitePreview =
  | Readonly<{
      state: "ok";
      event: Readonly<{ id: string; name: Readonly<{ ar: string | null; en: string | null }> }>;
      abilities: readonly string[];
    }>
  | Readonly<{ state: InviteRefusal }>;

/** FR-903: what the confirm screen shows; nothing is written. The database answers one row, with the event when ok. */
export async function previewInvite(
  deps: Pick<OperatorsDeps, "pool">,
  playerId: string,
  inviteId: string,
): Promise<InvitePreview> {
  return asPlayer(deps, playerId, async (client) => {
    const { rows } = await client.query<{
      outcome: "ok" | InviteRefusal;
      event_id: string;
      name_ar: string | null;
      name_en: string | null;
      abilities: string[];
    }>("SELECT * FROM preview_operator_invite($1)", [inviteId]);
    const row = rows[0] as (typeof rows)[number];
    return row.outcome === "ok"
      ? {
          state: "ok",
          event: { id: row.event_id, name: { ar: row.name_ar, en: row.name_en } },
          abilities: row.abilities,
        }
      : { state: row.outcome };
  });
}

/** The caller becomes the invite's operator, once (FR-903). The database answers one row, with the event when claimed. */
export async function claimInvite(
  deps: Pick<OperatorsDeps, "pool">,
  playerId: string,
  inviteId: string,
  requestId: string,
): Promise<
  Readonly<{ outcome: "claimed"; eventId: string }> | Readonly<{ outcome: InviteRefusal }>
> {
  return asPlayer(deps, playerId, async (client) => {
    const { rows } = await client.query<{ outcome: "claimed" | InviteRefusal; event_id: string }>(
      "SELECT * FROM claim_operator_invite($1, $2)",
      [inviteId, requestId],
    );
    const row = rows[0] as (typeof rows)[number];
    return row.outcome === "claimed"
      ? { outcome: "claimed", eventId: row.event_id }
      : { outcome: row.outcome };
  });
}

export type OperatorEvent = Readonly<{
  eventId: string;
  name: Readonly<{ ar: string | null; en: string | null }>;
  statusNow: string;
  startsAt: Date | null;
  endsAt: Date | null;
  timezone: string;
  abilities: readonly string[];
  canPlay: boolean;
  questIds: readonly string[];
  /** The operator's own enrollment status in this event, or null when they never joined it. */
  enrollmentStatus: string | null;
}>;

export async function operatorEvents(
  deps: Pick<OperatorsDeps, "pool">,
  playerId: string,
): Promise<OperatorEvent[]> {
  return asPlayer(deps, playerId, async (client) => {
    const { rows } = await client.query<{
      event_id: string;
      name_ar: string | null;
      name_en: string | null;
      status_now: string;
      starts_at: Date | null;
      ends_at: Date | null;
      timezone: string;
      abilities: string[];
      can_play: boolean;
      quest_ids: string[];
      enrollment_status: string | null;
    }>("SELECT * FROM operator_events()");
    return rows.map((row) => ({
      eventId: row.event_id,
      name: { ar: row.name_ar, en: row.name_en },
      statusNow: row.status_now,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      timezone: row.timezone,
      abilities: row.abilities,
      canPlay: row.can_play,
      questIds: row.quest_ids,
      enrollmentStatus: row.enrollment_status,
    }));
  });
}

export type Station = Readonly<{
  questId: string;
  title: Readonly<{ ar: string | null; en: string | null }>;
  points: number;
  visible: boolean;
  doneToday: number;
  doneTotal: number;
}>;

/** FR-921: the caller's stations and their counts; null when the caller is not an operator of the event. */
export async function operatorStations(
  deps: Pick<OperatorsDeps, "pool">,
  playerId: string,
  eventId: string,
): Promise<Station[] | null> {
  return asPlayer(deps, playerId, async (client) => {
    try {
      const { rows } = await client.query<{
        quest_id: string;
        title_ar: string | null;
        title_en: string | null;
        points: number;
        visible: boolean;
        done_today: string;
        done_total: string;
      }>("SELECT * FROM operator_stations($1)", [eventId]);
      return rows.map((row) => ({
        questId: row.quest_id,
        title: { ar: row.title_ar, en: row.title_en },
        points: row.points,
        visible: row.visible,
        doneToday: Number(row.done_today),
        doneTotal: Number(row.done_total),
      }));
    } catch (error) {
      if ((error as { code?: string }).code === "OP403") {
        return null;
      }
      throw error;
    }
  });
}

export type PlayOutcome = "joined" | "already" | "not_allowed" | "ended" | "full" | "rehearsing";

/** FR-907: an operator the owner allows to play joins the event as a player, taking a seat (ADR-141). */
export async function enrollOperator(
  deps: Pick<OperatorsDeps, "pool">,
  playerId: string,
  eventId: string,
  cardVersion: string,
): Promise<Readonly<{ outcome: PlayOutcome; enrollmentId: string | null }>> {
  try {
    return await asPlayer(deps, playerId, async (client) => {
      const { rows } = await client.query<{ outcome: PlayOutcome; enrollment_id: string | null }>(
        "SELECT * FROM enroll_operator($1, $2)",
        [eventId, cardVersion],
      );
      return {
        outcome: onlyRow(rows, "enroll_operator").outcome,
        enrollmentId: onlyRow(rows, "enroll_operator").enrollment_id,
      };
    });
  } catch (error) {
    if (isEventFull(error)) {
      return { outcome: "full", enrollmentId: null };
    }
    throw error;
  }
}
