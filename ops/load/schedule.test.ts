import { describe, expect, it } from "vitest";
import { addressOf, dueCount, intendedAt, phoneOf, slotOf } from "./schedule.mjs";

describe("the open schedule", () => {
  const stream = { startMs: 1000, ratePerSecond: 200, total: 1000 };

  it("has nothing due before its start", () => {
    expect(dueCount(stream, 999.9)).toBe(0);
  });

  it("has the first request due at its start", () => {
    expect(dueCount(stream, 1000)).toBe(1);
  });

  it("adds one request every 1000 / rate ms", () => {
    expect(dueCount(stream, 1004.9)).toBe(1);
    expect(dueCount(stream, 1005)).toBe(2);
    expect(dueCount(stream, 2000)).toBe(201);
  });

  it("never has more due than the stream holds", () => {
    expect(dueCount(stream, 1_000_000)).toBe(1000);
  });

  it("keeps a late sender's requests due, so a slow server cannot lower the rate", () => {
    // Nothing sent for a second: every request of that second is due at once and keeps its own intended time.
    expect(dueCount(stream, 2000) - dueCount(stream, 1000)).toBe(200);
    expect(intendedAt(stream, 100)).toBe(1500);
  });

  it("puts request i at start + i * 1000 / rate", () => {
    expect(intendedAt(stream, 0)).toBe(1000);
    expect(intendedAt({ startMs: 0, ratePerSecond: 3 }, 2)).toBeCloseTo(666.667, 3);
  });

  it.each([0, -5, Number.NaN])("refuses the rate %s", (rate) => {
    expect(() => dueCount({ ...stream, ratePerSecond: rate }, 2000)).toThrow(RangeError);
  });

  it("holds the target rate over a minute: 20,000 requests at 20,000 a minute", () => {
    const minute = { startMs: 0, ratePerSecond: 20_000 / 60, total: 20_000 };
    expect(dueCount(minute, 59_999)).toBe(20_000);
    expect(dueCount(minute, 30_000)).toBe(10_001);
  });
});

describe("slotOf", () => {
  it("walks every player before moving to the next quest", () => {
    expect(slotOf(0, 3, 2)).toEqual({ player: 0, quest: 0 });
    expect(slotOf(2, 3, 2)).toEqual({ player: 2, quest: 0 });
    expect(slotOf(3, 3, 2)).toEqual({ player: 0, quest: 1 });
  });

  it("never gives one player the same quest twice", () => {
    const pairs = new Set(Array.from({ length: 12 }, (_x, i) => JSON.stringify(slotOf(i, 4, 3))));
    expect(pairs.size).toBe(12);
  });

  it("answers null once every pair is used, or for a negative slot", () => {
    expect(slotOf(6, 3, 2)).toBeNull();
    expect(slotOf(-1, 3, 2)).toBeNull();
  });
});

describe("the rush's callers", () => {
  it("moves to a new address after perAddress requests", () => {
    expect(addressOf(0, 50)).toBe("10.0.0.1");
    expect(addressOf(49, 50)).toBe("10.0.0.1");
    expect(addressOf(50, 50)).toBe("10.0.0.2");
    expect(addressOf(255 * 50, 50)).toBe("10.0.1.0");
  });

  it("gives each request its own valid Saudi mobile number", () => {
    expect(phoneOf(0)).toBe("+966590000000");
    expect(phoneOf(1234)).toBe("+966590001234");
    expect(phoneOf(9_999_999)).toMatch(/^\+966[0-9]{9}$/);
  });
});
