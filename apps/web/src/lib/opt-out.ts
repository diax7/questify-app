import { MARKETING_CHANNELS, type MarketingChannel } from "@questify/shared";
import type { PostResult } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";

/** A token's id (16 bytes) comes first, then its channel, then the tag (apps/api/src/marketing/opt-out.ts). */
const ID_BYTES = 16;
const TOKEN_BYTES = 33;
const TOKEN_TEXT = /^[A-Za-z0-9_-]{44}$/;

/**
 * The channel a link names, to say it on the page before the person confirms. The API checks the signature; this only
 * reads the byte that names the channel, so a made-up token shows a page whose button the API refuses.
 */
export function channelOfToken(token: string | undefined): MarketingChannel | null {
  if (token === undefined || !TOKEN_TEXT.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  return bytes.length === TOKEN_BYTES ? (MARKETING_CHANNELS[bytes[ID_BYTES] ?? -1] ?? null) : null;
}

export type OptOutResult = "done" | "invalid" | "too_many" | "network";

/** What the API's answer to the opt-out call means for the page. */
export function optOutResult(result: PostResult): OptOutResult {
  if (result.ok) return "done";
  if (result.status === 429) return "too_many";
  return errorCodeOf(result.body) === "invalid_opt_out" ? "invalid" : "network";
}
