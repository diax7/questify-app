import type { Client } from "pg";
import { recordAudit } from "#src/audit/record";
import type { AuthKeys } from "#src/auth/keys";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { BreachCheckUnavailable, type BreachCheck } from "#src/auth/breached";
import { checkPasswordPolicy, hashPassword } from "#src/auth/password";
import { BUCKETS, clearKey } from "#src/auth/throttle";

const DOMAIN_WITH_DOT = /@[^\s@]+\.[^\s@]+$/;
const UNIQUE_VIOLATION = "23505";

const REASONS = {
  too_short: "The password must have at least 12 characters.",
  too_long: "The password must have at most 128 characters.",
  same_as_email: "The password must not be the email address.",
  context_word: "The password must not contain Questify, Nafes or the email's name.",
  breached: "This password appears in a known data breach; choose another.",
} as const;

/**
 * Creates a staff account with the database owner's connection. This is the only way an account is made
 * until organizer sign-up (T-101) and admin management (T-701) add their own narrow paths.
 *
 * @throws Error with a plain explanation when the email or password is not acceptable or the account exists.
 */
export async function createStaffAccount(
  owner: Client,
  input: { email: string; password: string; admin: boolean },
  breachCheck: BreachCheck,
): Promise<string> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email) || !DOMAIN_WITH_DOT.test(email)) {
    throw new Error(`"${email}" is not a valid email address.`);
  }
  const policy = checkPasswordPolicy(input.password, email);
  if (!policy.ok) {
    throw new Error(REASONS[policy.reason]);
  }
  await refuseBreached(breachCheck, input.password);
  const passwordHash = await hashPassword(input.password);
  try {
    return await inTransaction(owner, async () => {
      const { rows } = await owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ($1, $2, $3) RETURNING id",
        [email, passwordHash, input.admin ? "admin" : "none"],
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error("Creating the staff account returned no id; nothing was saved.");
      }
      await recordAudit(owner, {
        actor: { type: "system" },
        action: "staff.create",
        target: { type: "staff_user", id },
        after: { platformRole: input.admin ? "admin" : "none" },
      });
      return id;
    });
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new Error(`An account for ${email} already exists.`, { cause: error });
    }
    throw error;
  }
}

/** Every password set goes through the breach list (T-020); no answer means no account. */
async function refuseBreached(breachCheck: BreachCheck, password: string): Promise<void> {
  let breached: boolean;
  try {
    breached = await breachCheck(password);
  } catch (error) {
    if (error instanceof BreachCheckUnavailable) {
      throw new Error("The breached-password check is unreachable; try again.", { cause: error });
    }
    throw error;
  }
  if (breached) {
    throw new Error(REASONS.breached);
  }
}

/** Runs `work` in one transaction on the owner connection, so a change and its audit entry stay together. */
async function inTransaction<T>(owner: Client, work: () => Promise<T>): Promise<T> {
  await owner.query("BEGIN");
  try {
    const result = await work();
    await owner.query("COMMIT");
    return result;
  } catch (error) {
    await owner.query("ROLLBACK");
    throw error;
  }
}

/**
 * Frees a person who is throttled: removes their failure count, their reset-request count and their challenge
 * count.
 *
 * @returns false when no account has that email (the failure count is cleared anyway).
 */
export async function clearThrottleFor(
  owner: Client,
  keys: AuthKeys,
  rawEmail: string,
): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  return inTransaction(owner, async () => {
    await clearKey(owner, BUCKETS.failEmail, keys.emailKey(email));
    await clearKey(owner, BUCKETS.resetEmail, keys.emailKey(email));
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM staff_user WHERE email = $1",
      [email],
    );
    const id = rows[0]?.id;
    if (id !== undefined) {
      await clearKey(owner, BUCKETS.challengeUser, keys.userKey(id));
    }
    await recordAudit(owner, {
      actor: { type: "system" },
      action: "staff.throttle.clear",
      target: { type: "staff_user", id },
      after: { found: id !== undefined },
    });
    return id !== undefined;
  });
}

/** Who ran a role change and why; both are written to its audit entry. */
export type RoleChangeNote = Readonly<{ reason: string; by: string }>;

const NOTE_REASON_MIN = 10;
const NOTE_REASON_MAX = 300;

export type RoleChange = Readonly<{
  /** False when the account already had that role (nothing changed, nothing audited). */
  changed: boolean;
  sessionsEnded: number;
  grantsClosed: number;
}>;

/**
 * Makes an account a Questify platform admin, or takes the role away (ADR-405), with the owner's connection: the only
 * path that writes `platform_role`. One transaction: the role, an audit entry (system actor, before and after, with
 * the operator and the reason), and on revoke the end of every live session and every live support grant of that
 * account, so the console and support stop at the next request.
 *
 * @throws Error when the reason is not 10 to 300 characters or the operator is empty, or naming the email when no
 *   account has it.
 */
export async function setPlatformAdmin(
  owner: Client,
  rawEmail: string,
  admin: boolean,
  note: RoleChangeNote,
): Promise<RoleChange> {
  const reason = note.reason.trim();
  const by = note.by.trim();
  if (reason.length < NOTE_REASON_MIN || reason.length > NOTE_REASON_MAX) {
    throw new Error(
      `A reason of ${NOTE_REASON_MIN} to ${NOTE_REASON_MAX} characters is required: --reason "why".`,
    );
  }
  if (by === "") {
    throw new Error("The operator is empty: pass --by <name>.");
  }
  const email = normalizeEmail(rawEmail);
  return inTransaction(owner, async () => {
    const { rows } = await owner.query<{ id: string; platform_role: "none" | "admin" }>(
      "SELECT id, platform_role FROM staff_user WHERE email = $1 FOR UPDATE",
      [email],
    );
    const account = rows[0];
    if (account === undefined) {
      throw new Error(`No staff account has the email ${email}.`);
    }
    const wanted = admin ? "admin" : "none";
    if (account.platform_role === wanted) {
      return { changed: false, sessionsEnded: 0, grantsClosed: 0 };
    }
    await owner.query("UPDATE staff_user SET platform_role = $2 WHERE id = $1", [
      account.id,
      wanted,
    ]);
    const ended = admin ? { sessions: 0, grants: 0 } : await endAdminAccess(owner, account.id);
    await recordAudit(owner, {
      actor: { type: "system" },
      action: "staff.platform_role",
      target: { type: "staff_user", id: account.id },
      before: { platformRole: account.platform_role },
      after: {
        platformRole: wanted,
        sessionsEnded: ended.sessions,
        supportGrantsClosed: ended.grants,
        reason,
        by,
      },
    });
    return { changed: true, sessionsEnded: ended.sessions, grantsClosed: ended.grants };
  });
}

/** Ends every live session and closes every live support grant of an account that lost the admin role. */
async function endAdminAccess(
  owner: Client,
  staffUserId: string,
): Promise<{ sessions: number; grants: number }> {
  const sessions = await owner.query(
    "UPDATE staff_session SET revoked_at = now() WHERE staff_user_id = $1 AND revoked_at IS NULL",
    [staffUserId],
  );
  const grants = await owner.query(
    `UPDATE support_grant SET closed_at = now(), close_kind = 'revoked'
     WHERE admin_id = $1 AND closed_at IS NULL`,
    [staffUserId],
  );
  return { sessions: sessions.rowCount ?? 0, grants: grants.rowCount ?? 0 };
}
