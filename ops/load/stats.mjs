// Latency arithmetic for the load test (T-804): nearest-rank percentiles over every measured value, no sampling.

/**
 * The p-th percentile of ascending `sorted` values by the nearest-rank rule: the smallest value with at least p% of
 * the values at or below it.
 *
 * @param {readonly number[]} sorted values in ascending order
 * @param {number} p a percentile, above 0 and at most 100
 * @returns {number | null} null when there are no values
 */
export function percentile(sorted, p) {
  if (!(p > 0 && p <= 100)) {
    throw new RangeError(`A percentile is above 0 and at most 100; got ${p}.`);
  }
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] ?? null;
}

const round = (/** @type {number | null} */ value) =>
  value === null ? null : Math.round(value * 10) / 10;

/**
 * Count, p50, p95, p99, max and mean of `values` (milliseconds), rounded to 0.1 ms.
 *
 * @param {readonly number[]} values
 */
export function summarize(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? null),
    mean: round(sorted.length === 0 ? null : total / sorted.length),
  };
}

/**
 * The share of `values` at or below `limit`, as a fraction from 0 to 1; null when there are none.
 *
 * @param {readonly number[]} values
 * @param {number} limit
 */
export function shareWithin(values, limit) {
  if (values.length === 0) {
    return null;
  }
  return values.filter((value) => value <= limit).length / values.length;
}

/**
 * Adds the counts of `more` into `into` (status counts from several drivers).
 *
 * @param {Record<string, number>} into
 * @param {Readonly<Record<string, number>>} more
 */
export function addCounts(into, more) {
  for (const [key, count] of Object.entries(more)) {
    into[key] = (into[key] ?? 0) + count;
  }
  return into;
}
