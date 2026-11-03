import type { Pool } from "pg";
import type { PoolName } from "#src/telemetry/attributes";
import { gaugeSources } from "#src/telemetry/instruments";

/**
 * Reports a connection pool's size, idle count and waiting count (`questify.db.pool.connections`). A pool that has
 * clients waiting is the first sign of a slow database (`database.busy` answers follow). Returns the call that stops
 * watching it.
 */
export function watchPool(name: PoolName, pool: Pool): () => void {
  gaugeSources.pools.set(name, pool);
  return () => {
    if (gaugeSources.pools.get(name) === pool) {
      gaugeSources.pools.delete(name);
    }
  };
}
