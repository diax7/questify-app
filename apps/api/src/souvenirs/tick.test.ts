import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSouvenirTick } from "#src/souvenirs/tick";
import { fakePool, pgError } from "#test/support/fake-pool";

type Health = { due: number; failed: number; oldestAt: string | null };
type Script = {
  /** null: the health read answers no row. */
  health?: Health | null;
  /** Enrollments the first claim call hands out; evaluating one of them raises `evaluateError` if set. */
  claims?: number;
  evaluateError?: Error;
  scanError?: Error;
};

const START = new Date("2030-01-01T00:00:00.000Z");
const FIRST_RUN = START.getTime() + 1000;
const quiet: Health = { due: 0, failed: 0, oldestAt: null };
/** An instant `seconds` before the first run, as the database reports it. */
const secondsBefore = (seconds: number) => new Date(FIRST_RUN - seconds * 1000).toISOString();

type Logged = Record<string, unknown>;

function start(script: Script, options: { random?: () => number } = {}) {
  const logged: Logged[] = [];
  const statements: string[] = [];
  let claimCalls = 0;
  const { pool } = fakePool((sql) => {
    statements.push(sql);
    if (sql.includes("souvenir_scan_batch") && script.scanError !== undefined) {
      throw script.scanError;
    }
    if (sql.includes("souvenir_claim_work")) {
      claimCalls += 1;
      const count = claimCalls === 1 ? (script.claims ?? 0) : 0;
      return {
        rows: Array.from({ length: count }, (_, index) => ({
          event_id: "e1",
          enrollment_id: `en${index}`,
          generation: "g",
          lease_token: "l",
        })),
      };
    }
    if (sql.includes("souvenir_evaluate")) {
      if (script.evaluateError !== undefined) throw script.evaluateError;
      return { rows: [{ made: 0 }] };
    }
    if (sql.includes("souvenir_health")) {
      const health = script.health === undefined ? quiet : script.health;
      return { rows: health === null ? [] : [{ health }] };
    }
    return { rows: [] };
  });
  const tick = startSouvenirTick({
    pool,
    intervalMs: 1000,
    log: (fields) => logged.push(fields),
    ...(options.random === undefined ? { random: () => 0.5 } : { random: options.random }),
  });
  return { tick, logged, statements };
}

const scans = (statements: string[]) =>
  statements.filter((sql) => sql.includes("souvenir_scan_batch")).length;

