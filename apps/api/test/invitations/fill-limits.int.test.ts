import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { poolOptions } from "#src/db/pool-options";
import { withFillLimits } from "#src/invitation-campaigns/tick";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * The fill's own limits (T-409 code review MAJOR 1, ADR-334 (4)): on a pool built exactly like the API's (the server's
 * 5 s statement limit and the client's 6 s read limit), a statement run through `withFillLimits` outlives both, so a
 * fill of 100,000 players commits instead of rolling back and restarting every tick. The same statement without them is
 * cut off, which proves the pool would stop it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the fill's own time limits", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool(poolOptions({ databaseUrl: TEST_DATABASE_URL ?? "", databasePoolSize: 2 }));
  });
  afterAll(async () => {
    await pool.end();
  });

  const inTransaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, {}, () => work(client));
    } finally {
      client.release(true);
    }
  };

  it("lets a statement run past 7 s under the API pool's limits", async () => {
    const started = Date.now();
    const { rows } = await inTransaction((client) =>
      withFillLimits<{ done: boolean }>(client, "SELECT true AS done FROM pg_sleep(7)"),
    );
    expect(rows).toEqual([{ done: true }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(7000);
  }, 20_000);

  it("is needed: the same statement without them is cut off", async () => {
    await expect(
      inTransaction((client) => client.query("SELECT true AS done FROM pg_sleep(7)")),
    ).rejects.toThrow(/statement timeout|Query read timeout/);
  }, 20_000);
});
