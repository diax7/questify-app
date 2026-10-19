import type { Client, Pool, PoolClient } from "pg";

/**
 * Borrows one connection from the pool for `work` and always gives it back. Services own the connection and the
 * transaction; the store functions they call take the client and never open their own (docs/ARCHITECTURE.md).
 */
export async function withConnection<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

/**
 * Sets transaction-local settings (the row-level-security context) in one round trip. Each setting lasts until the
 * transaction ends, so nothing carries over to the next request on the same connection.
 */
export async function setLocalSettings(
  client: Client | PoolClient,
  entries: ReadonlyArray<readonly [name: string, value: string]>,
): Promise<void> {
  await client.query(
    "SELECT set_config(name, value, true) FROM unnest($1::text[], $2::text[]) AS setting(name, value)",
    [entries.map(([name]) => name), entries.map(([, value]) => value)],
  );
}
