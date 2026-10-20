import type { PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import { inviteEmail } from "#src/auth/email/templates";
import { generateToken } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { takeOutboundMail } from "#src/auth/outbound";
import type { PasswordDeps } from "#src/auth/password-reset";
import { reasonOf, say, type Caller } from "#src/auth/sign-in";
import { BUCKETS, countRecent, record, tryLock } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

/** Who acts: the signed-in owner (or member) and the organizer from the URL, checked by the scope's hook. */
export type Actor = OrganizerContext & Readonly<{ email: string }>;

export type InviteResult =
  | Readonly<{ kind: "invited"; id: string }>
  | Readonly<{
      kind:
        | "invalid_email"
        | "self"
        | "already_member"
        | "invalid_scope"
        | "mail_cap"
        | "pending_full";
    }>
  | Readonly<{ kind: "email_unavailable" }>
  | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

/** An invite to send: the role, an optional event limit, and the language of the page the link opens. */
export type InviteInput = Readonly<{
  email: string;
  role: "editor" | "owner";
  eventScope?: readonly string[] | undefined;
  lang: "ar" | "en";
}>;

export type ChangeResult =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "not_found" | "owner_required" | "invalid_scope" }>;

export type Team = Readonly<{
  invite: (actor: Actor, input: InviteInput, caller: Caller) => Promise<InviteResult>;
  cancelInvite: (actor: Actor, inviteId: string, caller: Caller) => Promise<ChangeResult>;
  setScope: (
    actor: Actor,
    staffUserId: string,
    eventScope: readonly string[] | null,
    caller: Caller,
  ) => Promise<ChangeResult>;
  remove: (actor: Actor, staffUserId: string, caller: Caller) => Promise<ChangeResult>;
  leave: (actor: Actor, role: "owner" | "editor", caller: Caller) => Promise<ChangeResult>;
}>;

const L = AUTH_LIMITS;
const CHECK_VIOLATION = "23514";

const inContext = <T>(deps: PasswordDeps, actor: Actor, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      () => work(client),
    ),
  );

async function scopeIsValid(
  client: PoolClient,
  organizerId: string,
  scope: readonly string[] | null | undefined,
): Promise<boolean> {
  if (scope === undefined || scope === null) {
    return true;
  }
  const unique = [...new Set(scope)];
  // Stryker disable next-line ConditionalExpression,BlockStatement,BooleanLiteral: defence in depth: the routes refuse an empty list
  if (unique.length === 0) {
    return false;
  }
  const { rows } = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM event WHERE organizer_id = $1 AND id = ANY($2::uuid[])",
    [organizerId, unique],
  );
  return rows[0]?.n === unique.length;
}

type Admitted =
  | Readonly<{ kind: "admitted"; organizerName: string }>
  | Exclude<InviteResult, { kind: "invited" | "email_unavailable" }>;

