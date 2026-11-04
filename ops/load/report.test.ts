import { describe, expect, it } from "vitest";
import { completionReport, rushReport, verdict } from "./report.mjs";

const driver = (overrides: Partial<Record<string, unknown>> = {}) => ({
  completions: {
    fromIntended: [100, 200, 1500],
    fromSent: [90, 190, 1400],
    confirmedMs: [100, 200],
    statuses: { "200": 2, "503": 1 },
    measured: 3,
  },
  probes: { afterConfirm: [300, 6000], afterSend: [400, 6100], gaveUp: 1, failed: 0 },
  reads: { statuses: {} },
  lagMs: [1, 2],
  rush: [],
  cpuMs: 1234.4,
  ...overrides,
});

describe("completionReport", () => {
  const report = completionReport([driver(), driver()], 2);

  it("merges the drivers' counts and latencies", () => {
    expect(report.attempted).toBe(6);
    expect(report.statuses).toEqual({ "200": 4, "503": 2 });
    expect(report.latencyFromIntended.count).toBe(6);
    expect(report.driverCpuMs).toEqual([1234, 1234]);
  });

  it("gives rates over the measured window", () => {
    expect(report.attemptedPerSecond).toBe(3);
    expect(report.confirmedPerSecond).toBe(2);
  });

  it("counts a refused completion as not confirmed in time", () => {
    // 4 confirmed within 1 s out of 6 attempted, though every confirmed one was fast.
    expect(report.confirmedWithin1s).toBeCloseTo(4 / 6);
  });

  it("counts a confirmed but slow completion as late", () => {
    const slow = driver({
      completions: {
        fromIntended: [100, 1001],
        fromSent: [100, 1001],
        confirmedMs: [100, 1001],
        statuses: { "200": 2 },
        measured: 2,
      },
    });
    expect(completionReport([slow], 1).confirmedWithin1s).toBe(0.5);
  });

  it("counts a probe that never showed as late for the ranking", () => {
    // Per driver: one within 5 s, one at 6 s, one gave up.
    expect(report.ranking.probes).toBe(6);
    expect(report.ranking.within5s).toBeCloseTo(2 / 6);
  });

  it("answers null shares when nothing was measured", () => {
    const empty = driver({
      completions: { fromIntended: [], fromSent: [], confirmedMs: [], statuses: {}, measured: 0 },
      probes: { afterConfirm: [], afterSend: [], gaveUp: 0, failed: 0 },
    });
    const none = completionReport([empty], 1);
    expect(none.confirmedWithin1s).toBeNull();
    expect(none.ranking.within5s).toBeNull();
  });
});

describe("verdict", () => {
  const passing = {
    attemptedPerSecond: 3300,
    confirmedWithin1s: 0.95,
    ranking: { within5s: 0.95 },
  } as unknown as ReturnType<typeof completionReport>;

  it("passes at the targets exactly", () => {
    expect(verdict(passing, 3333).pass).toBe(true);
  });

  it("fails a rate more than 2% under the one asked for", () => {
    expect(verdict({ ...passing, attemptedPerSecond: 3266 }, 3333)).toMatchObject({
      rateMet: false,
      pass: false,
    });
  });

  it("fails under 95% confirmed within 1 s or ranked within 5 s", () => {
    expect(verdict({ ...passing, confirmedWithin1s: 0.949 }, 3333).confirmMet).toBe(false);
    expect(verdict({ ...passing, ranking: { within5s: 0.9 } } as never, 3333).rankingMet).toBe(
      false,
    );
  });

  it("fails when nothing was measured", () => {
    expect(
      verdict({ ...passing, confirmedWithin1s: null, ranking: { within5s: null } } as never, 1)
        .pass,
    ).toBe(false);
  });
});

describe("rushReport", () => {
  it("summarizes each step", () => {
    expect(
      rushReport([{ ratePerSecond: 50, fromIntended: [10, 20], statuses: { "202": 2 } }]),
    ).toEqual([
      {
        ratePerSecond: 50,
        statuses: { "202": 2 },
        latency: { count: 2, p50: 10, p95: 20, p99: 20, max: 20, mean: 15 },
        latencyByStatus: {},
      },
    ]);
  });

  it("summarizes each answer's latency apart, so the refusals after a spent budget show their own p95", () => {
    const [step] = rushReport([
      {
        ratePerSecond: 300,
        fromIntended: [10, 20, 5],
        statuses: { "202": 2, "503": 1 },
        byStatus: { "202": [10, 20], "503": [5] },
      },
    ]);
    expect(step?.latencyByStatus).toEqual({
      "202": { count: 2, p50: 10, p95: 20, p99: 20, max: 20, mean: 15 },
      "503": { count: 1, p50: 5, p95: 5, p99: 5, max: 5, mean: 5 },
    });
  });
});
