import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

const CODE_DIGITS = 6;
const TOKEN_BYTES = 32;
const MIN_SECRET_LENGTH = 32;
/** The opt-out key id when `AUTH_KEY_ID` is not set (w2-crypto 4). */
const DEFAULT_KEY_ID = 1;

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
  /** The id of the key that signs new opt-out links (`AUTH_KEY_ID`, 1 to 255; w2-crypto 4). */
  optOutKeyId: number;
  /**
   * The 32-byte tag that signs a promotional opt-out link for one player and channel (T-407, FR-1114) under the opt-out
   * key with this id: the current one, or the previous one while a rotation keeps it. Undefined for an id not held.
   */
  optOutTagUnder: (keyId: number, playerId: string, channel: string) => Buffer | undefined;
  /** Hash of an owner email change's code, bound to the change (T-701b); never matches a sign-in code. */
  emailChangeCodeHash: (changeId: string, code: string) => Buffer;
  /**
   * The confirm link's token (to the new address) or the Stop link's token (to the old one) of an owner email change
   * (T-701b): derived from the change id under the secret, so a resend or a later notice can repeat the link while only
   * its hash is stored. 256 bits, URL-safe; the two purposes never share a value.
   */
  emailChangeToken: (changeId: string, purpose: "confirm" | "stop") => string;
  /**
   * Hash of a typed code as the App Review fixed code is stored (T-710, ADR-561): not bound to a challenge, under a
   * purpose of its own, so it can never match a sign-in, deletion or contact code.
   */
  reviewerCodeHash: (code: string) => Buffer;
  /**
   * The tag of a device-integrity challenge (T-812, ADR-833): over the player, the install, the expiry and the random
   * part, under a purpose of its own, so a challenge is good only for the player and install it was made for.
   */
  integrityChallengeTag: (value: string) => Buffer;
}>;

/** The opt-out key's id, and the previous secret with its id while a rotation keeps old links working (w2-crypto 4). */
export type OptOutKeys = Readonly<{
  keyId: number;
  previous?: Readonly<{ id: number; secret: string }> | undefined;
}>;

const OPT_OUT_PURPOSE = "marketing-opt-out";
const purposeKey = (secret: string, purpose: string): Buffer =>
  createHmac("sha256", secret).update(`questify/auth/v1/${purpose}`).digest();

/**
 * The opt-out tag by key id. The previous secret derives only this purpose, so holding it can do nothing but read an old
 * opt-out link. The id is in the tag's input, so a tag cannot be relabelled with another id.
 *
 * @throws Error when the previous secret is short or shares the current id.
 */
function optOutTags(secret: string, keys: OptOutKeys): AuthKeys["optOutTagUnder"] {
  const held = new Map([[keys.keyId, purposeKey(secret, OPT_OUT_PURPOSE)]]);
  const previous = keys.previous;
  if (previous !== undefined) {
    if (previous.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`AUTH_PREVIOUS_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
    }
    if (previous.id === keys.keyId) {
      throw new Error("AUTH_PREVIOUS_KEY_ID must differ from AUTH_KEY_ID.");
    }
    held.set(previous.id, purposeKey(previous.secret, OPT_OUT_PURPOSE));
  }
  return (keyId, playerId, channel) => {
    const key = held.get(keyId);
    return key === undefined
      ? undefined
      : createHmac("sha256", key).update(`${keyId}\n${playerId}\n${channel}`).digest();
  };
}

/**
 * @throws Error when the secret is shorter than 32 characters, or the opt-out keys are refused (`optOutTags`).
 */
export function createAuthKeys(
  secret: string,
  optOut: OptOutKeys = { keyId: DEFAULT_KEY_ID },
): AuthKeys {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const derive = (purpose: string): Buffer => purposeKey(secret, purpose);
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
  const optOutTagUnder = optOutTags(secret, optOut);
  const emailChangeCode = derive("email-change-code");
  const emailChangeLink = keyed("email-change-link");
  const reviewerCode = keyed("reviewer-code");
  const integrityChallenge = keyed("device-integrity-challenge");
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
    optOutKeyId: optOut.keyId,
    optOutTagUnder,
    emailChangeCodeHash: (changeId, value) =>
      createHmac("sha256", emailChangeCode).update(`${changeId}\n${value}`).digest(),
    emailChangeToken: (changeId, purpose) =>
      emailChangeLink(`${purpose}\n${changeId}`).toString("base64url"),
    reviewerCodeHash: reviewerCode,
    integrityChallengeTag: integrityChallenge,
  };
}
