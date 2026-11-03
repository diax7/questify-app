// What every stage of the monitoring validation shares: where the files are, a name for this run, the fresh secrets,
// and the environment each app is started with. No value here is a credential: they are made up on every run.
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce } from "./docker.mjs";
import { secret } from "./fixtures.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const MONITORING = join(ROOT, "ops", "monitoring");
export const ALERTS = join(ROOT, "ops", "alerts");

// The image the RUNBOOK uses to make the bcrypt hash of the Prometheus app's password; pinned by tag and digest.
const HTPASSWD_IMAGE =
  "httpd:2.4.69-alpine@sha256:070da7661f0be8a05430b2c125c0cde9e53176b4048c813024021969a0e3893c";

/** The bcrypt hash of a password, made the way docs/RUNBOOK.md says to make it. */
function bcryptHash(password) {
  const result = runOnce({
    image: HTPASSWD_IMAGE,
    entrypoint: "htpasswd",
    args: ["-nbBC", "10", "questify-metrics", password],
  });
  const hash = /^questify-metrics:(\$2y\$10\$\S+)$/m.exec(result.stdout)?.[1];
  if (hash === undefined) {
    throw new Error(`htpasswd gave no bcrypt hash:\n${result.stdout}${result.stderr}`);
  }
  return hash;
}

export function createContext() {
  const runId = randomBytes(3).toString("hex");
  const metricsPassword = secret(24);
  return {
    runId,
    network: `qmon-${runId}`,
    name: (part) => `qmon-${part}-${runId}`,
    image: (part) => `questify-validate-${part}:${runId}`,
    secrets: {
      tokenA: secret(24),
      tokenB: secret(24),
      metricsPassword,
      metricsHash: bcryptHash(metricsPassword),
      smtpPassword: secret(12),
      grafanaAdmin: secret(24),
      grafanaKey: secret(32),
    },
  };
}

export const collectorEnv = (ctx, remoteWriteUrl) => ({
  OTEL_INGEST_TOKEN_A: ctx.secrets.tokenA,
  OTEL_INGEST_TOKEN_B: ctx.secrets.tokenB,
  METRICS_PASSWORD: ctx.secrets.metricsPassword,
  PROMETHEUS_REMOTE_WRITE_URL: remoteWriteUrl,
});

export const prometheusEnv = (ctx, smtpHost) => ({
  METRICS_PASSWORD: ctx.secrets.metricsPassword,
  METRICS_PASSWORD_HASH: ctx.secrets.metricsHash,
  ALERT_SMTP_PASSWORD: ctx.secrets.smtpPassword,
  ALERT_SMTP_HOST: smtpHost,
  ALERT_SMTP_USER: "alerts@example.test",
  ALERT_MAIL_FROM: "alerts@example.test",
  ALERT_MAIL_TO: "owner@example.test",
  MONITORING_ENVIRONMENT: "validation",
});

export const grafanaEnv = (ctx, prometheusUrl) => ({
  GF_SECURITY_ADMIN_PASSWORD: ctx.secrets.grafanaAdmin,
  GF_SECURITY_SECRET_KEY: ctx.secrets.grafanaKey,
  GF_SERVER_ROOT_URL: "https://grafana.example.test",
  PROMETHEUS_URL: prometheusUrl,
  METRICS_PASSWORD: ctx.secrets.metricsPassword,
});
