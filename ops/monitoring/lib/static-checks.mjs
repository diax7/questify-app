// The first stage of the monitoring validation: every file is checked by the program that will read it, in the pinned
// image, before anything is started.
import { runOnce } from "./docker.mjs";
import {
  ALERTS,
  collectorEnv,
  MONITORING,
  prometheusEnv,
  prometheusEnvWithoutEmail,
} from "./context.mjs";
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
}

const EMAIL_SETTINGS = [
  "ALERT_SMTP_USER",
  "ALERT_SMTP_PASSWORD",
  "ALERT_MAIL_FROM",
  "ALERT_MAIL_TO",
];

/** Runs the render script with `env` and checks that it stops, names `names`, and prints no value of `env`. */
function ensureRenderRefused(ctx, env, names, what) {
  const result = runOnce({
    image: ctx.image("prometheus"),
    env,
    entrypoint: "/usr/local/bin/render-config.sh",
  });
  ensure(result.status !== 0, `${what}: the app started.`);
  for (const name of names) {
    ensure(output(result).includes(name), `${what}: the refusal does not name ${name}.`);
  }
  for (const value of Object.values(env)) {
    ensure(
      value === "" || !output(result).includes(value),
      `${what}: the refusal printed a setting's value.`,
    );
  }
}

/** With the email host set, all five settings are required; a lone email setting without the host is refused too. */
export function checkPartialEmailRefusals(ctx) {
  const full = prometheusEnv(ctx, "smtp.example.test:587");
  for (const name of EMAIL_SETTINGS) {
    const rest = Object.fromEntries(Object.entries(full).filter(([key]) => key !== name));
    ensureRenderRefused(ctx, rest, [name], `${name} missing`);
    ensureRenderRefused(ctx, { ...rest, [name]: "" }, [name], `${name} empty`);
  }
  for (const name of EMAIL_SETTINGS) {
    const lone = { ...prometheusEnvWithoutEmail(ctx), [name]: full[name] };
    ensureRenderRefused(ctx, lone, ["ALERT_SMTP_HOST", name], `${name} without the host`);
  }
}

const NO_EMAIL_CHECKS = [
  "/usr/local/bin/render-config.sh",
  "amtool check-config /tmp/alertmanager.yml",
  "amtool config routes test --config.file=/tmp/alertmanager.yml --verify.receivers=discard severity=page",
  "amtool config routes test --config.file=/tmp/alertmanager.yml --verify.receivers=discard severity=warning",
  "test -s /tmp/web.yml",
  "test -s /tmp/metrics-password",
  "test ! -e /tmp/smtp-password",
].join(" && ");

/** With the host unset or empty, only the two metrics settings are needed, and the Alertmanager's file loads and sends nothing. */
export function checkNoEmailRender(ctx) {
  const cases = [
    ["no ALERT_* setting", {}],
    ["an empty host", { ALERT_SMTP_HOST: "" }],
    [
      "all five empty",
      Object.fromEntries(["ALERT_SMTP_HOST", ...EMAIL_SETTINGS].map((name) => [name, ""])),
    ],
  ];
  for (const [what, extra] of cases) {
    const result = runOnce({
      image: ctx.image("prometheus"),
      env: { ...prometheusEnvWithoutEmail(ctx), ...extra },
      entrypoint: "/bin/sh",
      args: ["-c", `set -e; ${NO_EMAIL_CHECKS}`],
    });
    ensure(result.status === 0, `Alert email off (${what}) failed a check:\n${output(result)}`);
    const said = output(result)
      .split("\n")
      .filter((line) => line.includes("alert email off: no ALERT_SMTP_HOST"));
    ensure(said.length === 1, `Alert email off (${what}) said so ${said.length} times, not once.`);
  }
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
