import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLifecycleTick } from "#src/events/tick";

type Logged = { level: string; fields: Record<string, unknown> };

/**
 * A pool whose connection answers the tick's statements; `moved` is what the lifecycle call returns, `expiry` what each
 * call returning a reservation does (nothing due by default).
 */
function fakePool(moved: () => number | Error, expiry: () => string | null | Error = () => null) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("advance_event_lifecycle")) {
        const result = moved();
        if (result instanceof Error) {
          throw result;
        }
        return { rows: [{ moved: result }] };
      }
      if (sql.includes("expire_one_reservation")) {
        const outcome = expiry();
        if (outcome instanceof Error) {
          throw outcome;
        }
        return { rows: [{ outcome }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, client };
}

const start = (pool: Pool, logged: Logged[], random = () => 0.5) =>
  startLifecycleTick({
    pool,
    intervalMs: 1000,
    random,
    log: (level, fields) => logged.push({ level, fields }),
  });

describe("startLifecycleTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the lifecycle once per interval in a transaction, and logs only when events moved", async () => {
    const counts = [0, 3];
    const { pool, statements } = fakePool(() => counts.shift() ?? 0);
    const logged: Logged[] = [];
    const tick = start(pool, logged);
    await vi.advanceTimersByTimeAsync(999);
    expect(statements).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(statements.filter((sql) => sql.includes("advance_event_lifecycle"))).toHaveLength(1);
    expect(statements).toContain("BEGIN");
    expect(logged).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      { level: "info", fields: { event: "event.lifecycle_moved", count: 3 } },
    ]);
    await tick.stop();
  });

  it("spreads its waits by a fifth either way", async () => {
    for (const [random, first] of [
      [0, 800],
      [0.999_999, 1200],
    ] as const) {
      const { pool, statements } = fakePool(() => 0);
      const tick = start(pool, [], () => random);
      await vi.advanceTimersByTimeAsync(first - 1);
      expect(statements).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(statements.length).toBeGreaterThan(0);
      await tick.stop();
    }
  });

  it("logs a failure by its name only and keeps going", async () => {
    const failure = Object.assign(new Error("secret detail"), {
      name: "DatabaseError",
      code: "55P03",
    });
    const results: (number | Error)[] = [failure, 1];
    const { pool } = fakePool(() => results.shift() ?? 0);
    const logged: Logged[] = [];
    const tick = start(pool, logged);
    await vi.advanceTimersByTimeAsync(2000);
    expect(logged).toEqual([
      {
        level: "error",
        fields: { event: "event.lifecycle_failed", reason: "DatabaseError", code: "55P03" },
      },
      { level: "info", fields: { event: "event.lifecycle_moved", count: 1 } },
    ]);
    await tick.stop();
  });

  it("names a thrown non-error as unknown", async () => {
    const pool = {
      connect: async () => {
        throw "down";
      },
    } as unknown as Pool;
    const logged: Logged[] = [];
    const tick = start(pool, logged);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      {
        level: "error",
        fields: { event: "event.lifecycle_failed", reason: "unknown", code: null },
      },
      { level: "error", fields: { event: "reward.expiry_failed", reason: "unknown", code: null } },
    ]);
    await tick.stop();
  });

  it("never runs when stopped before its first turn", async () => {
    const { pool, statements } = fakePool(() => 0);
    const tick = start(pool, []);
    await tick.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statements).toEqual([]);
  });

  it("waits for a run in progress on stop, and schedules none after it", async () => {
    let connects = 0;
    let finish: (() => void) | undefined;
    const { pool } = fakePool(() => 0);
    const slowPool = {
      connect: async () => {
        connects += 1;
        if (connects === 1) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return pool.connect();
      },
    } as unknown as Pool;
    const tick = start(slowPool, []);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connects).toBe(1);
    let stopped = false;
    const stopping = tick.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    // The lifecycle call and one look for due reservations; nothing after the stop.
    expect(connects).toBe(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(connects).toBe(2);
  });

  it("returns due reservations one call at a time, and logs only the count", async () => {
    const outcomes: (string | null)[] = ["expired", "skipped", "expired", null];
    const { pool, statements } = fakePool(
      () => 0,
      () => outcomes.shift() ?? null,
    );
    const logged: Logged[] = [];
    const tick = start(pool, logged);
    await vi.advanceTimersByTimeAsync(1000);
    expect(statements.filter((sql) => sql.includes("expire_one_reservation"))).toHaveLength(4);
    expect(logged).toEqual([
      { level: "info", fields: { event: "reward.reservations_expired", count: 2 } },
    ]);
    await tick.stop();
  });

  it("stops returning reservations after a batch, and keeps the lifecycle going when returning fails", async () => {
    const { pool, statements } = fakePool(
      () => 0,
      () => "expired",
    );
    const tick = start(pool, []);
    await vi.advanceTimersByTimeAsync(1000);
    expect(statements.filter((sql) => sql.includes("expire_one_reservation"))).toHaveLength(200);
    await tick.stop();
    const failing = fakePool(
      () => 1,
      () => Object.assign(new Error("x"), { name: "DatabaseError", code: "40P01" }),
    );
    const logged: Logged[] = [];
    const second = start(failing.pool, logged);
    await vi.advanceTimersByTimeAsync(1000);
    expect(logged).toEqual([
      { level: "info", fields: { event: "event.lifecycle_moved", count: 1 } },
      {
        level: "error",
        fields: { event: "reward.expiry_failed", reason: "DatabaseError", code: "40P01" },
      },
    ]);
    await second.stop();
  });
});
