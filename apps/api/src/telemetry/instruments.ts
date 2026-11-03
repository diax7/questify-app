import { createNoopMeter, type Counter, type Histogram, type Meter } from "@opentelemetry/api";
import type { Pool } from "pg";
import { POOL_STATES, safeAttributes, type PoolName, type Tick } from "#src/telemetry/attributes";

/** The name the API's instruments are created under. */
export const SCOPE = "questify-api";

/**
 * Every metric the API records: the one list the instruments are made from and the alert rules are checked against
 * (`alerts.test.ts`). Names are OpenTelemetry's; a Prometheus-style store spells them with underscores, `_total` for a
 * counter and the unit for a unit of time (`http_server_request_duration_seconds_bucket`), and the rules use that spelling.
 */
export const METRICS = {
  httpDuration: {
    name: "http.server.request.duration",
    unit: "s",
    kind: "histogram",
    description: "How long a request took, by route pattern and status.",
  },
  logEvents: {
    name: "questify.log.events",
    unit: "{event}",
    kind: "counter",
    description: "Log lines that name an event, by event and level.",
  },
  outboundRequests: {
    name: "questify.outbound.requests",
    unit: "{request}",
    kind: "counter",
    description: "Calls to an outside provider (SMS, email, push), by provider and outcome.",
  },
  outboundDuration: {
    name: "questify.outbound.duration",
    unit: "s",
    kind: "histogram",
    description: "How long an outside provider took to answer.",
  },
  tickRuns: {
    name: "questify.tick.runs",
    unit: "{run}",
    kind: "counter",
    description: "Runs of a background loop, by loop and outcome.",
  },
  tickDuration: {
    name: "questify.tick.duration",
    unit: "s",
    kind: "histogram",
    description: "How long one run of a background loop took.",
  },
  tickLastRun: {
    name: "questify.tick.last_run",
    unit: "s",
    kind: "gauge",
    description: "When a background loop last finished a run (seconds since 1970).",
  },
  poolConnections: {
    name: "questify.db.pool.connections",
    unit: "{connection}",
    kind: "gauge",
    description: "Database connections by pool and state (total, idle, waiting for one).",
  },
} as const;

/** Bucket edges in seconds. The request edges include exactly 1 s, the completion target (ADR-074). */
const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10];
const CALL_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const RUN_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30];

/** What the gauges read when the metrics are collected. Written by `runs.ts` and `pool.ts`. */
export const gaugeSources = {
  lastRuns: new Map<Tick, number>(),
  pools: new Map<PoolName, Pool>(),
};

export type Instruments = Readonly<{
  httpDuration: Histogram;
  logEvents: Counter;
  outboundRequests: Counter;
  outboundDuration: Histogram;
  tickRuns: Counter;
  tickDuration: Histogram;
}>;

type Metric = (typeof METRICS)[keyof typeof METRICS];

function histogramOf(meter: Meter, metric: Metric, boundaries: number[]): Histogram {
  return meter.createHistogram(metric.name, {
    unit: metric.unit,
    description: metric.description,
    advice: { explicitBucketBoundaries: boundaries },
  });
}

function observeGauges(meter: Meter): void {
  const lastRun = meter.createObservableGauge(METRICS.tickLastRun.name, {
    unit: METRICS.tickLastRun.unit,
    description: METRICS.tickLastRun.description,
  });
  lastRun.addCallback((result) => {
    for (const [tick, at] of gaugeSources.lastRuns) {
      result.observe(at / 1000, safeAttributes({ "questify.tick": tick }));
    }
  });
  const connections = meter.createObservableGauge(METRICS.poolConnections.name, {
    unit: METRICS.poolConnections.unit,
    description: METRICS.poolConnections.description,
  });
  connections.addCallback((result) => {
    for (const [name, pool] of gaugeSources.pools) {
      const counts = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
      for (const state of POOL_STATES) {
        result.observe(
          counts[state],
          safeAttributes({ "questify.pool": name, "questify.pool.state": state }),
        );
      }
    }
  });
}

/** Makes every instrument of the catalog on a meter. */
export function createInstruments(meter: Meter): Instruments {
  observeGauges(meter);
  const counter = (metric: Metric) =>
    meter.createCounter(metric.name, { unit: metric.unit, description: metric.description });
  return {
    httpDuration: histogramOf(meter, METRICS.httpDuration, REQUEST_BUCKETS),
    logEvents: counter(METRICS.logEvents),
    outboundRequests: counter(METRICS.outboundRequests),
    outboundDuration: histogramOf(meter, METRICS.outboundDuration, CALL_BUCKETS),
    tickRuns: counter(METRICS.tickRuns),
    tickDuration: histogramOf(meter, METRICS.tickDuration, RUN_BUCKETS),
  };
}

let current: Instruments = createInstruments(createNoopMeter());

/** The instruments now in force: no-ops until telemetry is installed. */
export const instruments = (): Instruments => current;

/** Points the instruments at a meter (the installed one, or the no-op one after shutdown). */
export function useMeter(meter: Meter): void {
  current = createInstruments(meter);
}
