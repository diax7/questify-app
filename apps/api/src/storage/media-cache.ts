import type { StoredBlob } from "#src/storage/client";

/**
 * The media route's in-process cache of hot objects (ADR-840, plan review 86 MINOR 6 and 7): least recently used first
 * out, 32 MB in all, entries up to 4 MB, each kept at most 60 s. The worker evicts the keys it deletes on this replica;
 * on another replica an erased photo's bytes live here at most 60 s more (docs/SECURITY.md, erasure notes), and no
 * reader signs a link for a key that no longer exists.
 */
export const CACHE_BYTES = 32 * 1024 * 1024;
export const CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
export const CACHE_LIFE_MS = 60_000;

type Entry = Readonly<{ blob: StoredBlob; until: number }>;

export type MediaCache = Readonly<{
  get: (key: string) => StoredBlob | undefined;
  set: (key: string, blob: StoredBlob) => void;
  evict: (keys: readonly string[]) => void;
  /** Bytes held now (for tests). */
  size: () => number;
}>;

export function createMediaCache(
  options: Readonly<{ maxBytes?: number; lifeMs?: number; now?: () => number }> = {},
): MediaCache {
  const maxBytes = options.maxBytes ?? CACHE_BYTES;
  const lifeMs = options.lifeMs ?? CACHE_LIFE_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let held = 0;

  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (entry === undefined) return;
    entries.delete(key);
    held -= entry.blob.bytes;
  };

  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      drop(key);
      if (entry.until <= now()) return undefined;
      // Back in at the newest end: a Map keeps insertion order, so the first key is the least recently used.
      entries.set(key, entry);
      held += entry.blob.bytes;
      return entry.blob;
    },
    set: (key, blob) => {
      if (blob.bytes > CACHE_ENTRY_BYTES || blob.bytes > maxBytes) return;
      drop(key);
      while (held + blob.bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      entries.set(key, { blob, until: now() + lifeMs });
      held += blob.bytes;
    },
    evict: (keys) => {
      for (const key of keys) drop(key);
    },
    size: () => held,
  };
}
