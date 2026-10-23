import type { Pool } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { countRecent, record, tryLock, type Bucket } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** A per-player limit: at most `max` attempts in `windowSeconds`, counted in `bucket`. */
export type PlayerLimit = Readonly<{ bucket: Bucket; max: number; windowSeconds: number }>;

export type LimitDeps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "playerKey"> }>;

/**
 * Counts one attempt against a per-player limit in its own short transaction (recorded when `keep`), under a
 * non-waiting lock on the player, or answers how many seconds to wait. Never takes a waiting lock, so it cannot join a
 * payer's lock order (ADR-211).
 */
export async function heldBack(
  deps: LimitDeps,
  playerId: string,
  limit: PlayerLimit,
  keep: boolean,
): Promise<number | undefined> {
  const key = deps.keys.playerKey(playerId);
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      if (!(await tryLock(client, key))) {
        return 1;
      }
      const window = await countRecent(client, limit.bucket, key, limit.windowSeconds);
      if (window.count >= limit.max) {
        return window.retryAfterSeconds;
      }
      if (keep) {
        await record(client, limit.bucket, key);
      }
      return undefined;
    }),
  );
}
