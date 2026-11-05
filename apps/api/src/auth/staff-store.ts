import type { Client, PoolClient } from "pg";

type Db = Client | PoolClient;

export type PlatformRole = "none" | "admin";

/** A staff account as sign-in needs it. `passwordHash` never leaves the auth code. */
export type Account = Readonly<{
  id: string;
  email: string;
  passwordHash: string;
  status: "active" | "disabled";
  platformRole: PlatformRole;
}>;

export type PublicAccount = Omit<Account, "passwordHash">;

/** A challenge row, with the clock questions answered by the database's own clock. */
export type Challenge = Readonly<{
  id: string;
  staffUserId: string;
  codeHash: Buffer;
  attempts: number;
  resends: number;
  expired: boolean;
  consumed: boolean;
  secondsSinceSent: number;
}>;

/**
 * Where a staff session was opened (T-810d, ADR-720): `console` only by a sign-in from the console's own origin, the
 * only kind `/v1/admin/*` takes; `dashboard` is every other session.
 */
export type Surface = "dashboard" | "console";

export type SessionRow = Readonly<{
  id: string;
  staffUserId: string;
  surface: Surface;
  revoked: boolean;
  idleSeconds: number;
  ageSeconds: number;
}>;

export type SessionSummary = Readonly<{
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent: string | null;
  ip: string | null;
}>;

/** Questify paused the organizer (T-701): the reason it wrote, which the organizer reads (Q-372). */
export type Suspension = Readonly<{ reason: string; since: Date }>;

/** A live support grant on one event (T-701, ADR-407): 15 minutes, as an editor of that event only. */
export type SupportGrant = Readonly<{
  grantId: string;
  eventId: string;
  expiresAt: Date;
  /** `view` reads only, in read-only transactions (T-712, ADR-520); `edit` is T-701's editor seat. */
  kind: "view" | "edit";
}>;

/** An organizer document in force that the organizer has not accepted yet (FR-1781). */
export type LegalPending = Readonly<{
  document: "organizer_terms" | "organizer_dpa" | "organizer_content_rules";
  version: string;
}>;

export type Membership = Readonly<{
  organizerId: string;
  /** Organizer names are public (event pages), so a member may always see the name. */
  organizerName: string;
  role: "owner" | "editor";
  eventScope: string[] | null;
  suspension: Suspension | null;
  /** The organizer documents to accept: until the owner accepts them the team's writes are refused (T-707). */
  legalPending: readonly LegalPending[];
  /** Set when this entry is a Questify admin's support grants, not a membership: the events and when each ends. */
  support?: readonly SupportGrant[];
}>;

type AccountRow = {
  id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  platform_role: PlatformRole;
};

const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  status: row.status,
  platformRole: row.platform_role,
});

/** Under the email lookup context: the one account with that email. */
export async function findAccountByEmail(db: Db, email: string): Promise<Account | undefined> {
  const { rows } = await db.query<AccountRow>(
    "SELECT id, email, password_hash, status, platform_role FROM staff_user WHERE email = $1",
    [email],
  );
  return rows[0] === undefined ? undefined : toAccount(rows[0]);
}

/** Under a promoted context: the current state of the signed-in account (never its password hash). */
export async function readAccount(db: Db, id: string): Promise<PublicAccount | undefined> {
  const { rows } = await db.query<Omit<AccountRow, "password_hash">>(
    "SELECT id, email, status, platform_role FROM staff_user WHERE id = $1",
    [id],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, email: row.email, status: row.status, platformRole: row.platform_role };
}

export async function setPasswordHash(db: Db, id: string, passwordHash: string): Promise<void> {
  await db.query("UPDATE staff_user SET password_hash = $2 WHERE id = $1", [id, passwordHash]);
}

// ---------------------------------------------------------------- challenges

