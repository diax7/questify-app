import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCommunityTick } from "#src/community/tick";

type Logged = { level: string; fields: Record<string, unknown> };
type Script = {
  goals: string[];
  settle: (goal: string) => Error | null;
  batches: number;
  /** null: the health read answers no row. */
  health: Record<string, unknown> | null;
};

const pgError = (code: string) => Object.assign(new Error("database refused"), { code });

/** A pool whose connection answers the tick's statements from `script`, recording each statement and its values. */
function fakePool(script: Script) {
  const statements: { sql: string; values: unknown[] }[] = [];
  let paid = 0;
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (sql.includes("community_tick_goals")) {
        return { rows: script.goals.map((goal) => ({ goal })) };
      }
      if (sql.includes("settle_goal")) {
        const failure = script.settle(String(values[0]));
        if (failure !== null) {
          throw failure;
        }
        return { rows: [{ settle_goal: "running" }] };
      }
      if (sql.includes("pay_community_batch")) {
        paid += 1;
        return { rows: paid <= script.batches ? [{ step_id: "s", paid: 500, skipped: 2 }] : [] };
      }
      if (sql.includes("community_health")) {
        return { rows: script.health === null ? [] : [{ health: script.health }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const healthy = { behind: [], stuckSteps: 0, stuckRows: 0, blocker: null };
const settingsWith = (enabled: boolean | undefined) => ({
  forEvent: vi.fn(async () => ({
    kind: "ok" as const,
    config: { features: enabled === undefined ? {} : { community: { enabled } } },
  })),
});

function start(
  script: Partial<Script>,
  logged: Logged[],
  options: Readonly<{ enabled?: boolean; random?: () => number; now?: () => number }> = {},
) {
  const fake = fakePool({
    goals: [],
    settle: () => null,
    batches: 0,
    health: healthy,
    ...script,
  });
  const tick = startCommunityTick({
    pool: fake.pool,
    settings: settingsWith(options.enabled) as never,
    intervalMs: 1000,
    random: options.random ?? (() => 0.5),
    ...(options.now === undefined ? {} : { now: options.now }),
    log: (level, fields) => logged.push({ level, fields }),
  });
  return { tick, statements: fake.statements };
}

describe("startCommunityTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles each goal in its own system transaction, with the platform switch as may_start", async () => {
    const logged: Logged[] = [];
    const { tick, statements } = start({ goals: ["g1", "g2"] }, logged, { enabled: false });
    await vi.advanceTimersByTimeAsync(999);
    expect(statements).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const settles = statements.filter((one) => one.sql.includes("settle_goal"));
    expect(settles.map((one) => one.values)).toEqual([
      ["g1", false],
      ["g2", false],
    ]);
    expect(statements.filter((one) => one.sql === "BEGIN").length).toBeGreaterThanOrEqual(4);
    expect(logged).toEqual([]);
    await tick.stop();
  });

  it("spreads its runs by a fifth either way", async () => {
    const logged: Logged[] = [];
    const { tick, statements } = start({}, logged, { random: () => 0 });
    await vi.advanceTimersByTimeAsync(799);
    expect(statements).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(statements.some((one) => one.sql.includes("community_tick_goals"))).toBe(true);
    await tick.stop();
    const late = start({}, [], { random: () => 1 });
    await vi.advanceTimersByTimeAsync(1199);
    expect(late.statements).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.statements.length).toBeGreaterThan(0);
    await late.tick.stop();
  });

  it("logs an unreadable session as settle_blind and any other failure by its code, and goes on", async () => {
    const logged: Logged[] = [];
    const { tick, statements } = start(
      {
        goals: ["blind", "broken", "fine"],
        settle: (goal) =>
          goal === "blind" ? pgError("CV500") : goal === "broken" ? pgError("57014") : null,
      },
      logged,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      { level: "error", fields: { event: "community.settle_blind", goal: "blind", code: "CV500" } },
      {
        level: "error",
        fields: { event: "community.settle_failed", goal: "broken", code: "57014" },
      },
    ]);
    expect(statements.some((one) => one.values[0] === "fine")).toBe(true);
    await tick.stop();
  });

  it("pays batches until none is due or 2 s are spent, and logs only counts", async () => {
    const logged: Logged[] = [];
    const { tick } = start({ batches: 3 }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      { level: "info", fields: { event: "community.paid", paid: 1500, skipped: 6 } },
    ]);
    await tick.stop();
    let clock = 0;
    const budget: Logged[] = [];
    const slow = start({ batches: 100 }, budget, {
      now: () => {
        clock += 700;
        return clock;
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(budget[0]?.fields).toMatchObject({ event: "community.paid", paid: 1000 });
    await slow.tick.stop();
  });

  it("logs goals behind with the blocking backend, and stuck payouts, by ids and counts only", async () => {
    const logged: Logged[] = [];
    const { tick } = start(
      {
        health: {
          behind: ["g1"],
          stuckSteps: 2,
          stuckRows: 40,
          blocker: { pid: 4242, app: "pg_dump" },
        },
      },
      logged,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      {
        level: "error",
        fields: {
          event: "community.settle_behind",
          goals: ["g1"],
          blockerPid: 4242,
          blockerApp: "pg_dump",
        },
      },
      { level: "error", fields: { event: "community.payout_stuck", steps: 2, rows: 40 } },
    ]);
    await tick.stop();
  });

  it("logs a failed listing, payment or health read by its code and runs again next time", async () => {
    const logged: Logged[] = [];
    const failing = {
      connect: async () => ({
        query: vi.fn(async (sql: string) => {
          if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("set_config")) {
            return { rows: [] };
          }
          throw pgError("40P01");
        }),
        release: vi.fn(),
      }),
    } as unknown as Pool;
    const tick = startCommunityTick({
      pool: failing,
      settings: settingsWith(true) as never,
      intervalMs: 1000,
      random: () => 0.5,
      log: (level, fields) => logged.push({ level, fields }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged.map((one) => one.level)).toEqual(["error", "error", "error"]);
    expect(logged.map((one) => one.fields)).toEqual([
      { event: "community.tick_failed", code: "40P01" },
      { event: "community.pay_failed", code: "40P01" },
      { event: "community.health_failed", code: "40P01" },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toHaveLength(6);
    await tick.stop();
  });

  it("logs a goal behind with no blocking backend as null, and nothing when the health read has no row", async () => {
    const logged: Logged[] = [];
    const { tick } = start({ health: { ...healthy, behind: ["g1"] } }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      {
        level: "error",
        fields: {
          event: "community.settle_behind",
          goals: ["g1"],
          blockerPid: null,
          blockerApp: null,
        },
      },
    ]);
    await tick.stop();
    const quiet: Logged[] = [];
    const empty = start({ health: null }, quiet);
    await vi.advanceTimersByTimeAsync(1000);
    expect(quiet).toEqual([]);
    await empty.tick.stop();
  });

  it("logs a failure that carries no code as code null", async () => {
    const logged: Logged[] = [];
    const tick = startCommunityTick({
      pool: {
        connect: async () => ({
          query: vi.fn(async (sql: string) => {
            if (sql.includes("community_health")) {
              throw undefined;
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        }),
      } as unknown as Pool,
      settings: settingsWith(true) as never,
      intervalMs: 1000,
      random: () => 0.5,
      log: (level, fields) => logged.push({ level, fields }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      { level: "error", fields: { event: "community.health_failed", code: null } },
    ]);
    await tick.stop();
  });

  it("stopped during a run, waits for it and schedules none after it", async () => {
    const gate: { open?: () => void } = {};
    const held = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const listings: string[] = [];
    const tick = startCommunityTick({
      pool: {
        connect: async () => ({
          query: vi.fn(async (sql: string) => {
            if (sql.includes("community_tick_goals")) {
              listings.push(sql);
              return { rows: [{ goal: "g1" }] };
            }
            if (sql.includes("settle_goal")) {
              await held;
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        }),
      } as unknown as Pool,
      settings: settingsWith(true) as never,
      intervalMs: 1000,
      random: () => 0.5,
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(listings).toHaveLength(1);
    let stopped = false;
    const stopping = tick.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    gate.open?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(listings).toHaveLength(1);
  });

  it("does not keep the process alive between runs", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const { tick } = start({}, []);
    const timer = timeout.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    timeout.mockRestore();
    await tick.stop();
  });

  it("stops: waits for a run in progress and schedules no more", async () => {
    const logged: Logged[] = [];
    const { tick, statements } = start({ goals: ["g1"] }, logged);
    await vi.advanceTimersByTimeAsync(1000);
    const count = statements.length;
    await tick.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statements.length).toBe(count);
  });
});