/** The checks before an invite exists: the email, the limit, membership, pending and daily caps. */
async function admitInvite(
  deps: PasswordDeps,
  client: PoolClient,
  actor: Actor,
  input: InviteInput,
): Promise<Admitted> {
  if (!(await scopeIsValid(client, actor.organizerId, input.eventScope))) {
    return { kind: "invalid_scope" };
  }
  const member = await client.query<{ role: string }>(
    "SELECT role FROM team_members() WHERE email = $1",
    [input.email],
  );
  if (member.rows.length > 0 && input.role === "editor") {
    return { kind: "already_member" };
  }
  const key = deps.keys.organizerKey(actor.organizerId);
  if (!(await tryLock(client, key))) {
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  const facts = await client.query<{ name: string; pending: number; activated: boolean }>(
    `SELECT o.name,
            (SELECT count(*)::int FROM organizer_invite i WHERE i.organizer_id = o.id AND i.expires_at > now()) AS pending,
            EXISTS (SELECT 1 FROM event e WHERE e.organizer_id = o.id AND e.status <> 'draft') AS activated
     FROM organizer o WHERE o.id = $1`,
    [actor.organizerId],
  );
  const fact = facts.rows[0];
  // Stryker disable next-line ConditionalExpression,BlockStatement,ObjectLiteral,StringLiteral: unreachable: the scope's hook found this organizer's membership
  if (fact === undefined) {
    return { kind: "throttled", retryAfterSeconds: 1 };
  }
  const perDay = fact.activated ? L.invitesPerDay.activated : L.invitesPerDay.notActivated;
  const today = await countRecent(
    client,
    BUCKETS.inviteOrganizer,
    key,
    L.invitesPerDay.windowSeconds,
  );
  // Waiting does not empty a full list of pending invites; cancelling one does, so it gets its own answer.
  if (fact.pending >= L.invitesPending) {
    return { kind: "pending_full" };
  }
  if (today.count >= perDay) {
    return { kind: "throttled", retryAfterSeconds: today.retryAfterSeconds };
  }
  await record(client, BUCKETS.inviteOrganizer, key);
  return { kind: "admitted", organizerName: fact.name };
}

/** Invites an editor (with an optional event limit) or the next owner. Re-inviting an email replaces its invite. */
async function invite(
  deps: PasswordDeps,
  actor: Actor,
  input: InviteInput,
  caller: Caller,
): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email)) {
    return { kind: "invalid_email" };
  }
  if (email === normalizeEmail(actor.email)) {
    return { kind: "self" };
  }
  const token = generateToken();
  const opened = await inContext(deps, actor, async (client) => {
    const admitted = await admitInvite(deps, client, actor, { ...input, email });
    if (admitted.kind !== "admitted") {
      return admitted;
    }
    await client.query(
      `DELETE FROM organizer_invite
       WHERE organizer_id = $1 AND (email = $2 OR ($3 = 'owner' AND role = 'owner'))`,
      [actor.organizerId, email, input.role],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO organizer_invite (organizer_id, email, role, event_scope, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4::uuid[], decode($5, 'hex'), $6, now() + make_interval(secs => $7)) RETURNING id`,
      [
        actor.organizerId,
        email,
        input.role,
        input.eventScope === undefined ? null : [...new Set(input.eventScope)],
        token.hash,
        actor.staffUserId,
        L.inviteValiditySeconds,
      ],
    );
    const id = rows[0]?.id ?? "";
    await recordAudit(client, {
      actor: { type: "staff", id: actor.staffUserId },
      action: input.role === "owner" ? "organizer.owner.invite" : "organizer.member.invite",
      target: { type: "organizer_invite", id },
      organizerId: actor.organizerId,
      after: { role: input.role, limitedToEvents: input.eventScope?.length ?? null },
      requestId: caller.requestId,
    });
    return { kind: "opened", id, organizerName: admitted.organizerName } as const;
  });
  if (opened.kind !== "opened") {
    return opened;
  }
  return sendInvite(
    deps,
    actor,
    { ...opened, email, role: input.role, token: token.token, lang: input.lang },
    caller,
  );
}

/** Emails the invite; when it cannot go out (budget spent, senders down) the invite is removed again. */
async function sendInvite(
  deps: PasswordDeps,
  actor: Actor,
  sent: {
    lang: "ar" | "en";
    id: string;
    organizerName: string;
    email: string;
    role: "editor" | "owner";
    token: string;
  },
  caller: Caller,
): Promise<InviteResult> {
  // An invite that never went out is removed again, and the history says why.
  const drop = () =>
    inContext(deps, actor, async (client) => {
      await client.query("DELETE FROM organizer_invite WHERE id = $1", [sent.id]);
      await recordAudit(client, {
        actor: { type: "staff", id: actor.staffUserId },
        action: "organizer.member.invite_cancel",
        target: { type: "organizer_invite", id: sent.id },
        organizerId: actor.organizerId,
        after: { reason: "not_sent" },
        requestId: caller.requestId,
      });
    });
  if (!(await takeOutboundMail(deps.pool))) {
    say(deps, caller, "staff.outbound_cap", { step: "invite" });
    await drop();
    return { kind: "mail_cap" };
  }
  try {
    await deps.email.send({
      to: sent.email,
      ...inviteEmail({
        organizerName: sent.organizerName,
        role: sent.role,
        link: `${deps.dashboardOrigin}/${sent.lang}/invite#token=${sent.token}`,
        validForDays: L.inviteValiditySeconds / 86_400,
      }),
    });
  } catch (error) {
    say(deps, caller, "staff.email_unavailable", { reason: reasonOf(error), step: "invite" });
    await drop();
    return { kind: "email_unavailable" };
  }
  say(deps, caller, "staff.invite_sent", { user: actor.staffUserId });
  return { kind: "invited", id: sent.id };
}

