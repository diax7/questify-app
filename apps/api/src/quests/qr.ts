import { createHmac } from "node:crypto";
import { safeEqual } from "#src/auth/keys";

const MIN_SECRET_LENGTH = 32;
/**
 * Layout and purpose of a signed code, its first byte. 0x01: a static printed quest QR (FR-305); 0x02: a player's My
 * QR (ADR-137); 0x03: an operator invite (T-204); 0x04: a printed passport step (T-304b, ADR-203); 0x05: a hidden
 * category's secret code (T-304c, ADR-204); 0x06: an NFC tag (T-308, ADR-234); 0x07: a station's rotating code (T-309,
 * FR-314, ADR-240); 0x08: a player's live code for kiosks (T-309b, FR-315, ADR-242). Each purpose also has its own
 * key, so a code of one purpose never opens as another.
 */
const FORMAT = {
  quest: 0x01,
  my: 0x02,
  operator: 0x03,
  step: 0x04,
  reveal: 0x05,
  tag: 0x06,
  screen: 0x07,
  live: 0x08,
} as const;
type Purpose = keyof typeof FORMAT;
const ID_BYTES = 16;
const VERSION_BYTES = 4;
const MAC_BYTES = 16;
const SIGNED_BYTES = 1 + ID_BYTES + VERSION_BYTES;
const TOKEN_BYTES = SIGNED_BYTES + MAC_BYTES;
/** 37 bytes in base64url, no padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{50}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A key derived from `QR_SECRET` for one purpose. */
type CodeKey<P extends Purpose> = Readonly<{ key: Buffer; purpose: P }>;
export type QuestCodeKey = CodeKey<"quest">;
export type MyCodeKey = CodeKey<"my">;
export type InviteCodeKey = CodeKey<"operator">;
export type StepCodeKey = CodeKey<"step">;
export type RevealCodeKey = CodeKey<"reveal">;

