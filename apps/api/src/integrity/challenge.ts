import { randomBytes } from "node:crypto";
import { safeEqual } from "#src/auth/keys";

/**
 * The device-integrity challenge (T-812, ADR-833): stateless, so no table holds it. Base64url of
 * `version(1) ‖ expiry seconds(4) ‖ random(16) ‖ tag(16)`, 50 characters: Play Integrity takes it as is as a nonce
 * (base64 web-safe, 16 to 500 characters) and App Attest hashes it as the client data. The tag binds it to the player
 * and the install; it lasts `CHALLENGE_SECONDS`. A replay inside that time gives the same verdict for the same install,
 * and App Attest's counter refuses a repeated assertion.
 */
export const CHALLENGE_SECONDS = 600;

const VERSION = 1;
const RANDOM_BYTES = 16;
const TAG_BYTES = 16;
const HEAD_BYTES = 1 + 4 + RANDOM_BYTES;
const TOTAL_BYTES = HEAD_BYTES + TAG_BYTES;
/** 50 base64url characters, nothing else. */
const SHAPE = /^[A-Za-z0-9_-]{50}$/;

export type ChallengeKey = (value: string) => Buffer;
export type Holder = Readonly<{ playerId: string; installId: string }>;

const tagOf = (key: ChallengeKey, holder: Holder, head: Buffer): Buffer =>
  key(`${holder.playerId}\n${holder.installId}\n${head.toString("hex")}`).subarray(0, TAG_BYTES);

/** A new challenge for `holder`, good until `now + CHALLENGE_SECONDS` (seconds since 1970). */
export function makeChallenge(
  key: ChallengeKey,
  holder: Holder,
  now: number,
): Readonly<{ challenge: string; expiresAt: number }> {
  const expiresAt = now + CHALLENGE_SECONDS;
  const head = Buffer.alloc(HEAD_BYTES);
  head.writeUInt8(VERSION, 0);
  head.writeUInt32BE(expiresAt, 1);
  randomBytes(RANDOM_BYTES).copy(head, 5);
  const challenge = Buffer.concat([head, tagOf(key, holder, head)]).toString("base64url");
  return { challenge, expiresAt };
}

/** Whether `challenge` is one made for `holder` that has not expired at `now`. */
export function challengeHolds(
  key: ChallengeKey,
  holder: Holder,
  challenge: string,
  now: number,
): boolean {
  if (!SHAPE.test(challenge)) {
    return false;
  }
  const bytes = Buffer.from(challenge, "base64url");
  if (bytes.length !== TOTAL_BYTES || bytes.readUInt8(0) !== VERSION) {
    return false;
  }
  const head = bytes.subarray(0, HEAD_BYTES);
  const fresh = bytes.readUInt32BE(1) > now;
  return safeEqual(bytes.subarray(HEAD_BYTES), tagOf(key, holder, head)) && fresh;
}
