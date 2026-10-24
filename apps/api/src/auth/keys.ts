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
  /** Throttle key for a player (wrong entry codes, T-105). */
  playerKey: (playerId: string) => Buffer;
  /** Throttle key for a player on one quest. */
  playerQuestKey: (playerId: string, questId: string) => Buffer;
  /** Throttle key for an app install (its X-Device-Id). */
  deviceKey: (deviceId: string) => Buffer;
  /** Throttle key for a player's phone or email (sign-in codes, T-107). */
  contactThrottleKey: (contact: string) => Buffer;
  /** Finds a contact's earlier sign-in challenges without storing the contact twice (T-107). */
  contactLookupKey: (contact: string) => Buffer;
  /** Hash of a player's sign-in code, bound to its challenge. */
  playerCodeHash: (challengeId: string, code: string) => Buffer;
  /** Hash of a code, bound to its challenge so equal codes differ between challenges. */
  codeHash: (challengeId: string, code: string) => Buffer;
  /**
   * The one-way fingerprint of a normalised phone or email that a deleted account leaves behind (T-217, ADR-176). Keyed,
   * so the contact cannot be found by hashing every Saudi number; the key can never rotate without losing the marks.
   */
  deletionFingerprint: (contact: string) => Buffer;
  /** Hash of a deletion code, bound to its challenge (a deletion code can never match a sign-in code). */
  deletionCodeHash: (challengeId: string, code: string) => Buffer;
  /** Hash of a device pairing code (T-309, normalised), the only form in which a code is stored. */
  pairingCodeHash: (code: string) => Buffer;
  /** Throttle key for a paired device or a pending one (its secret's hash), T-309. */
  pairedDeviceKey: (device: string) => Buffer;
  /** Throttle key for an event (unknown pairing codes, T-309). */
  eventKey: (eventId: string) => Buffer;
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
  const player = keyed("throttle-player");
  const playerQuest = keyed("throttle-player-quest");
  const device = keyed("throttle-device");
  const contactThrottle = keyed("throttle-contact");
  const contactLookup = keyed("contact-lookup");
  const playerCode = derive("player-code");
  const code = derive("code");
  const deletionFingerprint = keyed("deletion-fingerprint");
  const deletionCode = derive("deletion-code");
  const pairingCode = keyed("device-pairing-code");
  const pairedDevice = keyed("throttle-paired-device");
  const event = keyed("throttle-event");
  return {
    emailKey: email,
    addressKey: address,
    userKey: user,
    organizerKey: organizer,
    playerKey: player,
    playerQuestKey: (playerId, questId) => playerQuest(`${playerId}\n${questId}`),
    deviceKey: device,
    contactThrottleKey: contactThrottle,
    contactLookupKey: contactLookup,
    playerCodeHash: (challengeId, value) =>
      createHmac("sha256", playerCode).update(`${challengeId}\n${value}`).digest(),
    codeHash: (challengeId, value) =>
      createHmac("sha256", code).update(`${challengeId}\n${value}`).digest(),
    deletionFingerprint,
    deletionCodeHash: (challengeId, value) =>
      createHmac("sha256", deletionCode).update(`${challengeId}\n${value}`).digest(),
    pairingCodeHash: pairingCode,
    pairedDeviceKey: pairedDevice,
    eventKey: event,
  };
}
