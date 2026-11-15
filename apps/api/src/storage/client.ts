/** The two types the API stores: a JPEG for photos and pictures, a PNG for logos and icons (ADR-829). */
export type StoredType = "image/jpeg" | "image/png";

/** One key's stored bytes, as the media database holds them (ADR-839). */
export type StoredBlob = Readonly<{
  contentType: StoredType;
  bytes: number;
  sha256: Buffer;
  body: Buffer;
}>;

/**
 * The media store the API needs (ADR-839, ADR-840): put a re-encoded image, delete keys, read one key's bytes for the
 * media route, page the keys for the reconcile, and sign or check a short read link. One implementation,
 * `createMediaStore` (media-store.ts), over the media database.
 */
export type ObjectStore = Readonly<{
  /** Stores the key's bytes; the key's extension decides the type. A retried put of the same bytes is done. */
  put: (key: string, body: Buffer) => Promise<void>;
  /** Deletes the keys (a key already gone is fine) and answers how many rows went. */
  deleteMany: (keys: readonly string[]) => Promise<number>;
  /** The key's bytes, or undefined when nothing is stored at it. */
  get: (key: string) => Promise<StoredBlob | undefined>;
  /** Up to `n` keys after `after` (key order) of rows written before `olderThan`. */
  keysPage: (after: string | null, olderThan: Date, n: number) => Promise<string[]>;
  /**
   * A GET link on the media route that works for `ttlSeconds` (at most 300) from `at` (now by default). One key signed
   * at one `at` is one URL, so a reader that floors `at` hands out a stable URL.
   */
  signGet: (key: string, ttlSeconds: number, at?: Date) => SignedUrl;
  /** Whether `expiry` and `signature` (a link's `e` and `s`) open `key` now. */
  checkLink: (key: string, expiry: unknown, signature: unknown) => boolean;
}>;

export type SignedUrl = Readonly<{ url: string; expiresAt: Date }>;

export type StoreOp = "put" | "get" | "delete" | "keys";

/**
 * A media call that did not complete: the database could not be reached or answered an error (`unavailable`), the
 * statement or the connection ran out of time (`timeout`), or the key already holds other bytes (`conflict`, MB409).
 */
export class StorageError extends Error {
  readonly op: StoreOp;
  readonly code: "unavailable" | "timeout" | "conflict";

  constructor(op: StoreOp, code: StorageError["code"]) {
    super(`storage ${op} failed: ${code}`);
    this.name = "StorageError";
    this.op = op;
    this.code = code;
  }
}

export const MAX_SIGNED_SECONDS = 300;

/** The type a key's extension names: `.png` is a PNG, anything else (`.jpg`) a JPEG. */
export const typeOfKey = (key: string): StoredType =>
  key.endsWith(".png") ? "image/png" : "image/jpeg";
