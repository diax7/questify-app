import { optional, whole, type Env } from "#src/config";

export const TELEMETRY_EXPORTERS = ["off", "console", "otlp"] as const;
export type TelemetryExporter = (typeof TELEMETRY_EXPORTERS)[number];

export type TelemetryConfig = Readonly<{
  /** `off` (the default) installs nothing: every instrument is a no-op and nothing leaves the machine. */
  exporter: TelemetryExporter;
  /** The deployment, as `service.version` and `deployment.environment.name` on every signal. */
  environment: string;
  release: string;
  /** Where `otlp` sends: the OTLP receiver's base address and the headers it asks for (a credential). Never logged. */
  otlp: Readonly<{ endpoint: string; headers: Readonly<Record<string, string>> }> | undefined;
  /** The share of requests that keep a trace (0 to 1). Metrics and logs always count every request. */
  traceRatio: number;
  metricIntervalMs: number;
}>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_TRACE_RATIO = "0.1";
// Prometheus's OTLP receiver (the one receiver the API sends to) has no trace endpoint: a span would only fail to export.
const OTLP_TRACE_RATIO = "0";
const DEFAULT_METRIC_INTERVAL_MS = "60000";

function exporterOf(env: Env, nodeEnv: string): TelemetryExporter {
  const text = optional(env, "TELEMETRY_EXPORTER") ?? "off";
  if (!(TELEMETRY_EXPORTERS as readonly string[]).includes(text)) {
    throw new Error(
      `TELEMETRY_EXPORTER must be one of ${TELEMETRY_EXPORTERS.join(", ")}; got "${text}".`,
    );
  }
  if (text === "console" && nodeEnv === "production") {
    throw new Error(
      "TELEMETRY_EXPORTER=console prints every signal to standard output and is for development; use otlp or off in production.",
    );
  }
  return text as TelemetryExporter;
}

/**
 * The OTLP receiver's base address (Prometheus's, `https://<app>/api/v1/otlp`; the exporters add `/v1/metrics`). Telemetry
 * holds no personal data (ADR-603), but the address is still checked: https (plain http only to this machine), and no
 * user, password, query or fragment, so a secret cannot ride in a URL that a diagnostic line might print.
 */
function endpointOf(env: Env): string {
  const text = optional(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  if (text === undefined) {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT is required when TELEMETRY_EXPORTER=otlp: the OTLP receiver's base address, like https://monitoring.example.sa/api/v1/otlp.",
    );
  }
  const url = parsedUrl(text);
  const toThisMachine = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !toThisMachine) {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be https (http only to localhost).");
  }
  if (hasSecretPlace(url)) {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must not carry a user, password, query or fragment: put the credential in OTEL_EXPORTER_OTLP_HEADERS.",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parsedUrl(text: string): URL {
  try {
    return new URL(text);
  } catch {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an address like https://monitoring.example.sa/api/v1/otlp.",
    );
  }
}

const hasSecretPlace = (url: URL): boolean =>
  url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "";

/** The text with its percent-escapes undone, or empty when they are malformed (the caller refuses empty). */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
}

/** `name=value,name2=value2`, values percent-encoded as in the OpenTelemetry specification. Errors name no value. */
function headersOf(env: Env): Record<string, string> {
  const text = optional(env, "OTEL_EXPORTER_OTLP_HEADERS");
  const headers: Record<string, string> = {};
  if (text === undefined) {
    return headers;
  }
  for (const pair of text.split(",")) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = at < 0 ? "" : decoded(pair.slice(at + 1).trim());
    if (at < 0 || !HEADER_NAME.test(name) || value === "") {
      throw new Error("OTEL_EXPORTER_OTLP_HEADERS must look like name=value,other-name=value.");
    }
    headers[name] = value;
  }
  return headers;
}

function ratioOf(env: Env, exporter: TelemetryExporter): number {
  const fallback = exporter === "otlp" ? OTLP_TRACE_RATIO : DEFAULT_TRACE_RATIO;
  const text = env["TELEMETRY_TRACE_RATIO"] ?? fallback;
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`TELEMETRY_TRACE_RATIO must be a number from 0 to 1; got "${text}".`);
  }
  return value;
}

/**
 * Reads the telemetry settings from environment variables (12-factor). Off unless asked: a server with no
 * `TELEMETRY_EXPORTER` behaves exactly as before and sends nothing anywhere. With `otlp`, traces are off (ratio 0)
 * unless `TELEMETRY_TRACE_RATIO` says otherwise.
 *
 * @throws Error naming the variable (never its value) when a setting is missing or not valid.
 */
export function loadTelemetryConfig(
  env: Env,
  server: Readonly<{ nodeEnv: string; release: string }>,
): TelemetryConfig {
  const exporter = exporterOf(env, server.nodeEnv);
  return {
    exporter,
    environment: server.nodeEnv,
    release: server.release,
    otlp: exporter === "otlp" ? { endpoint: endpointOf(env), headers: headersOf(env) } : undefined,
    traceRatio: ratioOf(env, exporter),
    metricIntervalMs: whole(
      env,
      "TELEMETRY_METRIC_INTERVAL_MS",
      DEFAULT_METRIC_INTERVAL_MS,
      5000,
      600_000,
    ),
  };
}
