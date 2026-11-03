// The first stage of the monitoring validation: every file is checked by the program that will read it, in the built
// image, before anything is started.
import { runOnce } from "./docker.mjs";
import { ALERTS, MONITORING, stackEnv, stackEnvWithoutEmail } from "./context.mjs";
import { ensure } from "./http.mjs";
import { join } from "node:path";

// Pinned by tag and digest like the app's base images; raise on purpose.
const SHELLCHECK =
  "koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d";
const SHFMT =
  "mvdan/shfmt:v3.14.1@sha256:8c06884a35683d8763fba6c0d9484d11a61a96da65f8d497d6f625825a6043f2";
const SCRIPTS = ["/mnt/stack/entrypoint.sh", "/mnt/stack/render-config.sh"];

const output = (result) => `${result.stdout}${result.stderr}`.trim();
const EMAIL_SMTP = "smtp.example.test:587";

export function checkShellScripts() {
  const mounts = [{ source: MONITORING, target: "/mnt" }];
  const lint = runOnce({ image: SHELLCHECK, mounts, args: ["--shell=sh", ...SCRIPTS] });
  ensure(lint.status === 0, `shellcheck found problems:\n${output(lint)}`);
  const format = runOnce({ image: SHFMT, mounts, args: ["-d", "-i", "2", ...SCRIPTS] });
  ensure(format.status === 0, `shfmt would change the scripts:\n${output(format)}`);
}

const STACK_CHECKS = [
  "/usr/local/bin/render-config.sh",
  "promtool check config /etc/prometheus/prometheus.yml",
  "promtool check rules /etc/prometheus/questify.rules.yml",
  "promtool test rules /etc/prometheus/questify.rules.test.yml",
  "amtool check-config /tmp/alertmanager.yml",
  "amtool config routes test --config.file=/tmp/alertmanager.yml --verify.receivers=page severity=page",
  "amtool config routes test --config.file=/tmp/alertmanager.yml --verify.receivers=warning severity=warning",
  "cmp /etc/prometheus/questify.rules.yml /alerts/questify.rules.yml",
  "caddy validate --config /etc/questify/Caddyfile --adapter caddyfile",
  "test -z \"$(caddy fmt --diff /etc/questify/Caddyfile | grep -E '^[+-]')\"",
  "command -v nc",
].join(" && ");

/** Rendered files, rules, rule unit tests, routes, the Caddyfile and the copy of the rules against the source in ops/alerts. */
export function checkStackFiles(ctx) {
  const result = runOnce({
    image: ctx.image,
    env: stackEnv(ctx, EMAIL_SMTP),
    entrypoint: "/bin/sh",
    mounts: [
      { source: ALERTS, target: "/alerts" },
      {
        source: join(ALERTS, "questify.rules.test.yml"),
        target: "/etc/prometheus/questify.rules.test.yml",
      },
    ],
    args: ["-c", `set -e; ${STACK_CHECKS}`],
  });
  ensure(result.status === 0, `The app's files failed a check:\n${output(result)}`);
}

/** Runs the render script with `env` and checks that it stops, names `names`, and prints no value of `env`. */
function ensureRenderRefused(ctx, env, names, what) {
  const result = runOnce({
    image: ctx.image,
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

/** A bad or missing setting stops the app, names the setting, and never prints its value. */
export function checkRenderRefusals(ctx) {
  const full = stackEnv(ctx, EMAIL_SMTP);
  const bad = [
    ["MONITORING_ENVIRONMENT", "Bad Environment!"],
    ["METRICS_PASSWORD", "too-short-secret"],
    ["METRICS_PASSWORD", `${ctx.secrets.metricsPassword}\nsecond-line`],
    ["ALERT_MAIL_TO", "not-an-address"],
    ["METRICS_PASSWORD_HASH", "plain-text-instead-of-a-hash"],
    ["ALERT_SMTP_HOST", "smtp.example.test"],
    ["GF_SECURITY_ADMIN_PASSWORD", "short-secret-value"],
    ["GF_SECURITY_SECRET_KEY", "short-key-value"],
    ["GF_SERVER_ROOT_URL", "https://monitoring.example.test/"],
    ["GF_SERVER_ROOT_URL", "http://monitoring.example.test/grafana/"],
  ];
  for (const [name, value] of bad) {
    ensureRenderRefused(ctx, { ...full, [name]: value }, [name], `${name}=${value.slice(0, 20)}`);
  }
  for (const name of [
    "METRICS_PASSWORD",
    "METRICS_PASSWORD_HASH",
    "GF_SECURITY_ADMIN_PASSWORD",
    "GF_SECURITY_SECRET_KEY",
    "GF_SERVER_ROOT_URL",
  ]) {
    const rest = Object.fromEntries(Object.entries(full).filter(([key]) => key !== name));
    ensureRenderRefused(ctx, rest, [name], `${name} missing`);
  }
}

const EMAIL_SETTINGS = [
  "ALERT_SMTP_USER",
  "ALERT_SMTP_PASSWORD",
  "ALERT_MAIL_FROM",
  "ALERT_MAIL_TO",
];

/** With the email host set, all five settings are required; a lone email setting without the host is refused too. */
export function checkPartialEmailRefusals(ctx) {
  const full = stackEnv(ctx, EMAIL_SMTP);
  for (const name of EMAIL_SETTINGS) {
    const rest = Object.fromEntries(Object.entries(full).filter(([key]) => key !== name));
    ensureRenderRefused(ctx, rest, [name], `${name} missing`);
    ensureRenderRefused(ctx, { ...rest, [name]: "" }, [name], `${name} empty`);
  }
  for (const name of EMAIL_SETTINGS) {
    const lone = { ...stackEnvWithoutEmail(ctx), [name]: full[name] };
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

/** With the host unset or empty, only the metrics and Grafana settings are needed, and the Alertmanager's file loads and sends nothing. */
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
      image: ctx.image,
      env: { ...stackEnvWithoutEmail(ctx), ...extra },
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
