import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { finishDueQuizzes } from "#src/plays/quizzes";
import { wipeDueRehearsals } from "#src/rehearsal/service";
import { expireReservations } from "#src/rewards/shop";

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
 * its own transaction, with no organizer context; then wipes the rehearsals that went live (ADR-160), then returns the
 * reservations whose pickup time passed (FR-508), then finishes the quizzes left open past their close (ADR-193). A
 * failure is logged and the next run tries again; it never stops the server. Several instances calling at once are harmless: the updates are row-locked and idempotent.
 */
export function startLifecycleTick(deps: LifecycleTickDeps): LifecycleTick {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  /** One step of a run: its failure is logged by name and SQLSTATE (no personal data) and never stops the others. */
  const step = async (failed: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      deps.log("error", {
        event: failed,
        reason: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: unknown } | undefined)?.code ?? null,
      });
    }
  };

  const run = async (): Promise<void> => {
    await step("event.lifecycle_failed", async () => {
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
    });
    // The go-live wipe of rehearsal data (ADR-160): one event per transaction, after the events moved to live.
    await step("event.rehearsal_wipe_failed", async () => {
      const wiped = await wipeDueRehearsals(deps.pool);
      if (wiped > 0) {
        deps.log("info", { event: "event.rehearsals_wiped", count: wiped });
      }
    });
    await step("reward.expiry_failed", async () => {
      const returned = await expireReservations(deps.pool);
      if (returned > 0) {
        deps.log("info", { event: "reward.reservations_expired", count: returned });
      }
    });
    // Quizzes left open past their close pay what they earned (ADR-193).
    await step("quiz.sweep_failed", async () => {
      const finished = await finishDueQuizzes({ pool: deps.pool });
      if (finished > 0) {
        deps.log("info", { event: "quiz.attempts_finished", count: finished });
      }
    });
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
