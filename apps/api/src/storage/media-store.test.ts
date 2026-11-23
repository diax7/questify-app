import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { StorageError } from "#src/storage/client";
import {
  CACHE_BYTES,
  CACHE_ENTRY_BYTES,
  CACHE_LIFE_MS,
  createMediaCache,
} from "#src/storage/media-cache";
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

const failing = (thrown: unknown) =>
  poolOf(() => {
    throw thrown;
  });
const failedGet = async (thrown: unknown, key = KEY) => {
  const lines: unknown[] = [];
  const { pool } = poolOf(() => {
    throw thrown;
  });
  const error = await storeOn(pool, lines)
    .get(key)
    .catch((caught: unknown) => caught);
  return { error: error as StorageError, lines };
};

const triesOf = async (code: string) => {
  const { pool, calls } = poolOf(() => {
    throw pgError({ code });
  });
  await storeOn(pool)
    .put(KEY, Buffer.from("x"))
    .catch(() => undefined);
  return calls.length;
};

/** What the log line of a failed call carries (docs/RUNBOOK.md: `storage.failed` shows operation, purpose and status only). */
describe("the media store's failures", () => {
  it("logs the operation, the key's purpose and the code of a read that failed", async () => {
    const { error, lines } = await failedGet(pgError({ code: "57014" }));
    expect(error).toBeInstanceOf(StorageError);
    expect(error.code).toBe("timeout");
    expect(lines).toEqual([{ event: "storage.failed", op: "get", purpose: "logo", code: "57014" }]);
  });

  it("names the purpose only from a key shaped o/<organizer>/e/<event>/<purpose>/, and unknown otherwise", async () => {
    const shaped = await failedGet(new Error("connect ECONNREFUSED"), KEY);
    expect(shaped.lines).toEqual([
      { event: "storage.failed", op: "get", purpose: "logo", code: "unavailable" },
    ]);
    for (const key of ["", "not-a-media-key", `x/${KEY}`, "o/a/e/b/Logo/c.png"]) {
      const odd = await failedGet(new Error("down"), key);
      expect(odd.lines, key).toEqual([
        { event: "storage.failed", op: "get", purpose: "unknown", code: "unavailable" },
      ]);
    }
  });

  it("reads a code only when it is five characters of digits and capitals, and answers unavailable for anything else", async () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "mb409", "5701", 12345, null, undefined]) {
      const { pool, calls } = failing(Object.assign(new Error("down"), { code }));
      await expect(storeOn(pool).put(KEY, Buffer.from("x")), String(code)).rejects.toMatchObject({
        code: "unavailable",
      });
      // No SQLSTATE was read, so the failure is a dropped connection: one more try.
      expect(calls, String(code)).toHaveLength(2);
    }
    const { error, lines } = await failedGet(
      Object.assign(new Error("down"), { code: "ECONNREFUSED" }),
    );
    expect(error.code).toBe("unavailable");
    expect(lines).toEqual([
      { event: "storage.failed", op: "get", purpose: "logo", code: "unavailable" },
    ]);
  });

  it("survives a call that fails with nothing at all", async () => {
    for (const thrown of [null, undefined]) {
      const { error } = await failedGet(thrown);
      expect(error).toBeInstanceOf(StorageError);
      expect(error.code).toBe("unavailable");
    }
  });

  it("answers a timeout for a failure with no code and a timeout message only", async () => {
    const message = await failedGet(new Error("Connection terminated due to connection timeout"));
    expect(message.error.code).toBe("timeout");
    expect(message.lines).toEqual([
      { event: "storage.failed", op: "get", purpose: "logo", code: "timeout" },
    ]);
    const coded = await failedGet(pgError({ code: "42P01" }));
    expect(coded.error.code).toBe("unavailable");
    const named = await failedGet(Object.assign(new Error("query timeout"), { code: "XX000" }));
    expect(named.error.code).toBe("unavailable");
    expect(named.lines).toEqual([
      { event: "storage.failed", op: "get", purpose: "logo", code: "XX000" },
    ]);
    const thrownString = await failedGet("timeout");
    expect(thrownString.error.code).toBe("unavailable");
  });

  it("retries a put after a dropped connection, a statement timeout and a restart, and after no other SQLSTATE", async () => {
    for (const code of ["08000", "08006", "08P01", "57014", "57P01", "57P02", "57P03"]) {
      expect(await triesOf(code), code).toBe(2);
    }
    for (const code of ["22008", "42P08", "57P04", "57P00", "23505", "MB409", "40001"]) {
      expect(await triesOf(code), code).toBe(1);
    }
  });

  it("logs a failed delete with its operation and the purpose of the batch's first key", async () => {
    const lines: unknown[] = [];
    const { pool } = poolOf(() => {
      throw pgError({ code: "57014" });
    });
    await expect(storeOn(pool, lines).deleteMany([KEY])).rejects.toMatchObject({
      code: "timeout",
    });
    expect(lines).toEqual([
      { event: "storage.failed", op: "delete", purpose: "logo", code: "57014" },
    ]);
  });

  it("deletes in whole batches only: 1,000 keys are two statements, and a statement that answers no row counts none", async () => {
    const { pool, calls } = poolOf(() => []);
    const keys = Array.from({ length: 1000 }, (_, n) => `${KEY}${n}`);
    expect(await storeOn(pool).deleteMany(keys)).toBe(0);
    expect(calls.map((call) => (call.values[0] as string[]).length)).toEqual([500, 500]);
    const none = poolOf(() => []);
    expect(await storeOn(none.pool).deleteMany([])).toBe(0);
    expect(none.calls).toHaveLength(0);
  });

  it("pages keys through blob_keys_page, and logs a failed page as a keys call", async () => {
    const when = new Date(NOW);
    const ok = poolOf(() => [{ key: "a" }, { key: "b" }]);
    expect(await storeOn(ok.pool).keysPage("0", when, 500)).toEqual(["a", "b"]);
    expect(ok.calls).toEqual([
      { sql: "SELECT key FROM blob_keys_page($1, $2, $3)", values: ["0", when, 500] },
    ]);
    const lines: unknown[] = [];
    const { pool } = poolOf(() => {
      throw pgError({ code: "57014" });
    });
    await expect(storeOn(pool, lines).keysPage(null, when, 500)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(lines).toEqual([
      { event: "storage.failed", op: "keys", purpose: "unknown", code: "57014" },
    ]);
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

  it("is 32 MB in all, entries up to 4 MB, each kept 60 s", () => {
    expect([CACHE_BYTES, CACHE_ENTRY_BYTES, CACHE_LIFE_MS]).toEqual([
      33_554_432, 4_194_304, 60_000,
    ]);
  });

  it("keeps an entry of exactly 4 MB, and skips one a byte over, leaving what it holds", () => {
    const cache = createMediaCache();
    cache.set("small", blob(1));
    cache.set("exact", blob(CACHE_ENTRY_BYTES));
    expect(cache.get("exact")?.bytes).toBe(CACHE_ENTRY_BYTES);
    cache.set("over", blob(CACHE_ENTRY_BYTES + 1));
    expect(cache.get("over")).toBeUndefined();
    expect(cache.get("small")).toBeDefined();
    expect(cache.size()).toBe(CACHE_ENTRY_BYTES + 1);
  });

  it("keeps an entry of exactly its budget by dropping the rest, and skips one over it without emptying the cache", () => {
    const cache = createMediaCache({ maxBytes: 10 });
    cache.set("a", blob(4));
    cache.set("b", blob(10));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")?.bytes).toBe(10);
    expect(cache.size()).toBe(10);
    cache.set("big", blob(11));
    expect(cache.get("big")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.size()).toBe(10);
  });

  it("fills to exactly its budget before it drops anything", () => {
    const cache = createMediaCache({ maxBytes: 10 });
    cache.set("a", blob(4));
    cache.set("b", blob(6));
    expect(cache.size()).toBe(10);
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeDefined();
    cache.set("c", blob(1));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size()).toBe(7);
  });

  it("counts a key set again once, with the new bytes", () => {
    const cache = createMediaCache({ maxBytes: 10 });
    cache.set("a", blob(4));
    cache.set("a", blob(6));
    expect(cache.size()).toBe(6);
    cache.evict(["a"]);
    expect(cache.size()).toBe(0);
  });

  it("lives 60 s by default and its own life when given one", () => {
    let now = 1_000;
    const byDefault = createMediaCache({ now: () => now });
    byDefault.set("a", blob(1));
    now = 1_000 + CACHE_LIFE_MS - 1;
    expect(byDefault.get("a")).toBeDefined();
    byDefault.set("b", blob(1));
    now = 1_000 + CACHE_LIFE_MS;
    expect(byDefault.get("a")).toBeUndefined();
    expect(byDefault.get("b")).toBeDefined();
    now = 0;
    const brief = createMediaCache({ lifeMs: 1_000, now: () => now });
    brief.set("a", blob(1));
    now = 999;
    expect(brief.get("a")).toBeDefined();
    now = 1_000;
    expect(brief.get("a")).toBeUndefined();
  });
});
