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

/** The media pool (T-814, ADR-839): 4 connections, one 10 s statement limit for every read and write (review 86). */
export const MEDIA_POOL_SIZE = 4;
const MEDIA_STATEMENT_TIMEOUT_MS = 10_000;
const MEDIA_CONNECT_TIMEOUT_MS = 5000;

export function mediaPoolOptions(databaseUrl: string): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: MEDIA_POOL_SIZE,
    statement_timeout: MEDIA_STATEMENT_TIMEOUT_MS,
    query_timeout: MEDIA_STATEMENT_TIMEOUT_MS + 1000,
    connectionTimeoutMillis: MEDIA_CONNECT_TIMEOUT_MS,
    options: `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
  };
}