/** Removes the promoted user's challenges (a new sign-in replaces the old). A bare delete: the policy picks the rows. */
export async function deleteOwnChallenges(db: Db): Promise<void> {
  await db.query("DELETE FROM staff_login_challenge");
}

export async function insertChallenge(
  db: Db,
  challenge: {
    id: string;
    staffUserId: string;
    tokenHash: string;
    codeHash: Buffer;
    validForSeconds: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO staff_login_challenge (id, staff_user_id, token_hash, code_hash, expires_at)
     VALUES ($1, $2, decode($3, 'hex'), $4, now() + make_interval(secs => $5))`,
    [
      challenge.id,
      challenge.staffUserId,
      challenge.tokenHash,
      challenge.codeHash,
      challenge.validForSeconds,
    ],
  );
}

/** Under the challenge lookup context: locks the one challenge so concurrent attempts take turns. */
export async function lockChallenge(db: Db): Promise<Challenge | undefined> {
  const { rows } = await db.query<{
    id: string;
    staff_user_id: string;
    code_hash: Buffer;
    attempts: number;
    resends: number;
    expired: boolean;
    consumed: boolean;
    since_sent: number;
  }>(
    `SELECT id, staff_user_id, code_hash, attempts, resends,
            expires_at <= now() AS expired, consumed_at IS NOT NULL AS consumed,
            extract(epoch FROM now() - last_sent_at)::float8 AS since_sent
     FROM staff_login_challenge FOR UPDATE`,
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        staffUserId: row.staff_user_id,
        codeHash: row.code_hash,
        attempts: row.attempts,
        resends: row.resends,
        expired: row.expired,
        consumed: row.consumed,
        secondsSinceSent: row.since_sent,
      };
}

/** Counts one code attempt. Returns false when the challenge has none left. */
export async function bumpAttempts(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE staff_login_challenge SET attempts = attempts + 1 WHERE id = $1 AND attempts < 5",
    [id],
  );
  return rowCount === 1;
}

/** Marks the challenge used. Returns false if someone else already used it. */
export async function consumeChallenge(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE staff_login_challenge SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL",
    [id],
  );
  return rowCount === 1;
}

/** Ends whatever challenge the lookup context opens (used when the code could not be emailed). */
export async function killChallenge(db: Db): Promise<void> {
  await db.query("UPDATE staff_login_challenge SET consumed_at = now() WHERE consumed_at IS NULL");
}

export async function replaceCode(db: Db, id: string, codeHash: Buffer): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE staff_login_challenge
     SET code_hash = $2, resends = resends + 1, last_sent_at = now()
     WHERE id = $1 AND resends < 3`,
    [id, codeHash],
  );
  return rowCount === 1;
}

// ---------------------------------------------------------------- password reset links (T-020)

/** Removes the promoted user's reset links (a new link or a new password replaces them). A bare delete. */
export async function deleteOwnResetLinks(db: Db): Promise<void> {
  await db.query("DELETE FROM staff_password_reset");
}

export async function insertResetLink(
  db: Db,
  link: { staffUserId: string; tokenHash: string; validForSeconds: number },
): Promise<void> {
  await db.query(
    `INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at)
     VALUES ($1, decode($2, 'hex'), now() + make_interval(secs => $3))`,
    [link.staffUserId, link.tokenHash, link.validForSeconds],
  );
}

/** Under the reset lookup context: the one link and whether it has expired, by the database's own clock. */
export async function findResetLink(
  db: Db,
): Promise<Readonly<{ staffUserId: string; expired: boolean }> | undefined> {
  const { rows } = await db.query<{ staff_user_id: string; expired: boolean }>(
    "SELECT staff_user_id, expires_at <= now() AS expired FROM staff_password_reset",
  );
  const row = rows[0];
  return row === undefined ? undefined : { staffUserId: row.staff_user_id, expired: row.expired };
}

