import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  MAX_SIGNED_SECONDS,
  StorageError,
  typeOfKey,
  type ObjectStore,
  type StoreOp,
  type StoredBlob,
  type StoredType,
} from "#src/storage/client";
import { createMediaCache, type MediaCache } from "#src/storage/media-cache";
import { checkLink, linkKeyOf, signLink } from "#src/storage/media-link";

export type MediaStoreOptions = Readonly<{
  /** The public https origin that serves `/v1/media/*` (MEDIA_ORIGIN). */
  origin: string;
  /** MEDIA_URL_SECRET; only a derived key is kept. */
  secret: string;
  cache?: MediaCache;
  now?: () => number;
  /** One line per failed call: its operation, the key's purpose and a code. Never a key or a link. */
  log?: (fields: Readonly<Record<string, unknown>>) => void;
}>;

const PURPOSE = /^o\/[^/]+\/e\/[^/]+\/([a-z_]+)\//;
/** One statement deletes at most this many keys (m0001 `blob_delete`). */
const DELETE_BATCH = 500;

const purposeOf = (key: string): string => PURPOSE.exec(key)?.[1] ?? "unknown";

const sqlstateOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
};

/** A connection that failed or was cut, or a statement that ran out of time: safe to repeat for one key and hash. */
export function isRetryable(error: unknown): boolean {
  const state = sqlstateOf(error);
  return (
    state === undefined || state === "57014" || state.startsWith("08") || /^57P0[1-3]$/.test(state)
  );
}

function storageErrorOf(op: StoreOp, error: unknown): StorageError {
  const state = sqlstateOf(error);
  if (state === "MB409") return new StorageError(op, "conflict");
  const message = error instanceof Error ? error.message : "";
  const timedOut = state === "57014" || (state === undefined && /timeout/i.test(message));
  return new StorageError(op, timedOut ? "timeout" : "unavailable");
}

/**
 * The media store over the media database's pool (ADR-839): every call is one statement through a definer, with the
 * pool's own timeouts. A put is tried once more after a connection error or a statement timeout (the same key and hash
 * are safe to repeat), never after MB409. Reads go through the cache first; deletes evict it.
 */
export function createMediaStore(pool: Pool, options: MediaStoreOptions): ObjectStore {
  const linkKey = linkKeyOf(options.secret);
  const cache = options.cache ?? createMediaCache();
  const now = options.now ?? Date.now;

  const fail = (op: StoreOp, key: string, error: unknown): StorageError => {
    const failure = storageErrorOf(op, error);
    options.log?.({
      event: "storage.failed",
      op,
      purpose: purposeOf(key),
      code: sqlstateOf(error) ?? failure.code,
    });
    return failure;
  };

  const put = async (key: string, body: Buffer): Promise<void> => {
    const sha256 = createHash("sha256").update(body).digest();
    const values = [key, typeOfKey(key), sha256, body];
    for (let tried = 1; ; tried += 1) {
      try {
        await pool.query("SELECT blob_put($1, $2, $3, $4) AS written", values);
        return;
      } catch (error) {
        if (tried >= 2 || !isRetryable(error)) throw fail("put", key, error);
      }
    }
  };

  const get = async (key: string): Promise<StoredBlob | undefined> => {
    const kept = cache.get(key);
    if (kept !== undefined) return kept;
    try {
      const { rows } = await pool.query<{
        content_type: StoredType;
        bytes: number;
        sha256: Buffer;
        body: Buffer;
      }>("SELECT * FROM blob_get($1)", [key]);
      const row = rows[0];
      if (row === undefined) return undefined;
      const blob = {
        contentType: row.content_type,
        bytes: row.bytes,
        sha256: row.sha256,
        body: row.body,
      };
      cache.set(key, blob);
      return blob;
    } catch (error) {
      throw fail("get", key, error);
    }
  };

  const deleteMany = async (keys: readonly string[]): Promise<number> => {
    cache.evict(keys);
    let gone = 0;
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH);
      try {
        const { rows } = await pool.query<{ n: number }>("SELECT blob_delete($1::text[]) AS n", [
          batch,
        ]);
        gone += rows[0]?.n ?? 0;
      } catch (error) {
        throw fail("delete", batch[0] ?? "", error);
      }
    }
    return gone;
  };

  return {
    put,
    get,
    deleteMany,
    keysPage: async (after, olderThan, n) => {
      try {
        const { rows } = await pool.query<{ key: string }>(
          "SELECT key FROM blob_keys_page($1, $2, $3)",
          [after, olderThan, n],
        );
        return rows.map((row) => row.key);
      } catch (error) {
        throw fail("keys", "", error);
      }
    },
    signGet: (key, ttlSeconds, from) => {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_SIGNED_SECONDS) {
        throw new RangeError(`A signed read lasts 1 to at most ${MAX_SIGNED_SECONDS} seconds.`);
      }
      const at = from?.getTime() ?? now();
      const expiry = Math.floor(at / 1000) + ttlSeconds;
      const url = `${options.origin}/v1/media/${key}?e=${expiry}&s=${signLink(linkKey, key, expiry)}`;
      return { url, expiresAt: new Date(expiry * 1000) };
    },
    checkLink: (key, expiry, signature) => checkLink(linkKey, key, expiry, signature, now()),
  };
}
