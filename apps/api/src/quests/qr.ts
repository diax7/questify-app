import { createHmac } from "node:crypto";
import { safeEqual } from "#src/auth/keys";

const MIN_SECRET_LENGTH = 32;
/** Layout and purpose of a quest code: a static printed quest QR, layout 1. A rotating code (FR-314) gets its own. */
const FORMAT_QUEST = 0x01;
const ID_BYTES = 16;
const VERSION_BYTES = 4;
const MAC_BYTES = 16;
const SIGNED_BYTES = 1 + ID_BYTES + VERSION_BYTES;
const TOKEN_BYTES = SIGNED_BYTES + MAC_BYTES;
/** 37 bytes in base64url, no padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{50}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The key that signs quest codes, derived from `QR_SECRET` for this one purpose. */
export type QuestCodeKey = Readonly<{ key: Buffer }>;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createQuestCodeKey(secret: string): QuestCodeKey {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`QR_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return { key: createHmac("sha256", secret).update("questify/qr/v1/quest").digest() };
}

const idBytes = (questId: string): Buffer => {
  if (!UUID.test(questId)) {
    throw new Error(`Not a quest id: ${questId}`);
  }
  return Buffer.from(questId.replaceAll("-", ""), "hex");
};

const idText = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const mac = (key: QuestCodeKey, signed: Buffer): Buffer =>
  createHmac("sha256", key.key).update(signed).digest().subarray(0, MAC_BYTES);

/**
 * The token printed in a quest's QR (FR-305): the format byte, the quest id and its code version, signed. 50 URL-safe
 * characters; nothing personal and nothing secret in it.
 */
export function questCode(key: QuestCodeKey, questId: string, version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > 0xffff_ffff) {
    throw new Error(`Not a code version: ${version}`);
  }
  const signed = Buffer.alloc(SIGNED_BYTES);
  signed[0] = FORMAT_QUEST;
  idBytes(questId).copy(signed, 1);
  signed.writeUInt32BE(version, 1 + ID_BYTES);
  return Buffer.concat([signed, mac(key, signed)]).toString("base64url");
}

/** The address a quest's QR holds: the dashboard's `/q/{token}` page, which the app reads and a camera can open. */
export function questCodeUrl(origin: string, token: string): string {
  return `${origin}/q/${token}`;
}

export type CodeCheck =
  | Readonly<{ kind: "valid"; questId: string; version: number }>
  /** Not a quest code at all (another app's QR, a damaged scan). */
  | Readonly<{ kind: "not_questify" }>
  /** Shaped like one, but not signed by Questify. */
  | Readonly<{ kind: "forged" }>
  /** A real code of another quest: never completes this one. */
  | Readonly<{ kind: "wrong_quest" }>;

/**
 * Checks a scanned token for the quest it is used on. Strict: exactly 50 base64url characters, the one canonical
 * encoding of the bytes, the quest format, then the signature in constant time. The version is not judged here: the
 * completion engine (T-105) compares it with the quest's current `qr_version` in its transaction, answers an old code
 * like a forged one, and logs it apart.
 */
export function verifyQuestCode(
  key: QuestCodeKey,
  token: string,
  expectedQuestId: string,
): CodeCheck {
  if (!TOKEN_SHAPE.test(token)) {
    return { kind: "not_questify" };
  }
  const bytes = Buffer.from(token, "base64url");
  // Spare bits in the last character would let 16 strings decode to the same bytes; only the canonical one counts.
  if (
    // Stryker disable next-line ConditionalExpression: defence in depth: 50 characters of the shape above are always 37 bytes
    bytes.length !== TOKEN_BYTES ||
    bytes.toString("base64url") !== token ||
    bytes[0] !== FORMAT_QUEST
  ) {
    return { kind: "not_questify" };
  }
  const signed = bytes.subarray(0, SIGNED_BYTES);
  if (!safeEqual(mac(key, signed), bytes.subarray(SIGNED_BYTES))) {
    return { kind: "forged" };
  }
  const questId = idText(bytes.subarray(1, 1 + ID_BYTES));
  if (questId !== expectedQuestId.toLowerCase()) {
    return { kind: "wrong_quest" };
  }
  return { kind: "valid", questId, version: bytes.readUInt32BE(1 + ID_BYTES) };
}
