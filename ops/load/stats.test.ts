import { describe, expect, it } from "vitest";
import { addCounts, percentile, shareWithin, summarize } from "./stats.mjs";

describe("percentile (nearest rank)", () => {
  const hundred = Array.from({ length: 100 }, (_x, i) => i + 1);

  it("answers the smallest value with p% at or below it", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it("rounds the rank up, never down", () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([10, 20, 30, 40], 25)).toBe(10);
    expect(percentile([10, 20, 30, 40], 26)).toBe(20);
  });

  it("answers the only value for any percentile of one", () => {
    expect(percentile([7], 1)).toBe(7);
    expect(percentile([7], 100)).toBe(7);
  });

  it("answers null when there are no values", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it.each([0, -1, 100.1, Number.NaN])("refuses the percentile %s", (p) => {
    expect(() => percentile([1], p)).toThrow(RangeError);
  });
});

describe("summarize", () => {
  it("sorts its input without changing it and rounds to 0.1 ms", () => {
    const values = [3.04, 1, 2.26];
    expect(summarize(values)).toEqual({
      count: 3,
      p50: 2.3,
      p95: 3,
      p99: 3,
      max: 3,
      mean: 2.1,
    });
    expect(values).toEqual([3.04, 1, 2.26]);
  });

  it("sorts numerically, not as text", () => {
    expect(summarize([900, 1000, 80]).max).toBe(1000);
  });

  it("answers nulls and a zero count for no values", () => {
    expect(summarize([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
    });
  });
});

describe("shareWithin", () => {
  it("counts a value equal to the limit as within it", () => {
    expect(shareWithin([999, 1000, 1001, 2000], 1000)).toBe(0.5);
  });

  it("answers null for no values", () => {
    expect(shareWithin([], 1000)).toBeNull();
  });
});

describe("addCounts", () => {
  it("adds every key, new ones included", () => {
    expect(addCounts({ "200": 2, "503": 1 }, { "200": 3, timeout: 4 })).toEqual({
      "200": 5,
      "503": 1,
      timeout: 4,
    });
  });
});
