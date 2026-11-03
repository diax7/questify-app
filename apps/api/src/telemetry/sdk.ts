import { randomUUID } from "node:crypto";
import {
  context,
  createNoopMeter,
  diag,
  DiagLogLevel,
  metrics,
  trace,
  type DiagLogger,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { safeAttributes } from "#src/telemetry/attributes";
import type { TelemetryConfig } from "#src/telemetry/config";
import { SCOPE, useMeter } from "#src/telemetry/instruments";

/** Every outside call has a timeout (rules.md hard rule 5); an export that takes longer is dropped. */
const EXPORT_TIMEOUT_MS = 5000;
const TRACE_BATCH_DELAY_MS = 5000;
/** The most a diagnostic line may say, and how often one may be written. */
const DIAG_MESSAGE_LIMIT = 200;
const DIAG_PAUSE_MS = 60_000;

export type Telemetry = Readonly<{
  /** Sends what is waiting (the metrics' next collection and the traces' batch) now. */
  flush: () => Promise<void>;
  /** Flushes, stops both providers and returns the instruments to no-ops. Never throws. */
  shutdown: () => Promise<void>;
}>;

/** The destinations of the two signals. Tests give in-memory ones. */
export type Pipelines = Readonly<{
  spanProcessors: readonly SpanProcessor[];
  metricReaders: readonly MetricReader[];
}>;

export type InstallOptions = Readonly<{
  environment: string;
  release: string;
  traceRatio: number;
}>;

const NOTHING: Telemetry = { flush: async () => {}, shutdown: async () => {} };

const nothing = (): void => {};

/**
 * The second wall of the closed list (ADR-603, ADR-626 item 7, Q-585). Prometheus' OTLP receiver cannot drop what it is
 * sent, so the SDK does it: this view selects every instrument of every meter and cuts each recording's attributes down
 * to the keys on the list whose values have the right shape (`safeAttributes`), before the value is stored. A call that
 * skips `safeAttributes` (`counter.add(1, { phone })`) still leaves nothing off the list.
 */
const CLOSED_LIST_VIEW: ViewOptions = {
  instrumentName: "*",
  attributesProcessors: [{ process: (incoming) => safeAttributes(incoming) }],
};

/**
 * The OpenTelemetry SDK reports a failed export to a diagnostic logger, which is silent by default: a wrong receiver
 * address would go unseen. This writes the first line it hears each minute to standard error (a name and a short
 * message, never a header or a body; the address has no secret in it, `config.ts`).
 */
function exportFailureLogger(): DiagLogger {
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    error: (message) => {
      if (Date.now() - lastAt < DIAG_PAUSE_MS) return;
      lastAt = Date.now();
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          event: "telemetry.export_failed",
          message: String(message).slice(0, DIAG_MESSAGE_LIMIT),
        })}\n`,
      );
    },
    warn: nothing,
    info: nothing,
    debug: nothing,
    verbose: nothing,
  };
}

/** Registers the two providers and the context storage as the process's OpenTelemetry. One install at a time. */
export function installTelemetry(pipelines: Pipelines, options: InstallOptions): Telemetry {
  const resource = resourceFromAttributes({
    "service.name": SCOPE,
    "service.version": options.release,
    "service.instance.id": randomUUID(),
    "deployment.environment.name": options.environment,
  });
  const tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.traceRatio) }),
    spanProcessors: [...pipelines.spanProcessors],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [...pipelines.metricReaders],
    views: [CLOSED_LIST_VIEW],
  });
  diag.setLogger(exportFailureLogger(), DiagLogLevel.ERROR);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  useMeter(meterProvider.getMeter(SCOPE));
  const flush = async (): Promise<void> => {
    await Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
  };
  return {
    flush,
    shutdown: async () => {
      await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]).catch(() => {});
      trace.disable();
      metrics.disable();
      context.disable();
      diag.disable();
      useMeter(createNoopMeter());
    },
  };
}

function otlpPipelines(config: TelemetryConfig, otlp: NonNullable<TelemetryConfig["otlp"]>) {
  const common = { headers: { ...otlp.headers }, timeoutMillis: EXPORT_TIMEOUT_MS };
  return {
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({ ...common, url: `${otlp.endpoint}/v1/traces` }),
        scheduledDelayMillis: TRACE_BATCH_DELAY_MS,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ ...common, url: `${otlp.endpoint}/v1/metrics` }),
        exportIntervalMillis: config.metricIntervalMs,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  } satisfies Pipelines;
}

function consolePipelines(config: TelemetryConfig) {
  return {
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new ConsoleSpanExporter(),
        scheduledDelayMillis: TRACE_BATCH_DELAY_MS,
      }),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: config.metricIntervalMs,
        exportTimeoutMillis: EXPORT_TIMEOUT_MS,
      }),
    ],
  } satisfies Pipelines;
}

/** Starts telemetry as configured: nothing at all for `off`, so a server without the setting is unchanged. */
export function startTelemetry(config: TelemetryConfig): Telemetry {
  if (config.exporter === "off") {
    return NOTHING;
  }
  // `otlp` is set exactly when the exporter is `otlp` (config.ts).
  const pipelines =
    config.otlp === undefined ? consolePipelines(config) : otlpPipelines(config, config.otlp);
  return installTelemetry(pipelines, {
    environment: config.environment,
    release: config.release,
    traceRatio: config.traceRatio,
  });
}
