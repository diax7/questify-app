// Turns the drivers' raw measurements into the load test's report and its verdict against NFR-002, NFR-003 and NFR-005.
import { addCounts, summarize } from "./stats.mjs";

/** NFR-002: 95% of completions confirmed within 1 s. NFR-005: the ranking shows a change within 5 s. */
export const TARGETS = { confirmMs: 1000, confirmShare: 0.95, rankingMs: 5000, rankingShare: 0.95 };

/**
 * The completion and ranking figures of several drivers' results, over the measured window of `seconds`.
 *
 * @param {ReadonlyArray<any>} results the drivers' result files
 * @param {number} seconds the measured window
 */
export function completionReport(results, seconds) {
  const fromIntended = results.flatMap((r) => r.completions.fromIntended);
  const confirmed = results.flatMap((r) => r.completions.confirmedMs);
  const statuses = results.reduce((into, r) => addCounts(into, r.completions.statuses), {});
  const measured = results.reduce((sum, r) => sum + r.completions.measured, 0);
  const ok = statuses["200"] ?? 0;
  const afterConfirm = results.flatMap((r) => r.probes.afterConfirm);
  const probesTried = results.reduce(
    (sum, r) => sum + r.probes.afterConfirm.length + r.probes.gaveUp + r.probes.failed,
    0,
  );
  return {
    attempted: measured,
    attemptedPerSecond: Math.round(measured / seconds),
    confirmedPerSecond: Math.round(ok / seconds),
    statuses,
    latencyFromIntended: summarize(fromIntended),
    latencyFromSent: summarize(results.flatMap((r) => r.completions.fromSent)),
    // A refused or lost completion counts as not confirmed in time.
    confirmedWithin1s:
      measured === 0 ? null : confirmed.filter((ms) => ms <= TARGETS.confirmMs).length / measured,
    schedulerLag: summarize(results.flatMap((r) => r.lagMs)),
    ranking: {
      probes: probesTried,
      afterConfirm: summarize(afterConfirm),
      afterSend: summarize(results.flatMap((r) => r.probes.afterSend)),
      // A probe that never showed or failed counts as late.
      within5s:
        probesTried === 0
          ? null
          : afterConfirm.filter((ms) => ms <= TARGETS.rankingMs).length / probesTried,
    },
    driverCpuMs: results.map((r) => Math.round(r.cpuMs)),
  };
}

/**
 * Each rush step's rate, answers and latency, overall and per answer (T-804b: the p95 of the requests answered after
 * the budget was spent is the p95 of the 503s).
 *
 * @param {ReadonlyArray<{ ratePerSecond: number; fromIntended: number[]; statuses: Record<string, number>; byStatus?: Record<string, number[]> }>} steps
 */
export function rushReport(steps) {
  return steps.map((step) => ({
    ratePerSecond: step.ratePerSecond,
    statuses: step.statuses,
    latency: summarize(step.fromIntended),
    latencyByStatus: Object.fromEntries(
      Object.entries(step.byStatus ?? {}).map(([status, values]) => [status, summarize(values)]),
    ),
  }));
}

/**
 * Whether the completion figures meet NFR-002 and NFR-005 at the rate asked for (within 2% of it).
 *
 * @param {ReturnType<typeof completionReport>} report
 * @param {number} askedPerSecond
 */
export function verdict(report, askedPerSecond) {
  const rateMet = report.attemptedPerSecond >= askedPerSecond * 0.98;
  const confirmMet = (report.confirmedWithin1s ?? 0) >= TARGETS.confirmShare;
  const rankingMet = (report.ranking.within5s ?? 0) >= TARGETS.rankingShare;
  return { rateMet, confirmMet, rankingMet, pass: rateMet && confirmMet && rankingMet };
}
