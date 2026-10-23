import { describe, expect, it } from "vitest";
import { endTickOf, TICKS_PER_SECOND, tickAt, tickStartMs } from "#src/games/ticks";

describe("the real-time tick", () => {
  it("maps every tick of the longest round to its first millisecond and back", () => {
    for (let tick = 1; tick <= 1800; tick += 1) {
      expect(tickAt(tickStartMs(tick)), `tick ${tick}`).toBe(tick);
      expect(tickAt(tickStartMs(tick) - 1), `tick ${tick}`).toBe(tick - 1);
    }
    expect(tickAt(tickStartMs(0))).toBe(0);
  });

  it("never goes back as time goes on", () => {
    for (let t = 1; t <= 60_000; t += 1) {
      expect(tickAt(t) - tickAt(t - 1)).toBeGreaterThanOrEqual(0);
      expect(tickAt(t) - tickAt(t - 1)).toBeLessThanOrEqual(1);
    }
  });

  it("holds its golden values", () => {
    expect(TICKS_PER_SECOND).toBe(30);
    expect([0, 33, 34, 66, 67, 99, 100, 1000, 45_000, 45_034].map(tickAt)).toEqual([
      0, 0, 1, 1, 2, 2, 3, 30, 1350, 1351,
    ]);
    expect([0, 1, 2, 3, 30, 1350, 1351].map(tickStartMs)).toEqual([
      0, 34, 67, 100, 1000, 45_000, 45_034,
    ]);
    expect(endTickOf(45)).toBe(1350);
    expect(endTickOf(30)).toBe(900);
  });
});
