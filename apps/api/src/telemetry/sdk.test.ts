import { metrics, trace } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type MetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KEYS } from "#src/telemetry/attributes";
import { loadTelemetryConfig } from "#src/telemetry/config";
import { instruments } from "#src/telemetry/instruments";
import { installTelemetry, startTelemetry, type Telemetry } from "#src/telemetry/sdk";

const configFor = (env: Record<string, string>) =>
  loadTelemetryConfig(env, { nodeEnv: "development", release: "test" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startTelemetry", () => {
  it("installs nothing when off: no span is recorded and nothing is exported", async () => {
    const telemetry = startTelemetry(configFor({}));
    const span = trace.getTracer("test").startSpan("work");
    expect(span.isRecording()).toBe(false);
    expect(() => instruments().httpDuration.record(1)).not.toThrow();
    await telemetry.flush();
    await telemetry.shutdown();
    span.end();
  });

  it("reports a receiver that cannot be reached once, and never throws into the caller", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const telemetry = startTelemetry(
      configFor({
        TELEMETRY_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
        TELEMETRY_TRACE_RATIO: "1",
      }),
    );
    const span = trace.getTracer("test").startSpan("work");
    expect(span.isRecording()).toBe(true);
    span.end();
    instruments().logEvents.add(1);
    // Both the span and the metric fail to go out; one line says so.
    await telemetry.flush().catch(() => undefined);
    await telemetry.shutdown();
    const reports = written.filter((line) => line.includes("telemetry.export_failed"));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(reports[0] ?? "{}")).toMatchObject({ level: "error" });
    expect(metrics.getMeterProvider().getMeter("x")).toBeDefined();
  }, 30_000);

  it("returns the instruments to no-ops after shutdown", async () => {
    const telemetry = startTelemetry(configFor({ TELEMETRY_EXPORTER: "console" }));
    await telemetry.shutdown();
    expect(trace.getTracer("test").startSpan("after").isRecording()).toBe(false);
  });
});

describe("the second wall of the closed list", () => {
  let exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  let telemetry: Telemetry | undefined;

  function install(): void {
    exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    telemetry = installTelemetry(
      {
        spanProcessors: [],
        metricReaders: [
          new PeriodicExportingMetricReader({
            exporter,
            exportIntervalMillis: 3_600_000,
            exportTimeoutMillis: 5000,
          }),
        ],
      },
      { environment: "test", release: "test-release", traceRatio: 0 },
    );
  }

  async function exported(): Promise<{
    resource: ResourceMetrics;
    byName: Map<string, MetricData>;
  }> {
    exporter.reset();
    await telemetry?.flush();
    const resource = exporter.getMetrics().at(-1);
    if (resource === undefined) throw new Error("nothing was exported");
    const byName = new Map<string, MetricData>();
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) byName.set(metric.descriptor.name, metric);
    }
    return { resource, byName };
  }

  afterEach(async () => {
    await telemetry?.shutdown();
    telemetry = undefined;
  });

  it("drops a key off the list from a counter, a histogram and a gauge that skip safeAttributes", async () => {
    install();
    const meter = metrics.getMeter("direct");
    const offList = { "user.phone": "+966555000111", "client.address": "203.0.113.77" };
    meter.createCounter("test.counter").add(1, { ...offList, "questify.event": "auth.code_sent" });
    meter.createHistogram("test.histogram").record(2, { ...offList, "questify.tick": "lifecycle" });
    meter
      .createObservableGauge("test.gauge")
      .addCallback((result) => result.observe(3, { ...offList, "questify.pool": "api" }));

    const { byName } = await exported();
    const attributesOf = (name: string) => byName.get(name)?.dataPoints.map((p) => p.attributes);
    expect(attributesOf("test.counter")).toEqual([{ "questify.event": "auth.code_sent" }]);
    expect(attributesOf("test.histogram")).toEqual([{ "questify.tick": "lifecycle" }]);
    expect(attributesOf("test.gauge")).toEqual([{ "questify.pool": "api" }]);
  });

  it("drops a value that is not in the shape of its key, so a route cannot carry a number", async () => {
    install();
    metrics.getMeter("direct").createCounter("test.shapes").add(1, {
      "http.route": "/players/+966555000111",
      "http.request.method": "GET",
    });

    const { byName } = await exported();
    expect(byName.get("test.shapes")?.dataPoints.map((p) => p.attributes)).toEqual([
      { "http.request.method": "GET" },
    ]);
  });

  it("keeps the bucket edges and the attributes of the real instruments", async () => {
    install();
    instruments().httpDuration.record(0.3, {
      "http.request.method": "GET",
      "http.route": "/v1/players/:username",
      "http.response.status_code": 200,
      "user.email": "someone@example.test",
    });

    const { byName } = await exported();
    const point = byName.get("http.server.request.duration")?.dataPoints[0];
    expect(point?.attributes).toEqual({
      "http.request.method": "GET",
      "http.route": "/v1/players/:username",
      "http.response.status_code": 200,
    });
    expect(JSON.stringify(point?.value)).toContain("0.75");
  });

  it("gives the resource exactly the four allowed keys", async () => {
    install();
    metrics.getMeter("direct").createCounter("test.resource").add(1);

    const { resource } = await exported();
    expect(Object.keys(resource.resource.attributes).toSorted()).toEqual(
      [...RESOURCE_KEYS].toSorted(),
    );
  });
});
