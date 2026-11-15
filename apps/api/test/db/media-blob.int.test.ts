import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createMediaTestDatabase,
  type MediaTestDatabase,
} from "#test/support/test-db";

const keyOf = (purpose = "submission", ext = "jpg", id = randomUUID()) =>
  `o/${randomUUID()}/e/${randomUUID()}/${purpose}/${id}.${ext}`;
const sha = (body: Buffer) => createHash("sha256").update(body).digest();

/**
 * The media database (T-814, m0001): the key, type and size CHECKs, `blob_put`'s idempotency on the same hash and
 * MB409 on another, the hash check, deletes of absent keys, and the reconcile's pages, run as the media role.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the media database", () => {
  let media: MediaTestDatabase;
  let app: Client;

  beforeAll(async () => {
    media = await createMediaTestDatabase();
    app = new Client({ connectionString: media.appUrl });
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
    await media.close();
  });
  beforeEach(async () => {
    await media.owner.query("DELETE FROM media_blob");
  });

  const put = (key: string, body: Buffer, type = "image/jpeg", hash = sha(body)) =>
    app.query<{ written: boolean }>("SELECT blob_put($1, $2, $3, $4) AS written", [
      key,
      type,
      hash,
      body,
    ]);

  it("stores a key once, does nothing for the same bytes again, and refuses other bytes with MB409", async () => {
    const key = keyOf();
    const body = Buffer.from("first");
    expect((await put(key, body)).rows[0]?.written).toBe(true);
    expect((await put(key, body)).rows[0]?.written).toBe(false);
    await expect(put(key, Buffer.from("second"))).rejects.toMatchObject({ code: "MB409" });
    const { rows } = await app.query("SELECT * FROM blob_get($1)", [key]);
    expect(rows).toEqual([{ content_type: "image/jpeg", bytes: 5, sha256: sha(body), body }]);
    expect((await app.query("SELECT * FROM blob_get($1)", [keyOf()])).rows).toEqual([]);
  });

  it("refuses a key of another shape, a type its extension does not name, a lying hash, and over 4 MiB", async () => {
    const body = Buffer.from("x");
    for (const key of [
      "o/x/e/y/submission/z.jpg",
      keyOf("submission", "gif"),
      keyOf("Submission"),
      `${keyOf()}/more`,
      keyOf().toUpperCase(),
    ]) {
      await expect(put(key, body), key).rejects.toMatchObject({ code: "23514" });
    }
    await expect(put(keyOf("logo", "png"), body, "image/jpeg")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(put(keyOf("logo", "jpg"), body, "image/png")).rejects.toMatchObject({
      code: "23514",
    });
    expect((await put(keyOf("logo", "png"), body, "image/png")).rows[0]?.written).toBe(true);
    await expect(put(keyOf(), body, "image/jpeg", Buffer.alloc(32))).rejects.toMatchObject({
      code: "MB422",
    });
    const big = Buffer.alloc(4 * 1024 * 1024 + 1, 1);
    await expect(put(keyOf(), big)).rejects.toMatchObject({ code: "23514" });
    await expect(put(keyOf(), Buffer.alloc(0))).rejects.toMatchObject({ code: "23514" });
  });

  it("deletes the keys given, absent ones included, at most 500 a call", async () => {
    const kept = keyOf();
    const gone = keyOf();
    await put(kept, Buffer.from("a"));
    await put(gone, Buffer.from("b"));
    const deleted = await app.query<{ n: number }>("SELECT blob_delete($1::text[]) AS n", [
      [gone, keyOf()],
    ]);
    expect(deleted.rows[0]?.n).toBe(1);
    expect((await media.owner.query("SELECT key FROM media_blob")).rows).toEqual([{ key: kept }]);
    const many = Array.from({ length: 501 }, () => keyOf());
    await expect(app.query("SELECT blob_delete($1::text[])", [many])).rejects.toMatchObject({
      code: "MB422",
    });
  });

  const page = async (after: string | null, n: number) =>
    (
      await app.query<{ key: string }>(
        "SELECT key FROM blob_keys_page($1, now() - interval '1 hour', $2)",
        [after, n],
      )
    ).rows.map((row) => row.key);

  it("pages keys in order after a cursor, only rows older than the cut, at most 500", async () => {
    const keys = Array.from({ length: 5 }, () => keyOf()).toSorted();
    for (const key of keys) await put(key, Buffer.from(key));
    await media.owner.query(
      "UPDATE media_blob SET created_at = now() - interval '2 hours' WHERE key <> $1",
      [keys[4]],
    );
    expect(await page(null, 2)).toEqual(keys.slice(0, 2));
    expect(await page(keys[1] ?? null, 500)).toEqual(keys.slice(2, 4));
    expect(await page(null, 100_000)).toHaveLength(4);
  });
});
