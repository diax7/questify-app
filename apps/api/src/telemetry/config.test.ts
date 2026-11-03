import { describe, expect, it } from "vitest";
import { loadTelemetryConfig } from "#src/telemetry/config";

const server = { nodeEnv: "production", release: "abc1234" };
const load = (env: Record<string, string>, nodeEnv = server.nodeEnv) =>
  loadTelemetryConfig(env, { nodeEnv, release: server.release });

describe("loadTelemetryConfig", () => {
  it("is off when nothing is set, with the documented defaults", () => {
    expect(load({})).toEqual({
      exporter: "off",
      environment: "production",
      release: "abc1234",
      otlp: undefined,
      traceRatio: 0.1,
      metricIntervalMs: 60_000,
    });
  });

  it("reads an OTLP collector with its base address and headers", () => {
    const config = load({
      TELEMETRY_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.questify.sa:4318/",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abc, x-team=ops",
      TELEMETRY_TRACE_RATIO: "0.25",
      TELEMETRY_METRIC_INTERVAL_MS: "15000",
    });
    expect(config.otlp).toEqual({
      endpoint: "https://otel.questify.sa:4318",
      headers: { authorization: "Bearer abc", "x-team": "ops" },
    });
    expect(config.traceRatio).toBe(0.25);
    expect(config.metricIntervalMs).toBe(15_000);
  });

  it("keeps a path on the collector address and drops its trailing slash", () => {
    const config = load({
      TELEMETRY_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://gateway.example.sa/otlp/",
    });
    expect(config.otlp?.endpoint).toBe("https://gateway.example.sa/otlp");
  });

  it("allows plain http only to this machine", () => {
    const local = load({
      TELEMETRY_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });
    expect(local.otlp?.endpoint).toBe("http://localhost:4318");
    expect(() =>
      load({ TELEMETRY_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example.sa" }),
    ).toThrow("must be https");
  });

  it.each([
    ["no address", {}, "OTEL_EXPORTER_OTLP_ENDPOINT is required"],
    [
      "a user in the address",
      { OTEL_EXPORTER_OTLP_ENDPOINT: "https://me:pw@otel.sa" },
      "user, password",
    ],
    [
      "a query in the address",
      { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.sa/?token=1" },
      "query",
    ],
    ["an address that is not one", { OTEL_EXPORTER_OTLP_ENDPOINT: "otel" }, "must be an address"],
  ])("refuses OTLP with %s", (_, env, message) => {
    expect(() => load({ TELEMETRY_EXPORTER: "otlp", ...env })).toThrow(message);
  });

  it("refuses an unknown exporter and names the choices", () => {
    expect(() => load({ TELEMETRY_EXPORTER: "datadog" })).toThrow("off, console, otlp");
  });

  it("refuses the console exporter in production but not in development", () => {
    expect(() => load({ TELEMETRY_EXPORTER: "console" })).toThrow("for development");
    expect(load({ TELEMETRY_EXPORTER: "console" }, "development").exporter).toBe("console");
  });

  it.each([",", "oops", "=v", "name=", "name"])("refuses the malformed header list %j", (list) => {
    expect(() =>
      load({
        TELEMETRY_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.sa",
        OTEL_EXPORTER_OTLP_HEADERS: list,
      }),
    ).toThrow("OTEL_EXPORTER_OTLP_HEADERS must look like");
  });

  it("never prints a header value or the address in an error", () => {
    let message = "";
    try {
      load({
        TELEMETRY_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.sa",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=%E0%A4%A",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("OTEL_EXPORTER_OTLP_HEADERS");
    expect(message).not.toContain("%E0");
  });

  it.each(["-0.1", "1.5", "half", ""])("refuses a trace ratio of %j", (ratio) => {
    expect(() => load({ TELEMETRY_TRACE_RATIO: ratio })).toThrow("TELEMETRY_TRACE_RATIO");
  });

  it.each(["0", "1", "0.0001"])("accepts a trace ratio of %s", (ratio) => {
    expect(load({ TELEMETRY_TRACE_RATIO: ratio }).traceRatio).toBe(Number(ratio));
  });

  it.each(["4999", "600001", "1.5", "soon"])("refuses a metric interval of %s", (interval) => {
    expect(() => load({ TELEMETRY_METRIC_INTERVAL_MS: interval })).toThrow(
      "TELEMETRY_METRIC_INTERVAL_MS",
    );
  });
});
