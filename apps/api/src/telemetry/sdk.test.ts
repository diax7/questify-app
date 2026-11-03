import { metrics, trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTelemetryConfig } from "#src/telemetry/config";
import { instruments } from "#src/telemetry/instruments";
import { startTelemetry } from "#src/telemetry/sdk";

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

  it("reports a collector that cannot be reached once, and never throws into the caller", async () => {
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