/**
 * Under the reset lookup context: uses the link up by deleting it, if it is still valid by the database's clock.
 * A second caller with the same token waits on the row lock and then finds nothing.
 *
 * @returns the link's user id, or undefined when it was already used or has expired.
 */
export async function consumeResetLink(db: Db): Promise<string | undefined> {
  const { rows } = await db.query<{ staff_user_id: string }>(
    "DELETE FROM staff_password_reset WHERE expires_at > now() RETURNING staff_user_id",
  );
  return rows[0]?.staff_user_id;
}

// ---------------------------------------------------------------- sessions

/**
 * As the user: opens a session on one surface (`open_staff_session`, migration 0156) and ends the oldest live ones
 * beyond 10 (both surfaces count).
 *
 * @returns the new session's id and how many older sessions ended.
 */
export async function openStaffSession(
  db: Db,
  session: { tokenHash: string; userAgent: string | null; ip: string; surface: Surface },
): Promise<{ id: string; endedOlder: number }> {
  const { rows } = await db.query<{ session_id: string | null; ended: number }>(
    "SELECT session_id, ended FROM open_staff_session(decode($1, 'hex'), $2, $3, $4)",
    [session.tokenHash, session.userAgent, session.ip, session.surface],
  );
  const id = rows[0]?.session_id ?? undefined;
  if (id === undefined) {
    throw new Error(
      "Opening a staff session returned no id; open_staff_session answered without a row.",
    );
  }
  return { id, endedOlder: rows[0]?.ended ?? 0 };
}

/** Under the session lookup context: the one session, with its age and idle time from the database clock. */
export async function findSession(db: Db): Promise<SessionRow | undefined> {
  const { rows } = await db.query<{
    id: string;
    staff_user_id: string;
    surface: Surface;
    revoked: boolean;
    idle: number;
    age: number;
  }>(
    `SELECT id, staff_user_id, surface, revoked_at IS NOT NULL AS revoked,
            extract(epoch FROM now() - last_seen_at)::float8 AS idle,
            extract(epoch FROM now() - created_at)::float8 AS age
     FROM staff_session`,
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        staffUserId: row.staff_user_id,
        surface: row.surface,
        revoked: row.revoked,
        idleSeconds: row.idle,
        ageSeconds: row.age,
      };
}

export async function touchSession(db: Db, id: string): Promise<void> {
  await db.query("UPDATE staff_session SET last_seen_at = now() WHERE id = $1", [id]);
}

/** Under the session lookup context: ends the looked-up session (idle, too old, or its user disabled). */
export async function endLookedUpSession(db: Db, id: string): Promise<void> {
  await db.query(
    "UPDATE staff_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [id],
  );
}

/**
 * As the user: sets the new password hash and ends every other live session, or all of them without `keep`
 * (`set_staff_password`, migration 0155).
 *
 * @returns how many sessions were ended.
 */
export async function setPasswordAndEndSessions(
  db: Db,
  passwordHash: string,
  keep?: string,
): Promise<number> {
  const { rows } = await db.query<{ ended: number }>(
    "SELECT set_staff_password($1, $2::uuid) AS ended",
    [passwordHash, keep ?? null],
  );
  return rows[0]?.ended ?? 0;
}

/** A session's fresh end: 10 minutes after its sign-in or its last re-authentication, or null once past. */
export async function sessionFreshUntil(db: Db, id: string): Promise<Date | null> {
  const { rows } = await db.query<{ fresh_until: Date | null }>(
    `SELECT CASE WHEN t.at > now() THEN t.at END AS fresh_until
     FROM (SELECT greatest(created_at, coalesce(reauth_at, '-infinity'::timestamptz)) + interval '10 minutes' AS at
           FROM staff_session WHERE id = $1) t`,
    [id],
  );
  return rows[0]?.fresh_until ?? null;
}

