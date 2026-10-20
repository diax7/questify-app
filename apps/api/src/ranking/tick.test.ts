import { describe, expect, it, vi } from "vitest";
import type { Ranking } from "#src/ranking/ranking";
import { startRankingTick } from "#src/ranking/tick";

const rankingWith = (repairDue: () => Promise<void>): Ranking => ({
  afterCompletion: () => Promise.resolve(null),
  read: () => Promise.resolve("not_enrolled"),
  repairDue,
});

describe("the ranking repair tick", () => {
  it("runs on its interval, one run at a time, and stops after the run in progress", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let finish: (() => void) | undefined;
      const tick = startRankingTick(
        rankingWith(() => {
          runs += 1;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        }),
        2000,
        () => undefined,
      );
      await vi.advanceTimersByTimeAsync(1999);
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(runs).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runs).toBe(1);
      finish?.();
      await vi.advanceTimersByTimeAsync(2000);
      expect(runs).toBe(2);
      const stopped = tick.stop();
      finish?.();
      await stopped;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runs).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a failed run and keeps going", async () => {
    vi.useFakeTimers();
    try {
      const logged: Record<string, unknown>[] = [];
      let runs = 0;
      const tick = startRankingTick(
        rankingWith(() => {
          runs += 1;
          return runs === 1 ? Promise.reject(new RangeError("x")) : Promise.reject("odd");
        }),
        100,
        (fields) => logged.push(fields),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(logged).toEqual([
        { event: "ranking.repair_failed", reason: "RangeError" },
        { event: "ranking.repair_failed", reason: "unknown" },
      ]);
      await tick.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
