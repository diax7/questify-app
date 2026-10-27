import {
  JOIN_LINK_HOSTS,
  MARKETING_CHANNELS,
  type Language,
  type MarketingChannel,
} from "@questify/shared";
import { safeEqual, type AuthKeys } from "#src/auth/keys";

/**
 * The signed opt-out link in every promotional message (FR-1114, ADR-317). The token is stateless: the player's id,
 * the channel and a keyed tag over both, so it needs no table, works for as long as the secret does, and cannot be
 * made for another player or channel without the key.
 */

const ID_BYTES = 16;
const TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type OptOut = Readonly<{ playerId: string; channel: MarketingChannel }>;
type Signer = Pick<AuthKeys, "optOutTag">;

const uuidOf = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The token for one player and channel. */
export function optOutToken(keys: Signer, { playerId, channel }: OptOut): string {
  const id = playerId.toLowerCase();
  if (!UUID.test(id)) throw new Error("An opt-out token needs the player's UUID.");
  const index = MARKETING_CHANNELS.indexOf(channel);
  const tag = keys.optOutTag(id, channel).subarray(0, TAG_BYTES);
  return Buffer.concat([
    Buffer.from(id.replaceAll("-", ""), "hex"),
    Buffer.from([index]),
    tag,
  ]).toString("base64url");
}

/** Who a token opts out of what, or null when it is malformed or was not signed with this server's key. */
export function readOptOutToken(keys: Signer, token: string): OptOut | null {
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== ID_BYTES + 1 + TAG_BYTES || bytes.toString("base64url") !== token)
    return null;
  const channel = MARKETING_CHANNELS[bytes[ID_BYTES] ?? -1];
  if (channel === undefined) return null;
  const playerId = uuidOf(bytes.subarray(0, ID_BYTES));
  const expected = keys.optOutTag(playerId, channel).subarray(0, TAG_BYTES);
  return safeEqual(bytes.subarray(ID_BYTES + 1), expected) ? { playerId, channel } : null;
}

/** The page a promotional message links to, in the message's language. */
export function optOutUrl(keys: Signer, target: OptOut, language: Language): string {
  return `https://${JOIN_LINK_HOSTS[0]}/${language}/opt-out?t=${optOutToken(keys, target)}`;
}
