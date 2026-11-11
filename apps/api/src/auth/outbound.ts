import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AUTH_LIMITS } from "#src/auth/limits";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** One key for the whole platform: the budget counts every sign-up and invite email, whoever asks. */
const GLOBAL_KEY = createHash("sha256").update("questify.outbound_mail").digest();

/**
 * `takeOutboundMail` inside a transaction the caller already holds, so the unit is taken, or given back by a rollback,
 * together with the caller's own change. The counter's lock lasts until that transaction ends: the caller does no more
 * than a short write after this and takes no other pooled connection meanwhile (the sign-up resend, ADR-823).
 */
export async function takeOutboundMailIn(client: PoolClient): Promise<boolean> {
  const { max, windowSeconds } = AUTH_LIMITS.outboundMailPerDay;
  await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    GLOBAL_KEY.readBigInt64BE(0).toString(),
  ]);
  const used = await countRecent(client, BUCKETS.outboundMail, GLOBAL_KEY, windowSeconds);
  if (used.count >= max) {
    return false;
  }
  await record(client, BUCKETS.outboundMail, GLOBAL_KEY);
  return true;
}

/**
 * Takes one email from the daily budget for mail anyone can make Questify send (sign-up codes, "you already have an
 * account", invites). The budget sits well under the mail provider's daily quota, so sign-in and reset codes always
 * have room (T-101, M5).
 *
 * Requests wait their turn for the counter (one count and one insert), so two arriving together both get an answer.
 *
 * @returns false when today's budget is spent.
 */
export async function takeOutboundMail(pool: Pool): Promise<boolean> {
  return withConnection(pool, (client) =>
    withRequestContext(client, {}, () => takeOutboundMailIn(client)),
  );
}
