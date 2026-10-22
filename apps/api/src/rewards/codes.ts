import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const MIN_SECRET_LENGTH = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The longest code accepted, in characters after normalizing. */
export const CODE_MAX_LENGTH = 200;
const CONTROL = /\p{Cc}/u;

/**
 * The two keys of digital reward codes (T-203), each derived from `REWARD_CODE_SECRET` by HKDF-SHA-256 with its own
 * label: `seal` encrypts a code, `mark` makes the keyed hash that finds a code uploaded twice without reading it.
 */
export type RewardCodeKey = Readonly<{ seal: Buffer; mark: Buffer }>;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createRewardCodeKey(secret: string): RewardCodeKey {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`REWARD_CODE_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync("sha256", secret, "questify/reward-code", purpose, 32));
  return {
    seal: derive("questify/reward-code/v1/seal"),
    mark: derive("questify/reward-code/v1/mark"),
  };
}

/**
 * A code as stored and compared: Unicode NFC, outer spaces trimmed. Undefined when it is empty, too long or has a
 * control character.
 */
export function normalizeCode(raw: string): string | undefined {
  const code = raw.normalize("NFC").trim();
  if (code.length === 0 || code.length > CODE_MAX_LENGTH || CONTROL.test(code)) {
    return undefined;
  }
  return code;
}

/** AES-256-GCM under a fresh IV, bound to its reward: `iv ‖ tag ‖ ciphertext`. */
export function sealCode(key: RewardCodeKey, rewardId: string, code: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.seal, iv);
  cipher.setAAD(Buffer.from(rewardId));
  const body = Buffer.concat([cipher.update(code), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * The code inside a sealed value, or undefined when it was changed, cut short, belongs to another reward or another
 * key: GCM's tag check refuses all of these.
 */
export function openCode(key: RewardCodeKey, rewardId: string, sealed: Buffer): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.seal, sealed.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(rewardId));
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const body = sealed.subarray(IV_BYTES + TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** The keyed hash of a normalized code: the same code always gives the same 32 bytes, and they reveal nothing. */
export function markCode(key: RewardCodeKey, code: string): Buffer {
  return createHmac("sha256", key.mark).update(code).digest();
}
