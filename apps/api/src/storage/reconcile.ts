import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { ObjectStore } from "#src/storage/client";

/** Keys a page (m0001 `blob_keys_page`, 0200 `media_keys_known`). */
export const RECONCILE_PAGE = 500;
/** Rows younger than this are skipped: their `media_object` row may still be on its way (the write order). */
export const RECONCILE_AGE_MS = 60 * 60_000;
/** The daily run deletes nothing when more keys than `min(1,000, 5 % of the rows scanned)` are unknown (review 86). */
export const RECONCILE_MAX_KEYS = 1000;
export const RECONCILE_SHARE = 0.05;

export const reconcileCap = (scanned: number): number =>
  Math.min(RECONCILE_MAX_KEYS, Math.floor(scanned * RECONCILE_SHARE));

export type ReconcileResult = Readonly<{
  outcome: "done" | "blocked";
  scanned: number;
  unknown: number;
  deleted: number;
}>;

/** A run stopped before any delete: the main database failed or gave an answer that is not one row per key asked. */
export class ReconcileAborted extends Error {
  readonly code: "keys_known_failed" | "odd_answer";

  constructor(code: ReconcileAborted["code"]) {
    super(`media reconcile aborted: ${code}`);
    this.name = "ReconcileAborted";
    this.code = code;
  }
}

export type ReconcileDeps = Readonly<{ pool: Pool; store: ObjectStore; now?: () => number }>;

const asSystem = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/**
 * The main database's verdict on one page, read fail closed (review 86 MAJOR 1): a key is unknown only when the answer
 * says `known = false` for it. An error, a short answer, a key not asked, a key twice or a verdict that is not a boolean
 * aborts the run; nothing is ever read as "unknown" by default.
 */
export async function keysKnown(
  pool: Pool,
  keys: readonly string[],
): Promise<Map<string, boolean>> {
  let rows: ReadonlyArray<{ key: unknown; known: unknown }>;
  try {
    rows = await asSystem(pool, async (client) => {
      const answer = await client.query<{ key: unknown; known: unknown }>(
        "SELECT key, known FROM media_keys_known($1::text[])",
        [keys],
      );
      return answer.rows;
    });
  } catch {
    throw new ReconcileAborted("keys_known_failed");
  }
  return verdictsOf(new Set(keys), rows);
}

/** One verdict per key asked, exactly, or the answer is odd. */
function verdictsOf(
  asked: ReadonlySet<string>,
  rows: ReadonlyArray<{ key: unknown; known: unknown }>,
): Map<string, boolean> {
  const verdicts = new Map<string, boolean>();
  for (const { key, known } of rows) {
    const fits = typeof key === "string" && asked.has(key) && !verdicts.has(key);
    if (!fits || typeof known !== "boolean") break;
    verdicts.set(key, known);
  }
  if (verdicts.size !== asked.size || rows.length !== asked.size) {
    throw new ReconcileAborted("odd_answer");
  }
  return verdicts;
}

type Scan = { scanned: number; unknown: string[]; over: boolean };

/** Pages every byte row older than an hour and collects the keys the main database does not name. */
async function scan(deps: ReconcileDeps, all: boolean): Promise<Scan> {
  const now = deps.now ?? Date.now;
  const olderThan = new Date(now() - RECONCILE_AGE_MS);
  const found: Scan = { scanned: 0, unknown: [], over: false };
  let after: string | null = null;
  for (;;) {
    const page = await deps.store.keysPage(after, olderThan, RECONCILE_PAGE);
    if (page.length === 0) break;
    found.scanned += page.length;
    const verdicts = await keysKnown(deps.pool, page);
    found.unknown.push(...page.filter((key) => verdicts.get(key) === false));
    if (!all && found.unknown.length > RECONCILE_MAX_KEYS) {
      found.over = true;
      break;
    }
    if (page.length < RECONCILE_PAGE) break;
    after = page[page.length - 1] ?? null;
  }
  return found;
}

/**
 * The orphan sweep (ADR-839): deletes the media database's rows, older than an hour, whose key no `media_object` row
 * names any more (a photo deleted while the media database was down, or brought back by a media restore). It collects
 * first and deletes after, and the daily run deletes nothing past the cap (`blocked`), so a stale main restore beside a
 * current media database can never empty it; only an operator's `all` run goes past the cap.
 *
 * @throws ReconcileAborted before any delete, when the main database cannot be trusted for a page.
 */
export async function reconcileMedia(
  deps: ReconcileDeps,
  options: Readonly<{ all?: boolean }> = {},
): Promise<ReconcileResult> {
  const all = options.all === true;
  const found = await scan(deps, all);
  const unknown = found.unknown.length;
  if (!all && (found.over || unknown > reconcileCap(found.scanned))) {
    return { outcome: "blocked", scanned: found.scanned, unknown, deleted: 0 };
  }
  const deleted = unknown === 0 ? 0 : await deps.store.deleteMany(found.unknown);
  return { outcome: "done", scanned: found.scanned, unknown, deleted };
}
