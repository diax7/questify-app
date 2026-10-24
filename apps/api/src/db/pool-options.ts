import type { PoolConfig } from "pg";
import type { AppConfig } from "#src/config";

const STATEMENT_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 3000;
/**
 * A transaction left idle this long is ended by the server (T-306b, ADR-222): the community tick's settle point waits
 * for the oldest open transaction, so a forgotten one must not hold it back for long.
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

/** The API pool's options: statement, lock and idle-transaction limits on every connection. */
export function poolOptions(
  config: Pick<AppConfig, "databaseUrl" | "databasePoolSize">,
): PoolConfig {
  return {
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 1000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c lock_timeout=${LOCK_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  };
}
