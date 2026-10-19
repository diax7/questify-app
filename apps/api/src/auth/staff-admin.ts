import type { Client } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { normalizeEmail } from "#src/auth/normalize";
import { checkPasswordPolicy, hashPassword } from "#src/auth/password";
import { BUCKETS, clearKey } from "#src/auth/throttle";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNIQUE_VIOLATION = "23505";

const REASONS = {
  too_short: "The password must have at least 12 characters.",
  too_long: "The password must have at most 128 characters.",
  same_as_email: "The password must not be the email address.",
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
): Promise<string> {
  const email = normalizeEmail(input.email);
  if (!EMAIL.test(email) || email.length > 254) {
    throw new Error(`"${email}" is not a valid email address.`);
  }
  const policy = checkPasswordPolicy(input.password, email);
  if (!policy.ok) {
    throw new Error(REASONS[policy.reason]);
  }
  try {
    const { rows } = await owner.query<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ($1, $2, $3) RETURNING id",
      [email, await hashPassword(input.password), input.admin ? "admin" : "none"],
    );
    return rows[0]?.id ?? "";
  } catch (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new Error(`An account for ${email} already exists.`, { cause: error });
    }
    throw error;
  }
}

/**
 * Frees a person who is throttled: removes their failure count and their challenge count.
 *
 * @returns false when no account has that email (the failure count is cleared anyway).
 */
export async function clearThrottleFor(
  owner: Client,
  keys: AuthKeys,
  rawEmail: string,
): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  await clearKey(owner, BUCKETS.failEmail, keys.emailKey(email));
  const { rows } = await owner.query<{ id: string }>("SELECT id FROM staff_user WHERE email = $1", [
    email,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) {
    return false;
  }
  await clearKey(owner, BUCKETS.challengeUser, keys.userKey(id));
  return true;
}
