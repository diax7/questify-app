import { randomUUID } from "node:crypto";
import { Pool, type Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ObjectStore } from "#src/storage/client";
import { createMediaStore } from "#src/storage/media-store";
import { startMediaWorker } from "#src/storage/worker";
import { startMediaFixture, type MediaFixture } from "#test/storage/media-test-store";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

const keyOf = () => `o/${randomUUID()}/e/${randomUUID()}/submission/${randomUUID()}.jpg`;

/**
 * The media worker over both databases (T-301b, T-814): a claimed round leaves the media database in one delete after
 * the claim has committed, a key already gone is done, a media database that fails backs the round off with its code,
 * and a later run deletes it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("media worker", () => {
  let db: TestDatabase;
  let pool: Pool;
  let media: MediaFixture;
  let watcher: Client;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 3 });
    watcher = await connectAsOwner(db);
    media = await startMediaFixture();
  });
  afterAll(async () => {
    await watcher.end();
    await pool.end();
    await media.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.owner.query("DELETE FROM media_delete");
    await media.media.owner.query("DELETE FROM media_blob");
    lines.length = 0;
  });

  const worker = (store: ObjectStore = media.store) =>
    startMediaWorker({
      pool,
      store,
      intervalMs: 3_600_000,
      log: (_level, fields) => lines.push(fields),
    });
  const queue = (...keys: string[]) =>
    db.owner.query("INSERT INTO media_delete (key) SELECT unnest($1::text[])", [keys]);

  it("deletes queued keys from the media database, counts a key already gone as done, and empties the queue", async () => {
    const stored = keyOf();
    await media.store.put(stored, Buffer.from("a"));
    await queue(stored, keyOf());
    const running = worker();
    expect(await running.runOnce()).toEqual({ swept: 0, purged: 0, deleted: 2, failed: 0 });
    await running.stop();
    expect(await media.keys()).toEqual([]);
    expect((await db.owner.query("SELECT key FROM media_delete")).rows).toEqual([]);
  });

  it("calls the media database once a round, only after the claim has committed, with every key leased", async () => {
    await queue(keyOf(), keyOf(), keyOf());
    const seen: unknown[] = [];
    const watching: ObjectStore = {
      ...media.store,
      deleteMany: async (keys) => {
        const { rows } = await watcher.query(
          "SELECT bool_and(lease_until > now()) AS leased, count(*)::int AS n FROM media_delete WHERE key = ANY ($1)",
          [keys],
        );
        seen.push(rows[0]);
        return media.store.deleteMany(keys);
      },
    };
    const running = worker(watching);
    await running.runOnce();
    await running.stop();
    expect(seen).toEqual([{ leased: true, n: 3 }]);
  });

  it("keeps a round whose delete failed, backs it off with media_unavailable, and deletes it on a later run", async () => {
    const key = keyOf();
    await media.store.put(key, Buffer.from("b"));
    await queue(key);
    const down = new Pool({
      connectionString: "postgres://nobody:x@127.0.0.1:9/none",
      connectionTimeoutMillis: 500,
    });

    const failing = createMediaStore(down, { origin: "https://m.test", secret: "d".repeat(32) });
    const broken = worker(failing);
    expect(await broken.runOnce()).toMatchObject({ deleted: 0, failed: 1 });
    await broken.stop();
    await down.end();
    const [row] = (
      await db.owner.query<{ attempts: number; code: string; later: boolean }>(
        "SELECT attempts, last_code AS code, due_at > now() AS later FROM media_delete WHERE key = $1",
        [key],
      )
    ).rows;
    expect(row).toEqual({ attempts: 1, code: "media_unavailable", later: true });
    const running = worker();
    expect(await running.runOnce()).toMatchObject({ deleted: 0, failed: 0 });
    await db.owner.query("UPDATE media_delete SET due_at = now() - interval '1 second'");
    expect(await running.runOnce()).toMatchObject({ deleted: 1, failed: 0 });
    await running.stop();
    expect(await media.keys()).toEqual([]);
    expect(JSON.stringify(lines)).not.toContain(key);
  });
});
