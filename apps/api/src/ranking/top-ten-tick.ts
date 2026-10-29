import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** The most live events one tick looks at; the list is oldest snapshot first, so the rest wait for the next tick. */
const EVENTS_PER_TICK = 1000;
/** One tick stops starting new events after this long, so a crowd of live events never holds the pool. */
export const RANK_PUSH_BUDGET_MS = 5000;
/** Each wait is the interval, give or take a fifth, so instances started together drift apart. */
const JITTER = 0.2;

export type RankPushTickDeps = Readonly<{
  pool: Pool;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  /** Spreads several API instances apart; replaced in tests. */
  random?: () => number;
  /** The clock the budget reads; replaced in tests. */
  now?: () => number;
}>;

export type RankPushTick = Readonly<{
  /** Stops the timer and waits for a run in progress. */
  stop: () => Promise<void>;
  /** One run now (for tests): the events diffed and the notices written. */
  runOnce: () => Promise<RankPushTotals>;
}>;

export type RankPushTotals = Readonly<{ events: number; notices: number; busy: number }>;

type Diff = Readonly<{ state: "busy" | "idle" | "baseline" | "diffed"; notices?: number }>;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code ?? null;

/**
 * The top-10 rank push tick (T-503, ADR-362). Each run lists the live events (`rank_push_events`), then diffs each one in
 * a transaction of its own in the system context (`rank_push_diff`): the database compares the event's current top ten
 * with the stored previous ten and writes one notice per entry and per exit. The database's try-lock on the event makes
 * a second instance skip an event already being diffed, and a run never starts while the last one is still going. One
 * event's failure is logged and the others go on. Logs carry counts and SQLSTATEs only, never a player or a name. The
 * tick reads nothing from the completion path or the ranking cache.
 */
export function startRankPushTick(deps: RankPushTickDeps): RankPushTick {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;

  const system = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
    withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

  const diffOne = async (event: string): Promise<Diff | undefined> => {
    try {
      return await system(async (client) => {
        const { rows } = await client.query<{ r: Diff }>("SELECT rank_push_diff($1) AS r", [event]);
        return rows[0]?.r;
      });
    } catch (error) {
      deps.log("error", { event: "ranking.push_diff_failed", code: codeOf(error) });
      return undefined;
    }
  };

  const run = async (): Promise<RankPushTotals> => {
    const started = now();
    const events = await system(async (client) => {
      const { rows } = await client.query<{ rank_push_events: string }>(
        "SELECT * FROM rank_push_events($1)",
        [EVENTS_PER_TICK],
      );
      return rows.map((row) => row.rank_push_events);
    });
    let diffed = 0;
    let notices = 0;
    let busy = 0;
    for (const event of events) {
      if (now() - started >= RANK_PUSH_BUDGET_MS) break;
      const done = await diffOne(event);
      if (done === undefined) continue;
      diffed += 1;
      notices += done.notices ?? 0;
      if (done.state === "busy") busy += 1;
    }
    return { events: diffed, notices, busy };
  };

  const guarded = async (): Promise<void> => {
    try {
      const totals = await run();
      if (totals.notices > 0) {
        deps.log("info", { event: "ranking.push_diffed", ...totals });
      }
    } catch (error) {
      deps.log("error", { event: "ranking.push_tick_failed", code: codeOf(error) });
    }
  };

  const schedule = (): void => {
    const wait = Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(() => {
      running = guarded().finally(() => {
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
