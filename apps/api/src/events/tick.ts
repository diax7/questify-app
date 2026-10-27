import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { closeDueRounds } from "#src/plays/games";
import { finishDueQuizzes } from "#src/plays/quizzes";
import { wipeDueRehearsals } from "#src/rehearsal/service";
import { expireReservations } from "#src/rewards/shop";
import { purgeEndedTickets } from "#src/tickets/tickets";

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

/** One step of a run: what it logs when it fails, what it logs with its count when it did something, and the work. */
type Step = Readonly<{ failed: string; done: string; work: (pool: Pool) => Promise<number> }>;

/** One call of a database function in its own transaction with no context; answers the count it returns. */
const counted =
  (sql: string) =>
  (pool: Pool): Promise<number> =>
    withConnection(pool, (client) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ count: number }>(sql);
        return rows[0]?.count ?? 0;
      }),
    );

/**
 * A run's steps, in order. The lifecycle moves events by time (FR-1608); the go-live wipe of rehearsal data follows the
 * events that went live (ADR-160); reservations whose pickup time passed are returned (FR-508); quizzes left open past
 * their close pay what they earned (ADR-193); mini-game rounds past their window count as played (ADR-213); help-desk
 * tickets go 90 days after the later of their event's end and their sending (Q-210); last, ended events whose holds,
 * tickets and results are settled are archived (T-411, ADR-337 (5)), after the steps that settle them.
 */
const STEPS: readonly Step[] = [
  {
    failed: "event.lifecycle_failed",
    done: "event.lifecycle_moved",
    work: counted("SELECT advance_event_lifecycle() AS count"),
  },
  {
    failed: "event.rehearsal_wipe_failed",
    done: "event.rehearsals_wiped",
    work: wipeDueRehearsals,
  },
  { failed: "reward.expiry_failed", done: "reward.reservations_expired", work: expireReservations },
  {
    failed: "quiz.sweep_failed",
    done: "quiz.attempts_finished",
    work: (pool) => finishDueQuizzes({ pool }),
  },
  {
    failed: "game.sweep_failed",
    done: "game.rounds_closed",
    work: (pool) => closeDueRounds({ pool }),
  },
  {
    failed: "ticket.purge_failed",
    done: "ticket.purged",
    work: (pool) => purgeEndedTickets({ pool }),
  },
  {
    failed: "event.archive_failed",
    done: "event.archived",
    work: counted("SELECT archive_ended_events() AS count"),
  },
];

/**
 * Runs the lifecycle steps every interval, each in its own transactions with no organizer context. A step's failure is
 * logged by name and SQLSTATE (no personal data) and never stops the others or the server; the next run tries again.
 * Several instances running at once are harmless: every step is row-locked and idempotent.
 */
export function startLifecycleTick(deps: LifecycleTickDeps): LifecycleTick {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const run = async (): Promise<void> => {
    for (const step of STEPS) {
      try {
        const count = await step.work(deps.pool);
        if (count > 0) {
          deps.log("info", { event: step.done, count });
        }
      } catch (error) {
        deps.log("error", {
          event: step.failed,
          reason: error instanceof Error ? error.name : "unknown",
          code: (error as { code?: unknown } | undefined)?.code ?? null,
        });
      }
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
