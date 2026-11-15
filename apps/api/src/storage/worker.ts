import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { ObjectStore } from "#src/storage/client";
import { StorageError } from "#src/storage/client";
import { ReconcileAborted, reconcileMedia, type ReconcileResult } from "#src/storage/reconcile";
import { trackRun } from "#src/telemetry/runs";

/**
 * Keys claimed per round, and rounds per run: at most 500 deletes a run, the rest waits for the next. A round is one
 * `blob_delete` statement (at most 10 s, the media pool's statement timeout), far inside the claim's 5-minute lease
 * (0192 `media_delete_claim`), so no second replica claims a key while this one deletes it.
 */
const CLAIM_SIZE = 50;
const ROUNDS_PER_RUN = 10;
const PURGE_BATCH = 500;
const JITTER = 0.2;

export type MediaWorkerDeps = Readonly<{
  /** The main database (the API's pool): the queue, the sweeps and the reconcile's verdicts. */
  pool: Pool;
  store: ObjectStore;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  random?: () => number;
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

/** The failure's short code for the queue row (`media_unavailable`, `media_timeout`); never a key or a message. */
const codeOf = (error: unknown): string =>
  error instanceof StorageError ? `media_${error.code}` : "error";

/** Claims up to one round of keys; the claim commits before the media database is called. */
const claimRound = (pool: Pool): Promise<Claimed[]> =>
  system(pool, async (client) => {
    const { rows } = await client.query<Claimed>("SELECT * FROM media_delete_claim($1)", [
      CLAIM_SIZE,
    ]);
    return rows;
  });

/** Records the round's failure on each of its rows (backed off 1 minute to 1 hour), under the claim's token. */
const markFailed = (pool: Pool, claimed: readonly Claimed[], code: string) =>
  system(pool, async (client) => {
    for (const row of claimed) {
      await client.query("SELECT media_delete_failed($1, $2, $3)", [row.id, code, row.claim]);
    }
  });

/**
 * Deletes one round of claimed keys with one `deleteMany`. The claim is its own transaction and has committed before the
 * delete, so no transaction stays open across the media database's call; done is marked only after the delete answered.
 * A crash between the two repeats the delete next time, which finds nothing: idempotent.
 */
async function deleteRound(
  deps: MediaWorkerDeps,
): Promise<{ deleted: number; failed: number; more: boolean }> {
  const claimed = await claimRound(deps.pool);
  const token = claimed[0]?.claim;
  if (token === undefined) return { deleted: 0, failed: 0, more: false };
  try {
    await deps.store.deleteMany(claimed.map((row) => row.key));
  } catch (error) {
    await markFailed(deps.pool, claimed, codeOf(error));
    return { deleted: 0, failed: claimed.length, more: false };
  }
  await scalar(deps.pool, "SELECT media_delete_done($1::bigint[], $2) AS n", [
    claimed.map((row) => row.id),
    token,
  ]);
  return { deleted: claimed.length, failed: 0, more: claimed.length === CLAIM_SIZE };
}

/** The daily reconcile, when this replica holds today's claim: its outcome is logged, never a key. */
async function dailyReconcile(deps: MediaWorkerDeps): Promise<void> {
  const claimed = await scalar(deps.pool, "SELECT media_reconcile_claim()::int AS n");
  if (claimed !== 1) return;
  let result: ReconcileResult;
  try {
    result = await reconcileMedia({
      pool: deps.pool,
      store: deps.store,
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    const code = error instanceof ReconcileAborted ? error.code : codeOf(error);
    deps.log("error", { event: "media.reconcile_failed", code });
    return;
  }
  const { outcome, ...counts } = result;
  if (outcome === "blocked") {
    deps.log("error", { event: "media.reconcile_blocked", ...counts });
  } else {
    deps.log("info", { event: "media.reconcile", ...counts });
  }
}

/**
 * The media worker (T-301b, T-814): every run sweeps uploads never attached after 30 minutes, purges what is due (365
 * days after an event ends, Q-075), deletes the queued keys from the media database, and once a day reconciles it. A
 * failure keeps the rows and backs off (1 minute to 1 hour). Logs carry counts and codes, never a key.
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
    if (!halted()) await dailyReconcile(deps);
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
