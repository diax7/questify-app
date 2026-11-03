// What every stage of the monitoring validation shares: where the files are, a name for this run, the fresh secrets,
// and the environment the app is started with. No value here is a credential: they are made up on every run.
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce } from "./docker.mjs";
import { secret } from "./fixtures.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const MONITORING = join(ROOT, "ops", "monitoring");
export const STACK = join(MONITORING, "stack");
export const ALERTS = join(ROOT, "ops", "alerts");

/** The user name every request to the app carries (docs/RUNBOOK.md, "Monitoring stack on CranL"). */
export const METRICS_USER = "questify-metrics";

/** The public address Grafana is told it lives at; the validation reaches it on a local port instead. */
export const GRAFANA_ROOT_URL = "https://monitoring.example.test/grafana/";

// The image the RUNBOOK uses to make the bcrypt hash of the app's password; pinned by tag and digest.
const HTPASSWD_IMAGE =
  "httpd:2.4.69-alpine@sha256:070da7661f0be8a05430b2c125c0cde9e53176b4048c813024021969a0e3893c";

/** The bcrypt hash of a password, made the way docs/RUNBOOK.md says to make it. */
function bcryptHash(password) {
  const result = runOnce({
    image: HTPASSWD_IMAGE,
    entrypoint: "htpasswd",
    args: ["-nbBC", "10", METRICS_USER, password],
  });
  const hash = new RegExp(`^${METRICS_USER}:(\\$2y\\$10\\$\\S+)$`, "m").exec(result.stdout)?.[1];
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
    name: (part) => `qmon-${part}-${runId}`,
    image: `questify-validate-stack:${runId}`,
    secrets: {
      metricsPassword,
      metricsHash: bcryptHash(metricsPassword),
      smtpPassword: secret(12),
      grafanaAdmin: secret(24),
      grafanaKey: secret(32),
    },
  };
}

/** What the app needs with alert email off (Q-581): the metrics password and the two Grafana secrets, no ALERT_* setting. */
export const stackEnvWithoutEmail = (ctx) => ({
  METRICS_PASSWORD: ctx.secrets.metricsPassword,
  METRICS_PASSWORD_HASH: ctx.secrets.metricsHash,
  GF_SECURITY_ADMIN_PASSWORD: ctx.secrets.grafanaAdmin,
  GF_SECURITY_SECRET_KEY: ctx.secrets.grafanaKey,
  GF_SERVER_ROOT_URL: GRAFANA_ROOT_URL,
});

/** The same with alert email on: all five ALERT_* settings and the environment name. */
export const stackEnv = (ctx, smtpHost) => ({
  ...stackEnvWithoutEmail(ctx),
  ALERT_SMTP_PASSWORD: ctx.secrets.smtpPassword,
  ALERT_SMTP_HOST: smtpHost,
  ALERT_SMTP_USER: "alerts@example.test",
  ALERT_MAIL_FROM: "alerts@example.test",
  ALERT_MAIL_TO: "owner@example.test",
  MONITORING_ENVIRONMENT: "validation",
});
