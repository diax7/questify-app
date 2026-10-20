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

export type SessionRow = Readonly<{
  id: string;
  staffUserId: string;
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

export type Membership = Readonly<{
  organizerId: string;
  /** Organizer names are public (event pages), so a member may always see the name. */
  organizerName: string;
  role: "owner" | "editor";
  eventScope: string[] | null;
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

export async function insertSession(
  db: Db,
  session: { staffUserId: string; tokenHash: string; userAgent: string | null; ip: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO staff_session (staff_user_id, token_hash, user_agent, ip)
     VALUES ($1, decode($2, 'hex'), $3, $4) RETURNING id`,
    [
      session.staffUserId,
      session.tokenHash,
      session.userAgent === null ? null : session.userAgent.slice(0, 300),
      session.ip.slice(0, 64),
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      "Opening a staff session returned no id; the insert was refused without an error.",
    );
  }
  return id;
}

/** Ends the user's oldest live sessions beyond `keep`, newest first, and says how many it ended. */
export async function capLiveSessions(db: Db, staffUserId: string, keep: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE staff_session SET revoked_at = now()
     WHERE id IN (SELECT id FROM staff_session
                  WHERE staff_user_id = $1 AND revoked_at IS NULL
                  ORDER BY created_at DESC OFFSET $2)`,
    [staffUserId, keep],
  );
  return rowCount ?? 0;
}

/** Under the session lookup context: the one session, with its age and idle time from the database clock. */
export async function findSession(db: Db): Promise<SessionRow | undefined> {
  const { rows } = await db.query<{
    id: string;
    staff_user_id: string;
    revoked: boolean;
    idle: number;
    age: number;
  }>(
    `SELECT id, staff_user_id, revoked_at IS NOT NULL AS revoked,
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
        revoked: row.revoked,
        idleSeconds: row.idle,
        ageSeconds: row.age,
      };
}

export async function touchSession(db: Db, id: string): Promise<void> {
  await db.query("UPDATE staff_session SET last_seen_at = now() WHERE id = $1", [id]);
}

export async function revokeSessionById(db: Db, staffUserId: string, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE staff_session SET revoked_at = now() WHERE id = $1 AND staff_user_id = $2 AND revoked_at IS NULL",
    [id, staffUserId],
  );
  return rowCount === 1;
}

/**
 * Ends every live session of a user, or every one but `keep` (a password change keeps the session it came from).
 *
 * @returns how many sessions were ended.
 */
export async function revokeUserSessions(
  db: Db,
  staffUserId: string,
  keep?: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE staff_session SET revoked_at = now()
     WHERE staff_user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid`,
    [staffUserId, keep ?? null],
  );
  return rowCount ?? 0;
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
  }>(
    `SELECT m.organizer_id, o.name AS organizer_name, m.role, m.event_scope
     FROM organizer_member m JOIN organizer o ON o.id = m.organizer_id
     WHERE m.staff_user_id = $1 ORDER BY m.created_at`,
    [staffUserId],
  );
  return rows.map((row) => ({
    organizerId: row.organizer_id,
    organizerName: row.organizer_name,
    role: row.role,
    eventScope: row.event_scope,
  }));
}

/** Retention: bare deletes, so the policies decide which rows are old enough to go. */
export async function sweepRetention(db: Db): Promise<void> {
  await db.query("DELETE FROM staff_session");
  await db.query("DELETE FROM staff_login_challenge");
  await db.query("DELETE FROM staff_password_reset");
}
