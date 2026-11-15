import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * The media route's short read links (ADR-840): `s` is base64url of the first 16 bytes of HMAC-SHA256, under a key
 * derived from MEDIA_URL_SECRET (HKDF, label `questify-media-get-v1`), over `"<key>\n<e>"`; `e` is the link's expiry in
 * Unix seconds. Pure computation: signing never calls out, and a check reads nothing.
 */
const LABEL = "questify-media-get-v1";
const SIGNATURE_BYTES = 16;
/** 16 bytes in base64url without padding. */
const SIGNATURE = /^[A-Za-z0-9_-]{22}$/;
const EXPIRY = /^[1-9][0-9]{0,11}$/;
/** A link lasts at most 300 s; 5 s more of clock slack between replicas. */
export const LINK_MAX_SECONDS = 300;
export const LINK_SLACK_SECONDS = 5;

/** The signing key, derived once from the secret. */
export const linkKeyOf = (secret: string): Buffer =>
  Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), LABEL, 32));

const mac = (linkKey: Buffer, key: string, expiry: number): Buffer =>
  createHmac("sha256", linkKey).update(`${key}\n${expiry}`).digest().subarray(0, SIGNATURE_BYTES);

/** The `s` of a link to `key` that expires at `expiry` (Unix seconds). */
export const signLink = (linkKey: Buffer, key: string, expiry: number): string =>
  mac(linkKey, key, expiry).toString("base64url");

/**
 * True when `expiry` and `signature` are a link to `key` signed with this key, still in the future and at most 305 s
 * away. A malformed value fails before the compare; the compare itself is constant-time over equal lengths.
 */
export function checkLink(
  linkKey: Buffer,
  key: string,
  expiry: unknown,
  signature: unknown,
  nowMs: number,
): boolean {
  if (typeof expiry !== "string" || typeof signature !== "string") return false;
  if (!EXPIRY.test(expiry) || !SIGNATURE.test(signature)) return false;
  const at = Number(expiry);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== SIGNATURE_BYTES) return false;
  if (!timingSafeEqual(mac(linkKey, key, at), given)) return false;
  const now = nowMs / 1000;
  return at > now && at <= now + LINK_MAX_SECONDS + LINK_SLACK_SECONDS;
}