async function cancelInvite(
  deps: PasswordDeps,
  actor: Actor,
  inviteId: string,
  caller: Caller,
): Promise<ChangeResult> {
  return inContext(deps, actor, async (client) => {
    const { rowCount } = await client.query(
      "DELETE FROM organizer_invite WHERE id = $1 AND organizer_id = $2",
      [inviteId, actor.organizerId],
    );
    if (rowCount !== 1) {
      return { kind: "not_found" } as const;
    }
    await recordAudit(client, {
      actor: { type: "staff", id: actor.staffUserId },
      action: "organizer.member.invite_cancel",
      target: { type: "organizer_invite", id: inviteId },
      organizerId: actor.organizerId,
      requestId: caller.requestId,
    });
    return { kind: "done" } as const;
  });
}

/** Limits an editor to chosen events, or lifts the limit (null). The owner has no limit to set. */
async function setScope(
  deps: PasswordDeps,
  actor: Actor,
  staffUserId: string,
  eventScope: readonly string[] | null,
  caller: Caller,
): Promise<ChangeResult> {
  return inContext(deps, actor, async (client) => {
    if (!(await scopeIsValid(client, actor.organizerId, eventScope))) {
      return { kind: "invalid_scope" } as const;
    }
    let rowCount: number | null;
    try {
      ({ rowCount } = await client.query(
        `UPDATE organizer_member SET event_scope = $3::uuid[]
         WHERE organizer_id = $1 AND staff_user_id = $2 AND role = 'editor'`,
        [actor.organizerId, staffUserId, eventScope === null ? null : [...new Set(eventScope)]],
      ));
      // Stryker disable next-line all: defence in depth: scopeIsValid already refused what the trigger would
    } catch (error) {
      // Stryker disable next-line all: defence in depth: scopeIsValid already refused these
      if ((error as { code?: string }).code === CHECK_VIOLATION) {
        return { kind: "invalid_scope" } as const;
      }
      throw error;
    }
    if (rowCount !== 1) {
      return { kind: "not_found" } as const;
    }
    await recordAudit(client, {
      actor: { type: "staff", id: actor.staffUserId },
      action: "organizer.member.scope",
      target: { type: "staff_user", id: staffUserId },
      organizerId: actor.organizerId,
      after: { limitedToEvents: eventScope?.length ?? null },
      requestId: caller.requestId,
    });
    return { kind: "done" } as const;
  });
}

/**
 * Removes an editor (by the owner) or the caller (leaving). The entry is written before the row goes: once the
 * membership is gone, the database no longer lets the person write in the organizer's name.
 */
async function removeMember(
  deps: PasswordDeps,
  actor: Actor,
  staffUserId: string,
  action: "organizer.member.remove" | "organizer.member.leave",
  caller: Caller,
): Promise<ChangeResult> {
  return inContext(deps, actor, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM organizer_member
       WHERE organizer_id = $1 AND staff_user_id = $2 AND role = 'editor'`,
      [actor.organizerId, staffUserId],
    );
    if (rows.length !== 1) {
      return { kind: "not_found" } as const;
    }
    await recordAudit(client, {
      actor: { type: "staff", id: actor.staffUserId },
      action,
      target: { type: "staff_user", id: staffUserId },
      organizerId: actor.organizerId,
      requestId: caller.requestId,
    });
    const { rowCount } = await client.query(
      "DELETE FROM organizer_member WHERE organizer_id = $1 AND staff_user_id = $2 AND role = 'editor'",
      [actor.organizerId, staffUserId],
    );
    // The row changed since it was read (an ownership transfer): throwing rolls the entry back with it.
    if (rowCount !== 1) {
      throw new Error("The member changed while being removed; nothing was removed.");
    }
    return { kind: "done" } as const;
  });
}

/** The organizer team, managed by its owner; editors may only leave (FR-1011–1013, FR-1724, FR-1723). */
export function createTeam(deps: PasswordDeps): Team {
  return {
    invite: (actor, input, caller) => invite(deps, actor, input, caller),
    cancelInvite: (actor, inviteId, caller) => cancelInvite(deps, actor, inviteId, caller),
    setScope: (actor, staffUserId, scope, caller) =>
      setScope(deps, actor, staffUserId, scope, caller),
    remove: async (actor, staffUserId, caller) =>
      staffUserId === actor.staffUserId
        ? { kind: "owner_required" }
        : removeMember(deps, actor, staffUserId, "organizer.member.remove", caller),
    leave: async (actor, role, caller) =>
      role === "owner"
        ? { kind: "owner_required" }
        : removeMember(deps, actor, actor.staffUserId, "organizer.member.leave", caller),
  };
}
