import type { Client, PoolClient } from "pg";

type Db = Client | PoolClient;

/** A pending sign-up, with the clock questions answered by the database's own clock. */
export type PendingSignup = Readonly<{
  id: string;
  email: string;
  /** False when the email already had an account: such a sign-up can never complete. */
  completable: boolean;
  organizerName: string;
  codeHash: Buffer;
  attempts: number;
  resends: number;
  expired: boolean;
  secondsSinceSent: number;
}>;

export type NewSignup = Readonly<{
  id: string;
  tokenHash: string;
  codeHash: Buffer;
  email: string;
  passwordHash: string | null;
  organizerName: string;
  accepted: Readonly<{ terms: string; dpa: string; contentRules: string }>;
  validForSeconds: number;
}>;

/** Under the sign-up lookup context (the row's own token): stores the pending sign-up. */
export async function insertSignup(db: Db, signup: NewSignup): Promise<void> {
  await db.query(
    `INSERT INTO staff_signup (id, token_hash, code_hash, email, password_hash, organizer_name,
                               accepted_terms, accepted_dpa, accepted_content, expires_at)
     VALUES ($1, decode($2, 'hex'), $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
    [
      signup.id,
      signup.tokenHash,
      signup.codeHash,
      signup.email,
      signup.passwordHash,
      signup.organizerName,
      signup.accepted.terms,
      signup.accepted.dpa,
      signup.accepted.contentRules,
      signup.validForSeconds,
    ],
  );
}

/** Under the sign-up lookup context: locks the one pending sign-up so concurrent attempts take turns. */
export async function lockSignup(db: Db): Promise<PendingSignup | undefined> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    completable: boolean;
    organizer_name: string;
    code_hash: Buffer;
    attempts: number;
    resends: number;
    expired: boolean;
    since_sent: number;
  }>(
    `SELECT id, email, password_hash IS NOT NULL AS completable, organizer_name, code_hash, attempts, resends,
            expires_at <= now() AS expired, extract(epoch FROM now() - last_sent_at)::float8 AS since_sent
     FROM staff_signup FOR UPDATE`,
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        id: row.id,
        email: row.email,
        completable: row.completable,
        organizerName: row.organizer_name,
        codeHash: row.code_hash,
        attempts: row.attempts,
        resends: row.resends,
        expired: row.expired,
        secondsSinceSent: row.since_sent,
      };
}

/** Counts one code attempt. Returns false when the sign-up has none left. */
export async function bumpSignupAttempts(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "UPDATE staff_signup SET attempts = attempts + 1 WHERE id = $1 AND attempts < 5",
    [id],
  );
  return rowCount === 1;
}

/** Replaces the code for a resend. Returns false when no resend is left. */
export async function replaceSignupCode(db: Db, id: string, codeHash: Buffer): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE staff_signup SET code_hash = $2, resends = resends + 1, last_sent_at = now()
     WHERE id = $1 AND resends < 3`,
    [id, codeHash],
  );
  return rowCount === 1;
}

/** Under the sign-up lookup context: removes the pending sign-up (its email could not be sent). */
export async function deleteSignup(db: Db): Promise<void> {
  await db.query("DELETE FROM staff_signup WHERE token_hash = app_signup_token_hash()");
}

export type Created = Readonly<{ staffUserId: string; organizerId: string }>;

const UNIQUE_VIOLATION = "23505";
const SLUG_CONSTRAINT = "organizer_slug_key";

/**
 * Runs an organizer-creating call with a fresh slug, and once more with another slug if the first was taken (a
 * savepoint keeps the rest of the transaction). Any other failure is passed through.
 */
export async function withFreshSlug<T>(
  db: Db,
  makeSlug: () => string,
  create: (slug: string) => Promise<T>,
): Promise<T> {
  await db.query("SAVEPOINT organizer_slug");
  try {
    return await create(makeSlug());
  } catch (error) {
    const pg = error as { code?: string; constraint?: string };
    if (pg.code !== UNIQUE_VIOLATION || pg.constraint !== SLUG_CONSTRAINT) {
      throw error;
    }
    await db.query("ROLLBACK TO SAVEPOINT organizer_slug");
    return create(makeSlug());
  }
}

/** Under the sign-up lookup context, after the code checked out: creates the account and its organizer. */
export async function completeSignup(
  db: Db,
  slug: string,
  typedCodeHash: Buffer,
  requestId: string | undefined,
): Promise<Created> {
  const { rows } = await db.query<{ staff_user_id: string; organizer_id: string }>(
    "SELECT staff_user_id, organizer_id FROM complete_signup($1, $2, $3)",
    [slug, typedCodeHash, requestId ?? null],
  );
  const row = rows[0];
  // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: unreachable: the function returns one row or raises
  if (row === undefined) {
    throw new Error("complete_signup returned no row; nothing was created.");
  }
  return { staffUserId: row.staff_user_id, organizerId: row.organizer_id };
}

/** As a signed-in staff user: creates an organizer they own, with the three acceptances. */
export async function createOrganizer(
  db: Db,
  input: Readonly<{
    name: string;
    slug: string;
    accepted: Readonly<{ terms: string; dpa: string; contentRules: string }>;
    requestId: string | undefined;
  }>,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT create_organizer($1, $2, $3, $4, $5, $6) AS id",
    [
      input.name,
      input.slug,
      input.accepted.terms,
      input.accepted.dpa,
      input.accepted.contentRules,
      input.requestId ?? null,
    ],
  );
  // Stryker disable next-line OptionalChaining: unreachable: the function returns one row or raises
  const id = rows[0]?.id;
  // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: unreachable: the function returns one row or raises
  if (id === undefined) {
    throw new Error("create_organizer returned no id; nothing was created.");
  }
  return id;
}
