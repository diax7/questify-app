import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { ObjectStore } from "#src/storage/client";
import { StorageError } from "#src/storage/client";
import { trackRun } from "#src/telemetry/runs";

/** Keys claimed per round, and rounds per run: at most 500 deletes a run, the rest waits for the next. */
const CLAIM_SIZE = 50;
const ROUNDS_PER_RUN = 10;
const PURGE_BATCH = 500;
const JITTER = 0.2;
/**
 * A claim's lease is 5 minutes (0192 `media_delete_claim`) and one key's delete can take ~31 s (three 10 s attempts
 * plus back-off), so a round starts no delete after 4 minutes: the last one and the done call end inside the lease, so
 * no second replica claims a key while this one is still calling the bucket. Keys not started keep their lease and come
 * back once it ends.
 */
const LEASE_MS = 5 * 60_000;
export const KEY_WORST_MS = 31_000;
/** Kept after the last delete for the done call and for clocks that drift between replicas. */
const DONE_SLACK_MS = 29_000;
export const ROUND_BUDGET_MS = LEASE_MS - KEY_WORST_MS - DONE_SLACK_MS;

export type MediaWorkerDeps = Readonly<{
  pool: Pool;
  store: ObjectStore;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  random?: () => number;
  /** Milliseconds clock for the round's lease budget (for tests). */
  now?: () => number;
}>;

export type MediaTotals = Readonly<{
  swept: number;
  purged: number;
  deleted: number;
  failed: number;
}>;

export type MediaWorker = Readonly<{
  stop: () => Promise<void>;
  /** One run now (for tests). */
  runOnce: () => Promise<MediaTotals>;
}>;

/** `claim` is the claim's token: done and failed touch only rows this claim still holds. */
type Claimed = Readonly<{ id: string; key: string; claim: string }>;

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

const scalar = (pool: Pool, sql: string, values: unknown[] = []): Promise<number> =>
  system(pool, async (client) => {
    const { rows } = await client.query<{ n: number }>(sql, values);
    return rows[0]?.n ?? 0;
  });

/** The failure's short code for the queue row: the status, `timeout` or `network`; never a key or a message. */
const codeOf = (error: unknown): string =>
  error instanceof StorageError
    ? error.code === "status"
      ? `status_${error.status ?? 0}`
      : error.code
    : "error";

/** Claims up to one round of keys; the claim commits before any bucket call. */
const claimRound = (pool: Pool): Promise<Claimed[]> =>
  system(pool, async (client) => {
    const { rows } = await client.query<Claimed>("SELECT * FROM media_delete_claim($1)", [
      CLAIM_SIZE,
    ]);
    return rows;
  });

/** Deletes one key; a failure is recorded on its row (backed off) and answers false. */
async function deleteOne(deps: MediaWorkerDeps, row: Claimed): Promise<boolean> {
  try {
    await deps.store.delete(row.key);
    return true;
  } catch (error) {
    await system(deps.pool, (client) =>
      client.query("SELECT media_delete_failed($1, $2, $3)", [row.id, codeOf(error), row.claim]),
    );
    return false;
  }
}

/** Marks the deleted keys done, under the round's claim token. */
async function markDone(pool: Pool, claimed: readonly Claimed[], done: readonly string[]) {
  const token = claimed[0]?.claim;
  if (done.length > 0 && token !== undefined) {
    await scalar(pool, "SELECT media_delete_done($1::bigint[], $2) AS n", [done, token]);
  }
}

/**
 * Deletes one round of claimed keys. The claim is its own transaction and has committed before the first delete, so a
 * key is leased to this worker alone while the bucket is called, and no transaction stays open across an outside call.
 */
async function deleteRound(
  deps: MediaWorkerDeps,
): Promise<{ deleted: number; failed: number; more: boolean }> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const claimed = await claimRound(deps.pool);
  const done: string[] = [];
  let failed = 0;
  let cut = false;
  for (const row of claimed) {
    if (now() - startedAt >= ROUND_BUDGET_MS) {
      cut = true;
      break;
    }
    if (await deleteOne(deps, row)) {
      done.push(row.id);
    } else {
      failed += 1;
    }
  }
  await markDone(deps.pool, claimed, done);
  // A round cut short ends the run: the bucket is slow, and the next run comes soon enough.
  return { deleted: done.length, failed, more: !cut && claimed.length === CLAIM_SIZE };
}

/**
 * The media worker (T-301b): every run sweeps uploads never attached after 30 minutes, purges what is due (365 days
 * after an event ends, Q-075), and deletes the queued keys from the bucket. A 404 is a delete done; a failure keeps the
 * row and backs off (1 minute to 1 hour). Logs carry counts and codes, never a key.
 */
export function startMediaWorker(deps: MediaWorkerDeps): MediaWorker {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;
  const halted = () => stopped;

  const run = async (): Promise<MediaTotals> => {
    // Player uploads never attached, then organizer images nothing names any more (ADR-829 (3)).
    const swept =
      (await scalar(deps.pool, "SELECT media_sweep_uploads() AS n")) +
      (await scalar(deps.pool, "SELECT media_sweep_images($1) AS n", [PURGE_BATCH]));
    const purged = await scalar(deps.pool, "SELECT media_purge_due($1) AS n", [PURGE_BATCH]);
    let deleted = 0;
    let failed = 0;
    for (let round = 0; round < ROUNDS_PER_RUN && !halted(); round += 1) {
      const result = await deleteRound(deps);
      deleted += result.deleted;
      failed += result.failed;
      if (!result.more) break;
    }
    return { swept, purged, deleted, failed };
  };

  const guarded = async (): Promise<void> => {
    try {
      const totals = await run();
      if (totals.deleted + totals.failed + totals.swept + totals.purged > 0) {
        deps.log(totals.failed > 0 ? "error" : "info", { event: "media.run", ...totals });
      }
    } catch (error) {
      deps.log("error", {
        event: "media.run_failed",
        code: (error as { code?: unknown }).code ?? null,
      });
    }
  };

  const schedule = (): void => {
    const wait = Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(() => {
      running = trackRun("media", guarded).finally(() => {
        running = undefined;
        if (!stopped) schedule();
      });
    }, wait);
    timer.unref();
  };

  schedule();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    runOnce: run,
  };
}