function deriveKey<P extends Purpose>(secret: string, purpose: P): CodeKey<P> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`QR_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return {
    key: createHmac("sha256", secret).update(`questify/qr/v1/${purpose}`).digest(),
    purpose,
  };
}

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createQuestCodeKey(secret: string): QuestCodeKey {
  return deriveKey(secret, "quest");
}

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createMyCodeKey(secret: string): MyCodeKey {
  return deriveKey(secret, "my");
}

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createInviteCodeKey(secret: string): InviteCodeKey {
  return deriveKey(secret, "operator");
}

const idBytes = (id: string): Buffer => {
  if (!UUID.test(id)) {
    throw new Error(`Not an id: ${id}`);
  }
  return Buffer.from(id.replaceAll("-", ""), "hex");
};

const idText = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const mac = (key: CodeKey<Purpose>, signed: Buffer): Buffer =>
  createHmac("sha256", key.key).update(signed).digest().subarray(0, MAC_BYTES);

/** The format byte, an id and a version, signed: 50 URL-safe characters, nothing personal and nothing secret. */
function sign(key: CodeKey<Purpose>, id: string, version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > 0xffff_ffff) {
    throw new Error(`Not a code version: ${version}`);
  }
  const signed = Buffer.alloc(SIGNED_BYTES);
  signed[0] = FORMAT[key.purpose];
  idBytes(id).copy(signed, 1);
  signed.writeUInt32BE(version, 1 + ID_BYTES);
  return Buffer.concat([signed, mac(key, signed)]).toString("base64url");
}

type Opened =
  | Readonly<{ kind: "valid"; id: string; version: number }>
  /** Not a code of this purpose at all (another app's QR, a damaged scan, another Questify code). */
  | Readonly<{ kind: "not_questify" }>
  /** Shaped like one, but not signed by Questify. */
  | Readonly<{ kind: "forged" }>;

/**
 * Strict: exactly 50 base64url characters, the one canonical encoding of the bytes, the purpose's format, then the
 * signature in constant time.
 */
function open(key: CodeKey<Purpose>, token: string): Opened {
  if (!TOKEN_SHAPE.test(token)) {
    return { kind: "not_questify" };
  }
  const bytes = Buffer.from(token, "base64url");
  // Spare bits in the last character would let 16 strings decode to the same bytes; only the canonical one counts.
  if (
    // Stryker disable next-line ConditionalExpression: defence in depth: 50 characters of the shape above are always 37 bytes
    bytes.length !== TOKEN_BYTES ||
    bytes.toString("base64url") !== token ||
    bytes[0] !== FORMAT[key.purpose]
  ) {
    return { kind: "not_questify" };
  }
  const signed = bytes.subarray(0, SIGNED_BYTES);
  if (!safeEqual(mac(key, signed), bytes.subarray(SIGNED_BYTES))) {
    return { kind: "forged" };
  }
  return {
    kind: "valid",
    id: idText(bytes.subarray(1, 1 + ID_BYTES)),
    version: bytes.readUInt32BE(1 + ID_BYTES),
  };
}

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createStepCodeKey(secret: string): StepCodeKey {
  return deriveKey(secret, "step");
}

/** The token printed in a quest's QR (FR-305): the quest id and its code version. */
export function questCode(key: QuestCodeKey, questId: string, version: number): string {
  return sign(key, questId, version);
}

/** The address a quest's QR holds: the dashboard's `/q/{token}` page, which the app reads and a camera can open. */
export function questCodeUrl(origin: string, token: string): string {
  return `${origin}/q/${token}`;
}

export type CodeCheck =
  | Readonly<{ kind: "valid"; questId: string; version: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>
  /** A real code of another quest: never completes this one. */
  | Readonly<{ kind: "wrong_quest" }>;

/**
 * Checks a scanned token for the quest it is used on. The version is not judged here: the completion engine (T-105)
 * compares it with the quest's current `qr_version` in its transaction, answers an old code like a forged one, and
 * logs it apart.
 */
export function verifyQuestCode(
  key: QuestCodeKey,
  token: string,
  expectedQuestId: string,
): CodeCheck {
  const opened = open(key, token);
  if (opened.kind !== "valid") {
    return opened;
  }
  if (opened.id !== expectedQuestId.toLowerCase()) {
    return { kind: "wrong_quest" };
  }
  return { kind: "valid", questId: opened.id, version: opened.version };
}

/** A player's fixed My QR (ADR-137): their id and My QR version. The QR holds this bare token. */
export function myCode(key: MyCodeKey, playerId: string, version: number): string {
  return sign(key, playerId, version);
}

export type MyCodeCheck =
  | Readonly<{ kind: "valid"; playerId: string; version: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>;

/** Opens a scanned My QR. The version is judged by the database against the player's current one. */
export function verifyMyCode(key: MyCodeKey, token: string): MyCodeCheck {
  const opened = open(key, token);
  return opened.kind === "valid"
    ? { kind: "valid", playerId: opened.id, version: opened.version }
    : opened;
}

/** An operator invite's token (T-204): the invite id, version 1. Single use is the invite row's state. */
export function inviteCode(key: InviteCodeKey, inviteId: string): string {
  return sign(key, inviteId, 1);
}

/**
 * The address a personal operator QR and an invite email hold. The token rides in the fragment, which browsers never
 * send, so no server log keeps it; the web page sends people to the app, which reads the token itself.
 */
export function inviteCodeUrl(origin: string, lang: "ar" | "en", token: string): string {
  return `${origin}/${lang}/op#${token}`;
}

export type InviteCodeCheck =
  | Readonly<{ kind: "valid"; inviteId: string }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>;

export function verifyInviteCode(key: InviteCodeKey, token: string): InviteCodeCheck {
  const opened = open(key, token);
  return opened.kind === "valid" ? { kind: "valid", inviteId: opened.id } : opened;
}

/** The token printed in a passport step's QR (T-304b): the step id and its code version. */
export function stepCode(key: StepCodeKey, stepId: string, version: number): string {
  return sign(key, stepId, version);
}

