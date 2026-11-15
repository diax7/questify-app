import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { StorageError } from "#src/storage/client";
import { createMediaCache } from "#src/storage/media-cache";
import { createMediaStore } from "#src/storage/media-store";
import { pgError } from "#test/support/fake-pool";

const KEY =
  "o/11111111-1111-4111-8111-111111111111/e/22222222-2222-4222-8222-222222222222/logo/33333333-3333-4333-8333-333333333333.png";
const NOW = 1_800_000_000_000;

type Call = Readonly<{ sql: string; values: readonly unknown[] }>;

/** A pool whose `query` answers from `answer` (or throws what it throws) and keeps every call. */
function poolOf(answer: (call: Call, nth: number) => unknown): { pool: Pool; calls: Call[] } {
  const calls: Call[] = [];
  const pool = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: answer({ sql, values }, calls.length) ?? [] };
    },
  };
  return { pool: pool as unknown as Pool, calls };
}

const storeOn = (pool: Pool, lines: unknown[] = []) =>
  createMediaStore(pool, {
    origin: "https://api.example.test",
    secret: "s".repeat(32),
    now: () => NOW,
    log: (fields) => lines.push(fields),
  });

/** The media store (T-814, ADR-839) over a fake pool: retries, codes, the cache, links, and no key in a log line. */
describe("the media store", () => {
  it("puts the body with its own hash and the key's type, and tries once more after a dropped connection", async () => {
    const body = Buffer.from("png-bytes");
    const { pool, calls } = poolOf((_call, nth) => {
      if (nth === 1) throw Object.assign(new Error("Connection terminated unexpectedly"), {});
      return [{ written: true }];
    });
    await storeOn(pool).put(KEY, body);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.values).toEqual([
      KEY,
      "image/png",
      createHash("sha256").update(body).digest(),
      body,
    ]);
  });

  it("never retries MB409, answers it as a conflict, and logs the purpose and code without the key", async () => {
    const lines: unknown[] = [];
    const { pool, calls } = poolOf(() => {
      throw pgError({ code: "MB409" });
    });
    const failed = await storeOn(pool, lines)
      .put(KEY, Buffer.from("x"))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(StorageError);
    expect((failed as StorageError).code).toBe("conflict");
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([{ event: "storage.failed", op: "put", purpose: "logo", code: "MB409" }]);
    expect(JSON.stringify(lines)).not.toContain("33333333");
  });

  it("gives up after the second statement timeout as a timeout", async () => {
    const { pool, calls } = poolOf(() => {
      throw pgError({ code: "57014" });
    });
    await expect(storeOn(pool).put(KEY, Buffer.from("x"))).rejects.toMatchObject({
      code: "timeout",
    });
    expect(calls).toHaveLength(2);
  });

  it("reads through the cache, and a delete evicts it", async () => {
    const row = {
      content_type: "image/png",
      bytes: 3,
      sha256: Buffer.alloc(32, 1),
      body: Buffer.from("abc"),
    };
    const { pool, calls } = poolOf((call) =>
      call.sql.startsWith("SELECT * FROM blob_get") ? [row] : [{ n: 1 }],
    );
    const store = storeOn(pool);
    expect((await store.get(KEY))?.body.toString()).toBe("abc");
    expect((await store.get(KEY))?.contentType).toBe("image/png");
    expect(calls.filter((call) => call.sql.includes("blob_get"))).toHaveLength(1);
    expect(await store.deleteMany([KEY])).toBe(1);
    await store.get(KEY);
    expect(calls.filter((call) => call.sql.includes("blob_get"))).toHaveLength(2);
  });

  it("answers undefined for a key with no bytes, and a read failure as unavailable", async () => {
    expect(await storeOn(poolOf(() => []).pool).get(KEY)).toBeUndefined();
    const down = poolOf(() => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    await expect(storeOn(down.pool).get(KEY)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("deletes in statements of at most 500 keys", async () => {
    const { pool, calls } = poolOf((call) => [{ n: (call.values[0] as string[]).length }]);
    const keys = Array.from({ length: 1201 }, (_, n) => `${KEY}${n}`);
    expect(await storeOn(pool).deleteMany(keys)).toBe(1201);
    expect(calls.map((call) => (call.values[0] as string[]).length)).toEqual([500, 500, 201]);
    expect(await storeOn(pool).deleteMany([])).toBe(0);
  });

  it("signs a link on the media route that it opens, at most 300 s, stable for one start", () => {
    const store = storeOn(poolOf(() => []).pool);
    const signed = store.signGet(KEY, 300);
    const url = new URL(signed.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://api.example.test/v1/media/${KEY}`);
    expect(signed.expiresAt.getTime()).toBe(NOW + 300_000);
    expect(store.checkLink(KEY, url.searchParams.get("e"), url.searchParams.get("s"))).toBe(true);
    const at = new Date(NOW - 30_000);
    expect(store.signGet(KEY, 120, at).url).toBe(store.signGet(KEY, 120, at).url);
    expect(() => store.signGet(KEY, 301)).toThrow(/at most 300/);
    expect(() => store.signGet(KEY, 0)).toThrow(RangeError);
  });
});

const blob = (bytes: number) => ({
  contentType: "image/jpeg" as const,
  bytes,
  sha256: Buffer.alloc(32),
  body: Buffer.alloc(bytes),
});

describe("the media cache", () => {
  it("keeps an entry at most its life, drops the least recently used first, and skips entries over 4 MB", () => {
    let now = 0;
    const cache = createMediaCache({ maxBytes: 10, lifeMs: 60_000, now: () => now });
    cache.set("a", blob(4));
    cache.set("b", blob(4));
    expect(cache.get("a")?.bytes).toBe(4);
    cache.set("c", blob(4));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    now = 60_000;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size()).toBe(4);
    const big = createMediaCache();
    big.set("huge", blob(4 * 1024 * 1024 + 1));
    expect(big.size()).toBe(0);
    cache.evict(["c"]);
    expect(cache.size()).toBe(0);
  });
});
