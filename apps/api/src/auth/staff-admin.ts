import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { recordAudit } from "#src/audit/record";
import { EmailSendError, type EmailSender } from "#src/auth/email/sender";
import { staffInviteEmail } from "#src/auth/email/templates";
import { generateToken, type AuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { hashPassword } from "#src/auth/password";
import { reasonOf } from "#src/auth/sign-in";
import { insertResetLink } from "#src/auth/staff-store";
import { BUCKETS, clearKey } from "#src/auth/throttle";

const DOMAIN_WITH_DOT = /@[^\s@]+\.[^\s@]+$/;
const UNIQUE_VIOLATION = "23505";

export type InviteMail = Readonly<{
  email: EmailSender;
  dashboardOrigin: string;
  /** Where the cause of a failed send or audit write goes, one line each; standard error when absent. */
  report?: (line: string) => void;
}>;

/** What `create` came to: the account exists either way. */
export type CreatedAccount = Readonly<{
  id: string;
  /** Whether the provider took the set-password email. */
  sent: boolean;
  /** Whether the `staff.invite` audit entry was written after the send. */
  audited: boolean;
}>;

/**
 * Creates a staff account with the database owner's connection and mails its one set-password link (ADR-814). This is the
 * only way an account is made until organizer sign-up (T-101) and admin management (T-701) add their own narrow paths. No
 * initial secret exists: the stored hash is of 32 random bytes that are dropped here, and nobody takes a password in. The
 * account has no platform role; `grant-admin` gives one, with a reason, after the person has signed in.
 *
 * @throws Error with a plain explanation when the email is not acceptable or the account exists; nothing is sent.
 */
export async function createStaffAccount(
  owner: Client,
  input: { email: string },
  mail: InviteMail,
): Promise<CreatedAccount> {
  const email = normalizeEmail(input.email);
  if (!isPlausibleEmail(email) || !DOMAIN_WITH_DOT.test(email)) {
    throw new Error(`"${email}" is not a valid email address.`);
  }
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));
  const link = generateToken();
  const id = await insertAccount(owner, email, passwordHash, link.hash);
  const report = mail.report ?? ((line: string) => process.stderr.write(`${line}\n`));
  const sent = await sendInvite(mail, email, link.token, report);
  return { id, sent, audited: await auditInvite(owner, id, sent, report) };
}

/** The account, its link and the `staff.create` entry in one transaction. */
async function insertAccount(
  owner: Client,
  email: string,
  passwordHash: string,
  tokenHash: string,
): Promise<string> {
  try {
    return await inTransaction(owner, async () => {
      const { rows } = await owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ($1, $2, 'none') RETURNING id",
        [email, passwordHash],
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new Error("Creating the staff account returned no id; nothing was saved.");
      }
      await insertResetLink(owner, {
        staffUserId: id,
        tokenHash,
        validForSeconds: AUTH_LIMITS.staffInviteValiditySeconds,
      });
      await recordAudit(owner, {
        actor: { type: "system" },
        action: "staff.create",
        target: { type: "staff_user", id },
        after: { platformRole: "none" },
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

/**
 * Runs after the commit, so no transaction waits on the network. False when no provider took the email, with the cause
 * reported: an `EmailSendError` names its step and the provider's reason and never holds the recipient or the link, so
 * its message is safe; any other error is reported by name only.
 */
async function sendInvite(
  mail: InviteMail,
  to: string,
  token: string,
  report: (line: string) => void,
): Promise<boolean> {
  try {
    await mail.email.send({
      to,
      ...staffInviteEmail({
        token,
        dashboardOrigin: mail.dashboardOrigin,
        expiresInHours: AUTH_LIMITS.staffInviteValiditySeconds / 3600,
      }),
    });
    return true;
  } catch (error) {
    report(
      `The invite email failed: ${error instanceof EmailSendError ? error.message : reasonOf(error)}`,
    );
    return false;
  }
}

/** False when the entry could not be written: the send already happened, so this must not read as a failed send. */
async function auditInvite(
  owner: Client,
  id: string,
  sent: boolean,
  report: (line: string) => void,
): Promise<boolean> {
  try {
    await recordAudit(owner, {
      actor: { type: "system" },
      action: "staff.invite",
      target: { type: "staff_user", id },
      after: { sent },
    });
    return true;
  } catch (error) {
    report(`The staff.invite audit entry failed: ${reasonOf(error)}`);
    return false;
  }
}

/** What the operator reads and the exit code. Anything short of a sent, audited invite exits 1. */
export function createOutcome(
  email: string,
  created: CreatedAccount,
): Readonly<{ text: string; exitCode: 0 | 1 }> {
  if (!created.sent) {
    return {
      text: `Created ${email}, but the email did not go out. Send them to "Forgot your password?".`,
      exitCode: 1,
    };
  }
  if (!created.audited) {
    return {
      text: `Created ${email} (${created.id}) and sent the email, but its staff.invite audit entry was not saved.`,
      exitCode: 1,
    };
  }
  return {
    text: `Created ${email} (${created.id}). They set their own password from the emailed link. The account has no platform role.`,
    exitCode: 0,
  };
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
    const admins = admin ? [] : await lockAdmins(owner);
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
    if (!admin && isLastActiveAdmin(admins, account.id)) {
      throw new Error(
        `${email} is the last active platform admin; grant the role to another account first (grant-admin).`,
      );
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

type AdminRow = Readonly<{ id: string; status: "active" | "disabled" }>;

/**
 * Locks every platform admin, by id so that two revokes at once take turns instead of both seeing the other admin
 * (FR-1785: the last admin cannot be removed), and returns them.
 */
async function lockAdmins(owner: Client): Promise<AdminRow[]> {
  const { rows } = await owner.query<AdminRow>(
    "SELECT id, status FROM staff_user WHERE platform_role = 'admin' ORDER BY id FOR UPDATE",
  );
  return rows;
}

/** True when `id` is an active admin and no other active admin exists. */
function isLastActiveAdmin(admins: readonly AdminRow[], id: string): boolean {
  const target = admins.find((row) => row.id === id);
  return (
    target?.status === "active" && !admins.some((row) => row.id !== id && row.status === "active")
  );
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