export type StepCodeCheck =
  | Readonly<{ kind: "valid"; stepId: string; version: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>
  /** A real code of another step: never stamps this one. */
  | Readonly<{ kind: "wrong_step" }>;

/**
 * Checks a scanned token for the step it is posted for, as `verifyQuestCode` does for a quest. The version is judged by
 * `stamp_step` against the step's current one.
 */
export function verifyStepCode(
  key: StepCodeKey,
  token: string,
  expectedStepId: string,
): StepCodeCheck {
  const opened = open(key, token);
  if (opened.kind !== "valid") {
    return opened;
  }
  if (opened.id !== expectedStepId.toLowerCase()) {
    return { kind: "wrong_step" };
  }
  return { kind: "valid", stepId: opened.id, version: opened.version };
}

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createRevealCodeKey(secret: string): RevealCodeKey {
  return deriveKey(secret, "reveal");
}

/** The token printed in a hidden category's secret QR (T-304c): the category id and its reveal version. */
export function revealCode(key: RevealCodeKey, categoryId: string, version: number): string {
  return sign(key, categoryId, version);
}

export type RevealCodeCheck =
  | Readonly<{ kind: "valid"; categoryId: string; version: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>
  /** A real secret code of another category: never reveals this one. */
  | Readonly<{ kind: "wrong_category" }>;

/**
 * Checks a scanned token for the category it is posted for, as `verifyQuestCode` does for a quest. The version is
 * judged by `reveal_category` against the category's current one.
 */
export function verifyRevealCode(
  key: RevealCodeKey,
  token: string,
  expectedCategoryId: string,
): RevealCodeCheck {
  const opened = open(key, token);
  if (opened.kind !== "valid") {
    return opened;
  }
  if (opened.id !== expectedCategoryId.toLowerCase()) {
    return { kind: "wrong_category" };
  }
  return { kind: "valid", categoryId: opened.id, version: opened.version };
}

export type TagCodeKey = CodeKey<"tag">;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createTagCodeKey(secret: string): TagCodeKey {
  return deriveKey(secret, "tag");
}

/** The token an NFC tag holds (T-308, ADR-234): the tag's id and its version. The quest is found on the server. */
export function tagCode(key: TagCodeKey, tagId: string, version: number): string {
  return sign(key, tagId, version);
}

/** The address a tag holds: the dashboard's `/t/{token}` page, which the app reads from the tag. */
export function tagCodeUrl(origin: string, token: string): string {
  return `${origin}/t/${token}`;
}

export type TagCodeCheck =
  | Readonly<{ kind: "valid"; tagId: string; version: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>;

/** Opens a tag's token. Whether the tag is registered, active and of this version is the database's (`tap_quest`). */
export function verifyTagCode(key: TagCodeKey, token: string): TagCodeCheck {
  const opened = open(key, token);
  return opened.kind === "valid"
    ? { kind: "valid", tagId: opened.id, version: opened.version }
    : opened;
}

export type ScreenCodeKey = CodeKey<"screen">;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createScreenCodeKey(secret: string): ScreenCodeKey {
  return deriveKey(secret, "screen");
}

/**
 * The code a station or an operator's phone shows (T-309, ADR-240): the quest id and the 30-second window of the
 * database clock. Not stored and not single-use: the window is judged by the completion door with the database's now().
 */
export function screenCode(key: ScreenCodeKey, questId: string, window: number): string {
  return sign(key, questId, window);
}

/** The address a screen code holds: the dashboard's `/s/{token}` page, which the app reads and a camera can open. */
export function screenCodeUrl(origin: string, token: string): string {
  return `${origin}/s/${token}`;
}

export type ScreenCodeCheck =
  | Readonly<{ kind: "valid"; questId: string; window: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>
  /** A real screen code of another quest: never completes this one. */
  | Readonly<{ kind: "wrong_quest" }>;

/** Opens a scanned screen code for the quest it is used on. Whether its window is still good is the door's. */
export function verifyScreenCode(
  key: ScreenCodeKey,
  token: string,
  expectedQuestId: string,
): ScreenCodeCheck {
  const opened = open(key, token);
  if (opened.kind !== "valid") {
    return opened;
  }
  if (opened.id !== expectedQuestId.toLowerCase()) {
    return { kind: "wrong_quest" };
  }
  return { kind: "valid", questId: opened.id, window: opened.version };
}

export type LiveCodeKey = CodeKey<"live">;

/**
 * @throws Error when the secret is shorter than 32 characters.
 */
export function createLiveCodeKey(secret: string): LiveCodeKey {
  return deriveKey(secret, "live");
}

/**
 * A player's live code for kiosks (T-309b, ADR-242): their id and the 30-second window of the database clock. The QR
 * holds this bare token, never a URL. Not stored: the kiosk door judges the window with the database's now().
 */
export function liveCode(key: LiveCodeKey, playerId: string, window: number): string {
  return sign(key, playerId, window);
}

export type LiveCodeCheck =
  | Readonly<{ kind: "valid"; playerId: string; window: number }>
  | Readonly<{ kind: "not_questify" }>
  | Readonly<{ kind: "forged" }>;

/** Opens a live code a kiosk read. Whether its window is still good is the door's. */
export function verifyLiveCode(key: LiveCodeKey, token: string): LiveCodeCheck {
  const opened = open(key, token);
  return opened.kind === "valid"
    ? { kind: "valid", playerId: opened.id, window: opened.version }
    : opened;
}