export async function listLiveSessions(
  db: Db,
  staffUserId: string,
  limits: { idleSeconds: number; maxAgeSeconds: number },
): Promise<SessionSummary[]> {
  const { rows } = await db.query<{
    id: string;
    created_at: Date;
    last_seen_at: Date;
    user_agent: string | null;
    ip: string | null;
  }>(
    `SELECT id, created_at, last_seen_at, user_agent, ip FROM staff_session
     WHERE staff_user_id = $3 AND revoked_at IS NULL
       AND last_seen_at > now() - make_interval(secs => $1)
       AND created_at > now() - make_interval(secs => $2)
     ORDER BY created_at DESC`,
    [limits.idleSeconds, limits.maxAgeSeconds, staffUserId],
  );
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    userAgent: row.user_agent,
    ip: row.ip,
  }));
}

export async function listMemberships(db: Db, staffUserId: string): Promise<Membership[]> {
  const { rows } = await db.query<{
    organizer_id: string;
    organizer_name: string;
    role: "owner" | "editor";
    event_scope: string[] | null;
    suspension_reason: string | null;
    suspended_at: Date | null;
    legal_pending: LegalPending[];
  }>(
    `SELECT m.organizer_id, o.name AS organizer_name, m.role, m.event_scope, o.suspension_reason, o.suspended_at,
            organizer_legal_missing(m.organizer_id) AS legal_pending
     FROM organizer_member m JOIN organizer o ON o.id = m.organizer_id
     WHERE m.staff_user_id = $1 ORDER BY m.created_at`,
    [staffUserId],
  );
  const members: Membership[] = rows.map((row) => ({
    organizerId: row.organizer_id,
    organizerName: row.organizer_name,
    role: row.role,
    eventScope: row.event_scope,
    suspension: suspensionOf(row.suspension_reason, row.suspended_at),
    legalPending: row.legal_pending,
  }));
  const memberOf = new Set(members.map((member) => member.organizerId));
  const seats = await listSupportSeats(db);
  return [...members, ...seats.filter((seat) => !memberOf.has(seat.organizerId))];
}

function suspensionOf(reason: string | null, since: Date | null): Suspension | null {
  return reason === null || since === null ? null : { reason, since };
}

/** The caller's live support grants (none unless an active platform admin), one entry per organizer. */
async function listSupportSeats(db: Db): Promise<Membership[]> {
  const { rows } = await db.query<{
    grant_id: string;
    organizer_id: string;
    organizer_name: string;
    event_id: string;
    expires_at: Date;
    kind: "view" | "edit";
    suspension_reason: string | null;
    suspended_at: Date | null;
  }>(
    `SELECT g.grant_id, g.organizer_id, g.organizer_name, g.event_id, g.expires_at, g.kind, o.suspension_reason,
            o.suspended_at
     FROM own_support_grants() g JOIN organizer o ON o.id = g.organizer_id`,
  );
  const seats = new Map<string, Membership & { support: SupportGrant[]; eventScope: string[] }>();
  for (const row of rows) {
    const seat = seats.get(row.organizer_id) ?? {
      organizerId: row.organizer_id,
      organizerName: row.organizer_name,
      role: "editor" as const,
      eventScope: [],
      suspension: suspensionOf(row.suspension_reason, row.suspended_at),
      legalPending: [],
      support: [],
    };
    seat.eventScope.push(row.event_id);
    seat.support.push({
      grantId: row.grant_id,
      eventId: row.event_id,
      expiresAt: row.expires_at,
      kind: row.kind,
    });
    seats.set(row.organizer_id, seat);
  }
  return [...seats.values()];
}

/** Retention: bare deletes, so the policies decide which rows are old enough to go. */
export async function sweepRetention(db: Db): Promise<void> {
  await db.query("DELETE FROM staff_session");
  await db.query("DELETE FROM staff_login_challenge");
  await db.query("DELETE FROM staff_password_reset");
  // Expired operator invites keep no email (personal data, T-204).
  await db.query("SELECT sweep_operator_invites()");
}
