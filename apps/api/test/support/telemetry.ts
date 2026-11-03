import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApp, loggerOptions } from "#src/app";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { installTelemetry, type Telemetry } from "#src/telemetry/sdk";
import { RecordingEmailSender, testConfig } from "#test/support/auth-app";

export type Recording = Readonly<{
  /** Every span that has ended since the last call to `reset`. */
  spans: () => ReadableSpan[];
  /** Collects the metrics now and answers the data points of each metric by name. */
  metrics: () => Promise<ReadonlyMap<string, readonly MetricPoint[]>>;
  /** Everything recorded so far as one JSON text, for scans of what could leak. */
  everything: () => Promise<string>;
  shutdown: () => Promise<void>;
}>;

export type MetricPoint = Readonly<{ attributes: Record<string, unknown>; value: unknown }>;

function pointsOf(collected: ResourceMetrics | undefined): Map<string, MetricPoint[]> {
  const byName = new Map<string, MetricPoint[]>();
  for (const scope of collected?.scopeMetrics ?? []) {
    for (const metric of scope.metrics) {
      byName.set(
        metric.descriptor.name,
        metric.dataPoints.map((point) => ({
          attributes: { ...point.attributes },
          value: point.value,
        })),
      );
    }
  }
  return byName;
}

/**
 * Installs telemetry with in-memory exporters and every trace kept, so a test sees exactly what would leave the
 * machine. Only one recording can be installed at a time; shut it down in `afterEach`.
 */
export function recordTelemetry(): Recording {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry: Telemetry = installTelemetry(
    {
      spanProcessors: [new SimpleSpanProcessor({ exporter: spanExporter })],
      metricReaders: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 3_600_000,
          exportTimeoutMillis: 5000,
        }),
      ],
    },
    { environment: "test", release: "test-release", traceRatio: 1 },
  );
  const collect = async (): Promise<ResourceMetrics | undefined> => {
    metricExporter.reset();
    await telemetry.flush();
    return metricExporter.getMetrics().at(-1);
  };
  return {
    spans: () => spanExporter.getFinishedSpans(),
    metrics: async () => pointsOf(await collect()),
    everything: async () =>
      JSON.stringify({
        spans: spanExporter.getFinishedSpans().map((span) => ({
          name: span.name,
          attributes: span.attributes,
          resource: span.resource.attributes,
          events: span.events,
          links: span.links,
          status: span.status,
        })),
        metrics: await collect(),
      }),
    shutdown: telemetry.shutdown,
  };
}

/** An API server whose log lines are kept in `lines`, built on a pool that answers nothing. Close it after the test. */
export function buildLoggedApp(
  pool: Pool = { query: async () => ({ rows: [] }) } as unknown as Pool,
): { app: FastifyInstance; lines: string[] } {
  const lines: string[] = [];
  const config = testConfig();
  const app = buildApp({
    config,
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: new RecordingEmailSender(),
    breachCheck: async () => false,
    logger: {
      ...loggerOptions(config),
      stream: {
        write: (line: string) => {
          lines.push(line);
        },
      },
    },
  });
  return { app, lines };
}
