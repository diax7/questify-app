import type { Pool, PoolClient } from "pg";
import { communityPlatformOn } from "#src/community/goals";
import { payBatches } from "#src/community/payer";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SettingsService } from "#src/settings/service";

/** How long one tick pays before it leaves the rest to the next (ADR-223, Q-187). */
export const COMMUNITY_PAY_BUDGET_MS = 2000;
/** Each wait is the interval, give or take a fifth, so instances started together drift apart. */
const JITTER = 0.2;

export type CommunityTickDeps = Readonly<{
  pool: Pool;
  settings: Pick<SettingsService, "forEvent">;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  /** Spreads several API instances apart; replaced in tests. */
  random?: () => number;
  /** The clock the pay budget reads; replaced in tests. */
  now?: () => number;
}>;

export type CommunityTick = Readonly<{
  /** Stops the timer and waits for a run in progress. */
  stop: () => Promise<void>;
}>;

type Health = Readonly<{
  behind: readonly string[];
  stuckSteps: number;
  stuckRows: number;
  blocker: Readonly<{ pid: number; app: string }> | null;
}>;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code ?? null;

/**
 * The community tick (ADR-222, ADR-223): every interval it settles each goal with work, one transaction each in the
 * system context (`settle_goal`, SKIP LOCKED, so several instances are harmless), then pays due rewards for up to 2 s,
 * then reads the health and logs what is behind. Logs carry ids, counts and SQLSTATEs only, never personal data. A
 * failure is logged and the next run tries again; it never stops the server.
 */
export function startCommunityTick(deps: CommunityTickDeps): CommunityTick {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const system = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
    withConnection(deps.pool, (client) => withRequestContext(client, {}, () => work(client)));

  const settleOne = async (goal: string, mayStart: boolean): Promise<void> => {
    try {
      await system(async (client) => {
        await client.query("SELECT settle_goal($1, $2)", [goal, mayStart]);
      });
    } catch (error) {
      const blind = codeOf(error) === "CV500";
      deps.log("error", {
        event: blind ? "community.settle_blind" : "community.settle_failed",
        goal,
        code: codeOf(error),
      });
    }
  };

  const settleAll = async (): Promise<void> => {
    const mayStart = await communityPlatformOn(deps.settings);
    const goals = await system(async (client) => {
      const { rows } = await client.query<{ goal: string }>(
        "SELECT g AS goal FROM community_tick_goals() g",
      );
      return rows.map((row) => row.goal);
    });
    for (const goal of goals) {
      await settleOne(goal, mayStart);
    }
  };

  const pay = async (): Promise<void> => {
    const totals = await payBatches(deps.pool, {
      budgetMs: COMMUNITY_PAY_BUDGET_MS,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    if (totals.batches > 0) {
      deps.log("info", { event: "community.paid", paid: totals.paid, skipped: totals.skipped });
    }
  };

  const health = async (): Promise<void> => {
    const state = await system(async (client) => {
      const { rows } = await client.query<{ health: Health }>(
        "SELECT community_health() AS health",
      );
      return rows[0]?.health;
    });
    if (state === undefined) {
      return;
    }
    if (state.behind.length > 0) {
      deps.log("error", {
        event: "community.settle_behind",
        goals: state.behind,
        blockerPid: state.blocker?.pid ?? null,
        blockerApp: state.blocker?.app ?? null,
      });
    }
    if (state.stuckRows > 0) {
      deps.log("error", {
        event: "community.payout_stuck",
        steps: state.stuckSteps,
        rows: state.stuckRows,
      });
    }
  };

  /** One step of a run: its failure is logged by name and SQLSTATE and never stops the others. */
  const step = async (failed: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      deps.log("error", { event: failed, code: codeOf(error) });
    }
  };

  const run = async (): Promise<void> => {
    await step("community.tick_failed", settleAll);
    await step("community.pay_failed", pay);
    await step("community.health_failed", health);
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
