import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { reconcileMedia } from "#src/storage/reconcile";
import { startMediaWorker } from "#src/storage/worker";
import { startMediaFixture, type MediaFixture } from "#test/storage/media-test-store";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * Both databases together (T-814, ADR-839): a deleted `media_object` row leaves no byte row after one worker run, a put
 * that lands after its slot was swept is deleted again, and the daily reconcile deletes old byte rows nothing names,
 * keeps named and young ones, and stops at its cap.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the main and media databases together", () => {
  let db: TestDatabase;
  let pool: Pool;
  let media: MediaFixture;
  let tenants: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 3 });
    media = await startMediaFixture();
    tenants = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await pool.end();
    await media.close();
    await db.close();
  });
  beforeEach(async () => {
    await db.owner.query("DELETE FROM media_object");
    await db.owner.query("DELETE FROM media_delete");
    await media.media.owner.query("DELETE FROM media_blob");
  });

  /** `n` photo rows of player A in `event` (event A by default), their bytes in the media database. */
  const named = async (n: number, event = tenants.eventA): Promise<string[]> => {
    counter += 1;
    const { rows } = await db.owner.query<{ id: string; key: string }>(
      `INSERT INTO media_object (id, organizer_id, event_id, purpose, key, uploaded_by_player, request_key)
       SELECT id, $1::uuid, $2::uuid, 'submission', 'o/' || $1::uuid::text || '/e/' || $2::uuid::text || '/submission/' || id || '.jpg', $3::uuid,
              'k' || $4 || '-' || s.n
       FROM (SELECT gen_random_uuid() AS id, g AS n FROM generate_series(1, $5) g) s
       RETURNING id, key`,
      [tenants.orgA, event, tenants.playerA, counter, n],
    );
    for (const row of rows) await media.store.put(row.key, Buffer.from(row.id));
    return rows.map((row) => row.key);
  };
  const orphan = async (): Promise<string> => {
    const key = `o/${tenants.orgB}/e/${tenants.eventB}/submission/${crypto.randomUUID()}.jpg`;
    await media.store.put(key, Buffer.from(key));
    return key;
  };
  const ageAll = (except: readonly string[] = []) =>
    media.media.owner.query(
      "UPDATE media_blob SET created_at = now() - interval '2 hours' WHERE NOT (key = ANY ($1))",
      [except],
    );
  const runWorker = async () => {
    const worker = startMediaWorker({
      pool,
      store: media.store,
      intervalMs: 3_600_000,
      log: () => undefined,
    });
    const totals = await worker.runOnce();
    await worker.stop();
    return totals;
  };

  it("deletes the bytes of every row an event's deletion takes (the cascade an erasure, wipe or purge ends in)", async () => {
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'GONE1', 'Gone', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [tenants.orgA],
    );
    const event = rows[0]?.id ?? "";
    const kept = await named(1);
    await named(3, event);
    expect(await media.keys()).toHaveLength(4);
    await db.owner.query("DELETE FROM event WHERE id = $1", [event]);
    expect((await runWorker()).deleted).toBe(3);
    expect(await media.keys()).toEqual(kept);
  });

  it("deletes again the bytes of a put that landed after its slot was swept", async () => {
    const [key] = await named(1);
    const { rows } = await db.owner.query<{ id: string }>(
      "SELECT id FROM media_object WHERE key = $1",
      [key],
    );
    const id = rows[0]?.id ?? "";
    await media.store.deleteMany([String(key)]);
    // The sweep takes the slot (its key is queued), and the worker finds nothing to delete yet.
    await db.owner.query("DELETE FROM media_object WHERE id = $1", [id]);
    await runWorker();
    // Then the slow upload lands: its bytes are written and media_stored queues the key again.
    await media.store.put(String(key), Buffer.from("late"));
    const stored = await withRequestContext(db.app, { playerId: tenants.playerA }, () =>
      db.app.query<{ ok: boolean }>("SELECT media_stored($1, $2, 4, 1, 1) AS ok", [id, key]),
    );
    expect(stored.rows[0]?.ok).toBe(false);
    expect((await runWorker()).deleted).toBe(1);
    expect(await media.keys()).toEqual([]);
  });

  it("deletes old byte rows nothing names, keeps named and young ones, and stops at its cap", async () => {
    const keys = await named(20);
    const lost = await orphan();
    const young = await orphan();
    await ageAll([young]);
    expect(await reconcileMedia({ pool, store: media.store })).toEqual({
      outcome: "done",
      scanned: 21,
      unknown: 1,
      deleted: 1,
    });
    expect(await media.keys()).toEqual([...keys, young].toSorted());
    expect(lost).not.toBe(young);

    // A stale main restore: rows the main database no longer names, more than the cap allows.
    await db.owner.query("DELETE FROM media_object WHERE key = ANY ($1)", [keys.slice(0, 3)]);
    await db.owner.query("DELETE FROM media_delete");
    await ageAll();
    expect(await reconcileMedia({ pool, store: media.store })).toEqual({
      outcome: "blocked",
      scanned: 21,
      unknown: 4,
      deleted: 0,
    });
    expect(await media.keys()).toHaveLength(21);
    expect(await reconcileMedia({ pool, store: media.store }, { all: true })).toMatchObject({
      outcome: "done",
      deleted: 4,
    });
    expect(await media.keys()).toEqual(keys.slice(3).toSorted());
  });
});
