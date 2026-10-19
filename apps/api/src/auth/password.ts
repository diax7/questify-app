import { hash, verify, type Algorithm } from "@node-rs/argon2";
import { codePointLength, normalizeEmail, normalizePassword } from "#src/auth/normalize";

/** OWASP's minimum argon2id profile: 19 MiB of memory, 2 passes, 1 lane. */
export const ARGON2_PARAMS = {
  // Algorithm.Argon2id; the library exports a const enum, which the compiler settings here cannot import
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordPolicyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "too_short" | "too_long" | "same_as_email" }>;

/**
 * Checks a new password against the length policy (12 to 128 characters after NFKC, counted as
 * code points, no composition rules) and refuses the account's own email.
 */
export function checkPasswordPolicy(password: string, email: string): PasswordPolicyResult {
  const prepared = normalizePassword(password);
  const length = codePointLength(prepared);
  if (length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "too_short" };
  }
  if (length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: "too_long" };
  }
  if (prepared.toLowerCase() === normalizeEmail(email)) {
    return { ok: false, reason: "same_as_email" };
  }
  return { ok: true };
}

/** Hashes a password with argon2id. The result carries its own salt and parameters. */
export async function hashPassword(password: string): Promise<string> {
  return hash(normalizePassword(password), ARGON2_PARAMS);
}

/**
 * @returns true when the password matches the stored hash.
 * @throws Error when the stored hash is not a valid argon2 string (a damaged account, which must be seen, not hidden).
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  return verify(storedHash, normalizePassword(password));
}

const PARAMS_IN_HASH = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/;

/** True when a stored hash was made with other parameters than the current ones and should be re-made. */
export function needsRehash(storedHash: string): boolean {
  const match = PARAMS_IN_HASH.exec(storedHash);
  if (match === null) {
    return true;
  }
  return (
    Number(match[1]) !== ARGON2_PARAMS.memoryCost ||
    Number(match[2]) !== ARGON2_PARAMS.timeCost ||
    Number(match[3]) !== ARGON2_PARAMS.parallelism
  );
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as a real check, for an email that has no account, so the answer time does not
 * reveal which emails exist. The hash is made once with the live parameters.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(`dummy-${Math.random().toString(36)}-${Date.now()}`);
  await verifyPassword(await dummyHash, password);
}
