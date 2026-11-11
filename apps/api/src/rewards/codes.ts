import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The first two bytes of a seal that names its key (ADR-705, ADR-726): `0x51 0x02 keyId`. */
const MAGIC = [0x51, 0x02] as const;
const HEADER_BYTES = 3;
/** The key that sealed every code written before key ids (T-810f): legacy values open under it only. */
const LEGACY_KEY_ID = 1;
/** The longest code accepted, in characters after normalizing. */
export const CODE_MAX_LENGTH = 200;
const CONTROL = /\p{Cc}/u;

/** One reward code secret and its id (1 to 255), as the config reads it. */
export type RewardCodeSecret = Readonly<{ id: number; secret: string }>;

/** The current secret, and the one being retired while a rotation's re-seal runs (ADR-725). */
export type RewardCodeSettings = Readonly<{
  current: RewardCodeSecret;
  previous: RewardCodeSecret | undefined;
}>;

/**
 * The two keys of one secret, each derived by HKDF-SHA-256 with its own label: `seal` encrypts a code, and `mark` is the
 * root from which `markKeyFor` derives each organizer's key for the keyed hash that finds a code uploaded twice without
 * reading it (w2-crypto 3: one voucher at two organizers gives two unrelated marks). The labels never change, so key 1
 * is exactly the key every code was sealed with before T-810f.
 */
export type RewardCodeKey = Readonly<{ id: number; seal: Buffer; mark: Buffer }>;

/** The keys the API holds: new codes are sealed and marked under `current`; any key in `keys` may open one. */
export type RewardCodeKeyring = Readonly<{
  current: RewardCodeKey;
  previous: RewardCodeKey | undefined;
  keys: ReadonlyMap<number, RewardCodeKey>;
}>;

/** A code opened, and how: `legacy` when it had no header (sealed before T-810f, under key 1). */
export type OpenedCode = Readonly<{ code: string; keyId: number; legacy: boolean }>;

function deriveKey(entry: RewardCodeSecret): RewardCodeKey {
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync("sha256", entry.secret, "questify/reward-code", purpose, 32));
  return {
    id: entry.id,
    seal: derive("questify/reward-code/v1/seal"),
    mark: derive("questify/reward-code/v1/mark"),
  };
}

/** The keyring for checked settings (`rewardCodeSettings` in config.ts refuses a bad combination first). */
export function createRewardCodeKeyring(settings: RewardCodeSettings): RewardCodeKeyring {
  const current = deriveKey(settings.current);
  const previous = settings.previous === undefined ? undefined : deriveKey(settings.previous);
  const keys = new Map<number, RewardCodeKey>([[current.id, current]]);
  if (previous !== undefined) {
    keys.set(previous.id, previous);
  }
  return { current, previous, keys };
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

/**
 * AES-256-GCM under the current key and a fresh IV, bound to its reward: `0x51 0x02 keyId ‖ iv ‖ tag ‖ ciphertext`.
 * The associated data is the header followed by the reward id, so neither can be swapped.
 */
export function sealCode(ring: RewardCodeKeyring, rewardId: string, code: string): Buffer {
  const header = Buffer.from([...MAGIC, ring.current.id]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ring.current.seal, iv);
  cipher.setAAD(Buffer.concat([header, Buffer.from(rewardId)]));
  const body = Buffer.concat([cipher.update(code), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
}

function openBody(key: RewardCodeKey, aad: Buffer, sealed: Buffer): string | undefined {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.seal, sealed.subarray(0, IV_BYTES));
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const body = sealed.subarray(IV_BYTES + TAG_BYTES);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** The key id a sealed value's header names, or undefined when it has no header. Never proof: GCM decides. */
export function headerKeyId(sealed: Buffer): number | undefined {
  return sealed.length > HEADER_BYTES && sealed[0] === MAGIC[0] && sealed[1] === MAGIC[1]
    ? sealed[2]
    : undefined;
}

/**
 * The code inside a sealed value, or undefined when it was changed, cut short, belongs to another reward or to a key
 * the ring does not hold: GCM's tag check refuses all of these, so a wrong key never gives a wrong code. A value with a
 * header opens under the key it names; failing that (or with no header), the whole value is tried as a legacy seal
 * under key 1, which also covers a legacy IV that happens to start like a header.
 */
export function openCode(
  ring: RewardCodeKeyring,
  rewardId: string,
  sealed: Buffer,
): OpenedCode | undefined {
  const reward = Buffer.from(rewardId);
  const named = headerKeyId(sealed);
  const key = named === undefined ? undefined : ring.keys.get(named);
  if (key !== undefined) {
    const header = sealed.subarray(0, HEADER_BYTES);
    const code = openBody(key, Buffer.concat([header, reward]), sealed.subarray(HEADER_BYTES));
    if (code !== undefined) {
      return { code, keyId: key.id, legacy: false };
    }
  }
  const legacy = ring.keys.get(LEGACY_KEY_ID);
  const code = legacy === undefined ? undefined : openBody(legacy, reward, sealed);
  return code === undefined ? undefined : { code, keyId: LEGACY_KEY_ID, legacy: true };
}

/** True when a sealed value is in the new format under the ring's current key: nothing left to re-seal. */
export function isCurrent(ring: RewardCodeKeyring, opened: OpenedCode): boolean {
  return !opened.legacy && opened.keyId === ring.current.id;
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One organizer's mark key under a secret (w2-crypto 3): HKDF-SHA-256 from the secret's mark key with the organizer in
 * the label. Marks are compared only inside one event, so a per-organizer key needs no change in SQL.
 *
 * @throws Error when the organizer id is not a lowercase UUID (one spelling, one key).
 */
export function markKeyFor(key: RewardCodeKey, organizerId: string): Buffer {
  if (!LOWER_UUID.test(organizerId)) {
    throw new Error("A reward code mark needs the organizer's lowercase UUID.");
  }
  return Buffer.from(
    hkdfSync("sha256", key.mark, "", `questify/reward-code/v2/mark/${organizerId}`, 32),
  );
}

/**
 * The keyed hash of a normalized code under one organizer's mark key (`markKeyFor`): the same code and key always give
 * the same 32 bytes, and they reveal nothing.
 */
export function markCode(markKey: Buffer, code: string): Buffer {
  return createHmac("sha256", markKey).update(code).digest();
}
