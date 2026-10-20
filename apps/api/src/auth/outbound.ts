import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { AUTH_LIMITS } from "#src/auth/limits";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** One key for the whole platform: the budget counts every sign-up and invite email, whoever asks. */
const GLOBAL_KEY = createHash("sha256").update("questify.outbound_mail").digest();

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
  const { max, windowSeconds } = AUTH_LIMITS.outboundMailPerDay;
  return withConnection(pool, (client) =>
    withRequestContext(client, {}, async () => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        GLOBAL_KEY.readBigInt64BE(0).toString(),
      ]);
      const used = await countRecent(client, BUCKETS.outboundMail, GLOBAL_KEY, windowSeconds);
      if (used.count >= max) {
        return false;
      }
      await record(client, BUCKETS.outboundMail, GLOBAL_KEY);
      return true;
    }),
  );
}
