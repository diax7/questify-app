import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

export type LifecycleTickDeps = Readonly<{
  pool: Pool;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  /** Spreads several API instances apart; replaced in tests. */
  random?: () => number;
}>;

export type LifecycleTick = Readonly<{
  /** Stops the timer and waits for a run in progress. */
  stop: () => Promise<void>;
}>;

/** Each wait is the interval, give or take a fifth, so instances started together drift apart. */
const JITTER = 0.2;

/**
 * Moves events through their lifecycle on time (FR-1608): every interval, one call to `advance_event_lifecycle()` in
 * its own transaction, with no organizer context. A failure is logged and the next run tries again; it never stops
 * the server. Several instances calling at once are harmless: the updates are row-locked and idempotent.
 */
export function startLifecycleTick(deps: LifecycleTickDeps): LifecycleTick {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const run = async (): Promise<void> => {
    try {
      const moved = await withConnection(deps.pool, (client) =>
        withRequestContext(client, {}, async () => {
          const { rows } = await client.query<{ moved: number }>(
            "SELECT advance_event_lifecycle() AS moved",
          );
          return rows[0]?.moved ?? 0;
        }),
      );
      if (moved > 0) {
        deps.log("info", { event: "event.lifecycle_moved", count: moved });
      }
    } catch (error) {
      deps.log("error", {
        event: "event.lifecycle_failed",
        reason: error instanceof Error ? error.name : "unknown",
        // The SQLSTATE says which failure (a lock timeout, a lost connection) and holds no personal data.
        code: (error as { code?: unknown } | undefined)?.code ?? null,
      });
    }
  };

  const schedule = (): void => {
    const wait = Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(() => {
      running = run().finally(() => {
        running = undefined;
        if (!stopped) {
          schedule();
        }
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
  };
}
