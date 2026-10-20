import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const CODE_DIGITS = 6;
const TOKEN_BYTES = 32;
const MIN_SECRET_LENGTH = 32;

/** A secret the browser holds, and the hash of it that the database stores. */
export type Token = Readonly<{ token: string; hash: string }>;

/** SHA-256 of a token as 64 lowercase hex characters (tokens are random, so an unkeyed hash is enough). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A new random token (256 bits, URL-safe) and its hash. */
export function generateToken(): Token {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashToken(token) };
}

/** A six-digit one-time code, Western digits, uniformly random. */
export function generateCode(): string {
  return randomInt(0, 10 ** CODE_DIGITS)
    .toString()
    .padStart(CODE_DIGITS, "0");
}

/** Compares two byte strings in constant time; different lengths are simply not equal. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Keyed hashes for the sign-in throttle and for the one-time codes. One secret feeds them all, with a
 * separate derived key per purpose, so a value hashed for one purpose can never be matched against another.
 */
export type AuthKeys = Readonly<{
  /** Throttle key for an email address (already normalized). */
  emailKey: (email: string) => Buffer;
  /** Throttle key for a client address (already reduced to its bucket). */
  addressKey: (address: string) => Buffer;
  /** Throttle key for a staff user id. */
  userKey: (userId: string) => Buffer;
  /** Throttle key for an organizer id (invites per organizer). */
  organizerKey: (organizerId: string) => Buffer;
  /** Hash of a code, bound to its challenge so equal codes differ between challenges. */
  codeHash: (challengeId: string, code: string) => Buffer;
}>;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createAuthKeys(secret: string): AuthKeys {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const derive = (purpose: string): Buffer =>
    createHmac("sha256", secret).update(`questify/auth/v1/${purpose}`).digest();
  const keyed = (purpose: string): ((value: string) => Buffer) => {
    const key = derive(purpose);
    return (value) => createHmac("sha256", key).update(value).digest();
  };
  const email = keyed("throttle-email");
  const address = keyed("throttle-address");
  const user = keyed("throttle-user");
  const organizer = keyed("throttle-organizer");
  const code = derive("code");
  return {
    emailKey: email,
    addressKey: address,
    userKey: user,
    organizerKey: organizer,
    codeHash: (challengeId, value) =>
      createHmac("sha256", code).update(`${challengeId}\n${value}`).digest(),
  };
}
