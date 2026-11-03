// The first stage of the monitoring validation: every file is checked by the program that will read it, in the pinned
// image, before anything is started.
import { runOnce } from "./docker.mjs";
import { ALERTS, collectorEnv, MONITORING, prometheusEnv } from "./context.mjs";
import { ensure } from "./http.mjs";
import { join } from "node:path";

// Pinned by tag and digest like the apps' base images; raise on purpose.
const SHELLCHECK =
  "koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d";
const SHFMT =
  "mvdan/shfmt:v3.14.1@sha256:8c06884a35683d8763fba6c0d9484d11a61a96da65f8d497d6f625825a6043f2";
const SCRIPTS = [
  "/mnt/prometheus/entrypoint.sh",
  "/mnt/prometheus/render-config.sh",
  "/mnt/grafana/entrypoint.sh",
];

const output = (result) => `${result.stdout}${result.stderr}`.trim();

export function checkCollectorConfig(ctx) {
  const result = runOnce({
    image: ctx.image("collector"),
    env: collectorEnv(ctx, "https://prometheus.example.test/api/v1/write"),
    args: ["validate", "--config=/etc/otelcol-contrib/config.yaml"],
  });
  ensure(result.status === 0, `otelcol validate failed:\n${output(result)}`);
}

export function checkShellScripts() {
  const mounts = [{ source: MONITORING, target: "/mnt" }];
  const lint = runOnce({ image: SHELLCHECK, mounts, args: ["--shell=sh", ...SCRIPTS] });
  ensure(lint.status === 0, `shellcheck found problems:\n${output(lint)}`);
  const format = runOnce({ image: SHFMT, mounts, args: ["-d", "-i", "2", ...SCRIPTS] });
  ensure(format.status === 0, `shfmt would change the scripts:\n${output(format)}`);
}

const PROMETHEUS_APP_CHECKS = [
  "/usr/local/bin/render-config.sh",
  "promtool check config /etc/prometheus/prometheus.yml",
  "promtool check rules /etc/prometheus/questify.rules.yml",
  "promtool test rules /etc/prometheus/questify.rules.test.yml",
  "amtool check-config /tmp/alertmanager.yml",
  "amtool config routes test --config.file=/tmp/alertmanager.yml --verify.receivers=page severity=page",
  "amtool config routes test --config.file=/tmp/alertmanager.yml --verify.receivers=warning severity=warning",
  "cmp /etc/prometheus/questify.rules.yml /alerts/questify.rules.yml",
  "command -v nc",
].join(" && ");

/** Rendered files, rules, rule unit tests, routes and the copy of the rules against the source in ops/alerts. */
export function checkPrometheusApp(ctx) {
  const result = runOnce({
    image: ctx.image("prometheus"),
    env: prometheusEnv(ctx, "smtp.example.test:587"),
    entrypoint: "/bin/sh",
    mounts: [
      { source: ALERTS, target: "/alerts" },
      {
        source: join(ALERTS, "questify.rules.test.yml"),
        target: "/etc/prometheus/questify.rules.test.yml",
      },
    ],
    args: ["-c", `set -e; ${PROMETHEUS_APP_CHECKS}`],
  });
  ensure(result.status === 0, `The Prometheus app's files failed a check:\n${output(result)}`);
}

/** A bad or missing setting stops the app, names the setting, and never prints its value. */
export function checkRenderRefusals(ctx) {
  const cases = [
    ["MONITORING_ENVIRONMENT", "Bad Environment!"],
    ["METRICS_PASSWORD", "too-short-secret"],
    ["ALERT_MAIL_TO", "not-an-address"],
    ["METRICS_PASSWORD_HASH", "plain-text-instead-of-a-hash"],
    ["ALERT_SMTP_HOST", "smtp.example.test"],
  ];
  for (const [name, value] of cases) {
    const result = runOnce({
      image: ctx.image("prometheus"),
      env: { ...prometheusEnv(ctx, "smtp.example.test:587"), [name]: value },
      args: [],
      entrypoint: "/usr/local/bin/render-config.sh",
    });
    ensure(result.status !== 0, `${name}=${value} was accepted.`);
    ensure(
      output(result).includes(name),
      `The refusal for ${name} does not name it:\n${output(result)}`,
    );
    ensure(!output(result).includes(value), `The refusal for ${name} printed its value.`);
  }
  const missing = { ...prometheusEnv(ctx, "smtp.example.test:587") };
  delete missing.ALERT_SMTP_PASSWORD;
  const result = runOnce({
    image: ctx.image("prometheus"),
    env: missing,
    entrypoint: "/usr/local/bin/render-config.sh",
  });
  ensure(
    result.status !== 0 && output(result).includes("ALERT_SMTP_PASSWORD"),
    "A missing setting did not stop the app.",
  );
}

/** The Grafana app stops on a missing setting, and does not print one it was given. */
export function checkGrafanaRefusals(ctx) {
  const env = { GF_SECURITY_ADMIN_PASSWORD: "short-secret-value" };
  const result = runOnce({ image: ctx.image("grafana"), env });
  const text = output(result);
  ensure(result.status !== 0, "Grafana started with an incomplete environment.");
  ensure(
    text.includes("GF_SECURITY_ADMIN_PASSWORD"),
    `The refusal does not name the setting:\n${text}`,
  );
  ensure(!text.includes("short-secret-value"), "The refusal printed the setting's value.");
}