describe("startSouvenirTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("when it runs", () => {
    it("starts a run a fifth early or late, never sooner or later", async () => {
      const early = start({}, { random: () => 0 });
      await vi.advanceTimersByTimeAsync(799);
      expect(early.statements).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(scans(early.statements)).toBe(1);
      await early.tick.stop();

      const late = start({}, { random: () => 1 });
      await vi.advanceTimersByTimeAsync(1199);
      expect(late.statements).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(scans(late.statements)).toBe(1);
      await late.tick.stop();
    });

    it("draws the spread from the random source it was given, not from Math.random", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      const { tick, statements } = start({}, { random: () => 0 });
      await vi.advanceTimersByTimeAsync(800);
      expect(scans(statements)).toBe(1);
      await tick.stop();
    });

    it("falls back to Math.random when none was given", async () => {
      vi.spyOn(Math, "random").mockReturnValue(1);
      const logged: Logged[] = [];
      const { pool } = fakePool(() => ({ rows: [] }));
      const queried = vi.spyOn(pool, "connect");
      const tick = startSouvenirTick({ pool, intervalMs: 1000, log: (f) => logged.push(f) });
      await vi.advanceTimersByTimeAsync(1199);
      expect(queried).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(queried).toHaveBeenCalled();
      await tick.stop();
    });

    it("runs again an interval after each run, and does not keep the process alive", async () => {
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const { tick, statements } = start({});
      const timer = timeout.mock.results[0]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(scans(statements)).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(scans(statements)).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(scans(statements)).toBe(2);
      await tick.stop();
    });
  });

  describe("what it logs", () => {
    it("says nothing when nothing is failed, behind or waiting", async () => {
      const { tick, logged, statements } = start({ health: quiet });
      await vi.advanceTimersByTimeAsync(1000);
      expect(statements.some((sql) => sql.includes("souvenir_health()"))).toBe(true);
      expect(logged).toEqual([]);
      await tick.stop();
    });

    it("says nothing when the health read has no row", async () => {
      const { tick, logged } = start({ health: null });
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toEqual([]);
      await tick.stop();
    });

    it("reports a claim that failed this run, by counts only", async () => {
      const { tick, logged } = start({
        claims: 2,
        evaluateError: pgError({ code: "40P01" }),
        health: quiet,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toEqual([
        { event: "souvenir.pending", granted: 0, skipped: 0, failed: 2, due: 0 },
      ]);
      await tick.stop();
    });

    it("reports a failed claim with a due count of zero when the health read has no row", async () => {
      const { tick, logged } = start({
        claims: 1,
        evaluateError: new Error("boom"),
        health: null,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toEqual([
        { event: "souvenir.pending", granted: 0, skipped: 0, failed: 1, due: 0 },
      ]);
      await tick.stop();
    });

    it("reports enrollments the database counts as failed, with how many are due", async () => {
      const { tick, logged } = start({ health: { due: 5, failed: 2, oldestAt: null } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toEqual([
        { event: "souvenir.pending", granted: 0, skipped: 0, failed: 0, due: 5 },
      ]);
      await tick.stop();
    });

    it("reports work that has waited more than a minute, and not work that waited exactly one or less", async () => {
      const waited = start({ health: { due: 3, failed: 0, oldestAt: secondsBefore(61) } });
      const exact = start({ health: { due: 3, failed: 0, oldestAt: secondsBefore(60) } });
      const fresh = start({ health: { due: 3, failed: 0, oldestAt: secondsBefore(10) } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(waited.logged).toEqual([
        { event: "souvenir.pending", granted: 0, skipped: 0, failed: 0, due: 3 },
      ]);
      expect(exact.logged).toEqual([]);
      expect(fresh.logged).toEqual([]);
      await Promise.all([waited.tick.stop(), exact.tick.stop(), fresh.tick.stop()]);
    });

    it("logs a failed run by its code and keeps the error text out", async () => {
      const { tick, logged } = start({ scanError: pgError({ code: "57014" }) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toEqual([{ event: "souvenir.tick_failed", code: "57014" }]);
      await tick.stop();
    });

    it("logs a failure with no code as SV500, and runs again", async () => {
      const { tick, logged, statements } = start({ scanError: new Error("password=hunter2") });
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toEqual([{ event: "souvenir.tick_failed", code: "SV500" }]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(logged).toHaveLength(2);
      expect(scans(statements)).toBe(2);
      await tick.stop();
    });
  });

  describe("stopping", () => {
    it("stopped before its first run, never runs", async () => {
      const { tick, statements } = start({});
      await tick.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(statements).toEqual([]);
    });

    it("stopped during a run, waits for it and schedules none after it", async () => {
      const gate: { open?: () => void } = {};
      const held = new Promise<void>((resolve) => {
        gate.open = resolve;
      });
      let scansSeen = 0;
      const pool = {
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes("souvenir_scan_batch")) {
              scansSeen += 1;
              await held;
            }
            return { rows: [] };
          },
          release: () => undefined,
        }),
      } as unknown as Pool;
      const tick = startSouvenirTick({
        pool,
        intervalMs: 1000,
        random: () => 0.5,
        log: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(scansSeen).toBe(1);
      let stopped = false;
      const stopping = tick.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      gate.open?.();
      await stopping;
      expect(stopped).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(scansSeen).toBe(1);
    });
  });
});
