import {
  JOIN_LINK_HOST,
  MARKETING_CHANNELS,
  type Language,
  type MarketingChannel,
} from "@questify/shared";
import { safeEqual, type AuthKeys } from "#src/auth/keys";

/**
 * The signed opt-out link in every promotional message (FR-1114, ADR-317). The token is stateless: the player's id,
 * the channel, the id of the key that signed it, and a keyed tag over all three, so it needs no table and cannot be made
 * for another player or channel without the key. The key id lets an `AUTH_SECRET` rotation keep links already sent
 * working while the previous secret is held (w2-crypto 4): a player tapping an old link can still withdraw.
 */

const ID_BYTES = 16;
const CHANNEL_AT = ID_BYTES;
const KEY_ID_AT = ID_BYTES + 1;
const TAG_AT = ID_BYTES + 2;
const TAG_BYTES = 16;
/** `id16 ‖ channel1 ‖ keyId1 ‖ tag16`: 34 bytes, 46 base64url characters. */
const TOKEN_BYTES = TAG_AT + TAG_BYTES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type OptOut = Readonly<{ playerId: string; channel: MarketingChannel }>;
/** What signing and reading an opt-out link needs of the auth keys. */
export type OptOutSigner = Pick<AuthKeys, "optOutKeyId" | "optOutTagUnder">;

const uuidOf = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The token for one player and channel, signed under the current key. */
export function optOutToken(keys: OptOutSigner, { playerId, channel }: OptOut): string {
  const id = playerId.toLowerCase();
  if (!UUID.test(id)) throw new Error("An opt-out token needs the player's UUID.");
  const index = MARKETING_CHANNELS.indexOf(channel);
  const keyId = keys.optOutKeyId;
  const tag = keys.optOutTagUnder(keyId, id, channel);
  // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: unreachable: the current key is always held
  if (tag === undefined) throw new Error("The current opt-out key is not held.");
  return Buffer.concat([
    Buffer.from(id.replaceAll("-", ""), "hex"),
    Buffer.from([index, keyId]),
    tag.subarray(0, TAG_BYTES),
  ]).toString("base64url");
}

/**
 * Who a token opts out of what, or null when it is malformed, names a key this server does not hold, or was not signed
 * with the key it names.
 */
export function readOptOutToken(keys: OptOutSigner, token: string): OptOut | null {
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== TOKEN_BYTES || bytes.toString("base64url") !== token) return null;
  const channel = MARKETING_CHANNELS[bytes[CHANNEL_AT] ?? -1];
  if (channel === undefined) return null;
  const playerId = uuidOf(bytes.subarray(0, ID_BYTES));
  const expected = keys.optOutTagUnder(bytes[KEY_ID_AT] ?? 0, playerId, channel);
  if (expected === undefined) return null;
  return safeEqual(bytes.subarray(TAG_AT), expected.subarray(0, TAG_BYTES))
    ? { playerId, channel }
    : null;
}

/** The page a promotional message links to, in the message's language. */
export function optOutUrl(keys: OptOutSigner, target: OptOut, language: Language): string {
  return `https://${JOIN_LINK_HOST}/${language}/opt-out?t=${optOutToken(keys, target)}`;
}
