import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RANK_PUSH_BUDGET_MS, startRankPushTick } from "#src/ranking/top-ten-tick";
import { fakePool, pgError } from "#test/support/fake-pool";

type Logged = { level: string; fields: Record<string, unknown> };

const EVENTS = ["e1", "e2", "e3"];

/** A pool answering the tick's two statements: the list of live events and each event's diff. */
function scripted(diffs: (event: string) => unknown, live: readonly string[] = EVENTS) {
  const asked: string[] = [];
  const fake = fakePool((sql, values) => {
    if (sql.includes("rank_push_events")) {
      return { rows: live.map((rank_push_events) => ({ rank_push_events })) };
    }
    const event = String(values[0]);
    asked.push(event);
    const answer = diffs(event);
    if (answer instanceof Error) throw answer;
    return { rows: [{ r: answer }] };
  });
  return { ...fake, asked };
}

const start = (
  pool: ReturnType<typeof scripted>["pool"],
  logged: Logged[],
  options: Readonly<{ now?: () => number }> = {},
) =>
  startRankPushTick({
    pool,
    intervalMs: 1000,
    log: (level, fields) => logged.push({ level, fields }),
    random: () => 0.5,
    ...options,
  });

describe("the top-10 rank push tick (ADR-362)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("diffs every live event once a run, counting the notices and the events another instance held", async () => {
    const { pool, asked } = scripted((event) =>
      event === "e3" ? { state: "busy" } : { state: "diffed", notices: event === "e1" ? 2 : 0 },
    );
    const tick = start(pool, []);
    expect(await tick.runOnce()).toEqual({ events: 3, notices: 2, busy: 1 });
    expect(asked).toEqual(EVENTS);
    await tick.stop();
  });

  it("logs a failed event by its SQLSTATE and goes on with the others", async () => {
    const logged: Logged[] = [];
    const { pool, asked } = scripted((event) =>
      event === "e1" ? pgError({ code: "PN403" }) : { state: "baseline" },
    );
    const tick = start(pool, logged);
    expect(await tick.runOnce()).toEqual({ events: 2, notices: 0, busy: 0 });
    expect(asked).toEqual(EVENTS);
    expect(logged).toEqual([
      { level: "error", fields: { event: "ranking.push_diff_failed", code: "PN403" } },
    ]);
    await tick.stop();
  });

  it("stops starting events once its time budget is spent, leaving the rest to the next run", async () => {
    let clock = 0;
    const { pool, asked } = scripted((event) => {
      clock += RANK_PUSH_BUDGET_MS / 2;
      return { state: "diffed", notices: event === "e1" ? 1 : 0 };
    });
    const tick = start(pool, [], { now: () => clock });
    expect(await tick.runOnce()).toEqual({ events: 2, notices: 1, busy: 0 });
    expect(asked).toEqual(["e1", "e2"]);
    await tick.stop();
  });

  it("runs on its interval, never two at once, and logs a run that fails as a whole", async () => {
    const logged: Logged[] = [];
    let lists = 0;
    let finish: (() => void) | undefined;
    const fake = fakePool((sql) => {
      if (sql.includes("rank_push_events")) {
        lists += 1;
        if (lists === 3) throw pgError({ code: "57014" });
        return { rows: [] };
      }
      return { rows: [] };
    });
    const slow = {
      ...fake.pool,
      connect: async () => {
        if (lists === 0) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return fake.pool.connect();
      },
    } as typeof fake.pool;
    const tick = start(slow, logged);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists).toBe(0);
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lists).toBe(3);
    expect(logged).toEqual([
      { level: "error", fields: { event: "ranking.push_tick_failed", code: "57014" } },
    ]);
    await tick.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lists).toBe(3);
  });
});
