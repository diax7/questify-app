import { Pool, type Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createObjectStore, type ObjectStore } from "#src/storage/client";
import { ROUND_BUDGET_MS, startMediaWorker } from "#src/storage/worker";
import { startFakeS3, type FakeS3 } from "#test/storage/fake-s3";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

const KEY = (n: number) => `o/00000000-0000-4000-8000-00000000000${n}/e/x/submission/k${n}.jpg`;

/**
 * The media worker over a real database and the S3 double (T-301b): deletes leave the bucket after the claim has
 * committed, a 404 is done, a failure backs off and is tried again, and the sweep runs every time.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("media worker", () => {
  let db: TestDatabase;
  let pool: Pool;
  let fake: FakeS3;
  let store: ObjectStore;
  let watcher: Client;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 3 });
    watcher = await connectAsOwner(db);
    fake = await startFakeS3();
    store = createObjectStore(fake.settings, { retryDelayMs: 1, timeoutMs: 500 });
  });
  afterAll(async () => {
    await watcher.end();
    await pool.end();
    await fake.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.owner.query("DELETE FROM media_delete");
    fake.objects.clear();
    fake.script.length = 0;
    lines.length = 0;
  });

  const worker = (deleteStore: ObjectStore = store) =>
    startMediaWorker({
      pool,
      store: deleteStore,
      intervalMs: 3_600_000,
      log: (_level, fields) => lines.push(fields),
    });
  const queue = (...keys: string[]) =>
    db.owner.query("INSERT INTO media_delete (key) SELECT unnest($1::text[])", [keys]);

  it("deletes queued objects from the bucket, counts a 404 as done, and empties the queue", async () => {
    fake.objects.set(KEY(1), { body: Buffer.from("a"), contentType: "image/jpeg" });
    await queue(KEY(1), KEY(2));
    const running = worker();
    expect(await running.runOnce()).toEqual({ swept: 0, purged: 0, deleted: 2, failed: 0 });
    await running.stop();
    expect(fake.objects.size).toBe(0);
    expect((await db.owner.query("SELECT key FROM media_delete")).rows).toEqual([]);
  });

  it("calls the bucket only after the claim has committed, with the key leased", async () => {
    await queue(KEY(3));
    const seen: unknown[] = [];
    const watching: ObjectStore = {
      ...store,
      delete: async (key) => {
        const { rows } = await watcher.query(
          "SELECT lease_until > now() AS leased FROM media_delete WHERE key = $1",
          [key],
        );
        seen.push(rows[0]);
        await store.delete(key);
      },
    };
    const running = worker(watching);
    await running.runOnce();
    await running.stop();
    expect(seen).toEqual([{ leased: true }]);
  });

  it("keeps a key whose delete failed, backs it off with its code, and deletes it on a later run", async () => {
    fake.objects.set(KEY(4), { body: Buffer.from("b"), contentType: "image/jpeg" });
    await queue(KEY(4));
    fake.script.push({ status: 500 }, { status: 500 }, { status: 503 });
    const running = worker();
    expect(await running.runOnce()).toMatchObject({ deleted: 0, failed: 1 });
    const [row] = (
      await db.owner.query<{ attempts: number; code: string; later: boolean }>(
        "SELECT attempts, last_code AS code, due_at > now() AS later FROM media_delete WHERE key = $1",
        [KEY(4)],
      )
    ).rows;
    expect(row).toEqual({ attempts: 1, code: "status_503", later: true });
    expect(await running.runOnce()).toMatchObject({ deleted: 0, failed: 0 });
    await db.owner.query("UPDATE media_delete SET due_at = now() - interval '1 second'");
    expect(await running.runOnce()).toMatchObject({ deleted: 1, failed: 0 });
    await running.stop();
    expect(fake.objects.has(KEY(4))).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("k4.jpg");
  });
  it("starts no delete past the round's budget, so a slow bucket never outlasts the 5-minute lease", async () => {
    const keys = Array.from({ length: 50 }, (_, n) => `o/x/e/x/submission/slow${n}.jpg`);
    await queue(...keys);
    let clock = 0;
    const slow: ObjectStore = {
      ...store,
      delete: async (key) => {
        clock += 31_000;
        await store.delete(key);
      },
    };
    const running = startMediaWorker({
      pool,
      store: slow,
      intervalMs: 3_600_000,
      log: (_level, fields) => lines.push(fields),
      now: () => clock,
    });
    const started = Math.ceil(ROUND_BUDGET_MS / 31_000);
    expect(await running.runOnce()).toEqual({ swept: 0, purged: 0, deleted: started, failed: 0 });
    await running.stop();
    // The last delete started before the budget and ended inside the lease.
    expect(started * 31_000).toBeLessThan(5 * 60_000);
    const { rows } = await db.owner.query<{ n: number; leased: number; tried: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE lease_until > now())::int AS leased,
              count(*) FILTER (WHERE attempts > 0)::int AS tried FROM media_delete`,
    );
    expect(rows[0]).toEqual({ n: 50 - started, leased: 50 - started, tried: 0 });
  });
});
