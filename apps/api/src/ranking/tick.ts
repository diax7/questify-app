import type { Ranking } from "#src/ranking/ranking";

export type RankingTick = Readonly<{
  /** Stops the timer and waits for a run in progress. */
  stop: () => Promise<void>;
}>;

/**
 * Repairs rankings on a timer (T-106): each run rebuilds the events marked in PostgreSQL and, every few minutes, every
 * live event whose copy has aged. Runs never overlap; a failure is logged and the next run tries again.
 */
export function startRankingTick(
  ranking: Ranking,
  intervalMs: number,
  log: (fields: Record<string, unknown>) => void,
): RankingTick {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const schedule = (): void => {
    timer = setTimeout(() => {
      running = ranking
        .repairDue()
        .catch((error: unknown) => {
          log({
            event: "ranking.repair_failed",
            reason: error instanceof Error ? error.name : "unknown",
          });
        })
        .finally(() => {
          running = undefined;
          if (!stopped) {
            schedule();
          }
        });
    }, intervalMs);
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
