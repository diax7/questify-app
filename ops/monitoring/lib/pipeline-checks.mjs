// The live stages of the monitoring validation: the app runs and receives OTLP the way the API sends it, through its one
// public port.
import { METRICS_USER, stackEnv, stackEnvWithoutEmail } from "./context.mjs";
import {
  docker,
  exitCodeOf,
  hostPort,
  inside,
  isRunning,
  logsOf,
  start,
  waitFor,
} from "./docker.mjs";
import { FORBIDDEN, metricsPayload, SERIES_LABELS, TARGET_INFO_LABELS } from "./fixtures.mjs";
import { waitForGrafana } from "./grafana-checks.mjs";
import { basic, ensure, postJson, request } from "./http.mjs";

const OTLP_PATH = "/api/v1/otlp/v1/metrics";
const authorization = (ctx) => ({
  authorization: basic(METRICS_USER, ctx.secrets.metricsPassword),
});
const url = (app, path) => `http://127.0.0.1:${app.port}${path}`;

/** Starts the app with `env` and waits until Prometheus behind it answers; returns its name and host port. */
export async function startApp(ctx, name, env) {
  start({ name, image: ctx.image, env, publish: [8080] });
  const app = { name, port: hostPort(name, 8080) };
  await waitFor("the app to be ready", async () => {
    const ready = await request(url(app, "/-/ready"), { headers: authorization(ctx) });
    return ready.status === 200;
  });
  return app;
}

/** The app with alert email configured (to a host nothing listens on). */
export const startStack = (ctx) =>
  startApp(ctx, ctx.name("stack"), stackEnv(ctx, "smtp.example.test:587"));

async function promJson(ctx, app, path) {
  const response = await request(url(app, path), { headers: authorization(ctx) });
  ensure(
    response.status === 200,
    `Prometheus answered ${response.status} to ${path}: ${response.text}`,
  );
  return response.json().data;
}

const matching = (selector) => `match[]=${encodeURIComponent(selector)}`;

const sendOtlp = (app, payload, headers) => postJson(url(app, OTLP_PATH), payload, headers);

// The ways a request may fail to carry the password. The empty password and the empty user are the ones a blank
// setting would produce.
const REFUSED_CREDENTIALS = (ctx) => [
  ["no credential", {}],
  ["a wrong password", { authorization: basic(METRICS_USER, "not-the-password") }],
  ["a wrong user", { authorization: basic("admin", ctx.secrets.metricsPassword) }],
  ["an empty password", { authorization: basic(METRICS_USER, "") }],
  ["an empty user", { authorization: basic("", ctx.secrets.metricsPassword) }],
  [
    "the password with a letter added",
    { authorization: basic(METRICS_USER, `${ctx.secrets.metricsPassword}x`) },
  ],
  ["the scheme without a credential", { authorization: "Basic" }],
  ["a credential that is not base64", { authorization: "Basic !!!not-base64!!!" }],
  ["the password as a bearer token", { authorization: `Bearer ${ctx.secrets.metricsPassword}` }],
];

/** The OTLP door: every request without the exact password is refused; with it the metrics are accepted. */
export async function checkIngestAuth(ctx, stack) {
  const instance = `validate-${ctx.runId}`;
  for (const [what, headers] of REFUSED_CREDENTIALS(ctx)) {
    const response = await sendOtlp(stack, metricsPayload(instance), headers);
    ensure(response.status === 401, `The app answered ${response.status} to ${what}, not 401.`);
  }
  const accepted = await sendOtlp(stack, metricsPayload(instance), authorization(ctx));
  ensure(accepted.status === 200, `The password was refused: ${accepted.status} ${accepted.text}`);
}

/** What is switched off: traces, remote write, the lifecycle and admin APIs; and the cap on a request's size. */
export async function checkClosedDoors(ctx, stack) {
  const post = (path, body) =>
    request(url(stack, path), { method: "POST", headers: authorization(ctx), body });
  const traces = await post("/api/v1/otlp/v1/traces", "{}");
  ensure(
    traces.status === 404,
    `A trace export was answered ${traces.status}, not 404: there is no trace store (the API runs with TELEMETRY_TRACE_RATIO=0).`,
  );
  const remoteWrite = await post("/api/v1/write", "");
  ensure(remoteWrite.status === 404, `Remote write was answered ${remoteWrite.status}, not 404.`);
  for (const path of ["/-/quit", "/-/reload"]) {
    const lifecycle = await post(path, "");
    ensure(lifecycle.status === 403, `${path} was answered ${lifecycle.status}, not 403.`);
  }
  const admin = await post("/api/v1/admin/tsdb/snapshot", "");
  ensure(admin.status >= 400, `The admin API answered ${admin.status}.`);
  const large = await request(url(stack, OTLP_PATH), {
    method: "POST",
    headers: { ...authorization(ctx), "content-type": "application/json" },
    body: "x".repeat(5 * 1024 * 1024),
  });
  ensure(large.status === 413, `A 5 MB body was answered ${large.status}, not 413.`);
}

/** Names and labels are the ones the alert rules use, and the stored labels are the API's closed list and no more. */
export async function checkStoredSeries(ctx, stack) {
  const selector = '{job="questify-api",__name__!="target_info"}';
  await waitFor("the API's series in Prometheus", async () => {
    const names = await promJson(ctx, stack, `/api/v1/label/__name__/values?${matching(selector)}`);
    return names.includes("questify_tick_last_run_seconds");
  });
  const names = await promJson(ctx, stack, `/api/v1/label/__name__/values?${matching(selector)}`);
  const wanted = [
    "http_server_request_duration_seconds_bucket",
    "http_server_request_duration_seconds_sum",
    "http_server_request_duration_seconds_count",
    "questify_log_events_total",
    "questify_outbound_requests_total",
    "questify_tick_last_run_seconds",
  ];
  for (const name of wanted)
    ensure(names.includes(name), `The series ${name} is missing; found ${names.join(", ")}.`);

  const series = await promJson(ctx, stack, `/api/v1/series?${matching(selector)}`);
  const extra = labelsOf(series).filter((label) => !SERIES_LABELS.includes(label));
  ensure(extra.length === 0, `Labels off the closed list were stored: ${extra.join(", ")}.`);
  const leValues = await promJson(
    ctx,
    stack,
    `/api/v1/label/le/values?${matching("http_server_request_duration_seconds_bucket")}`,
  );
  ensure(
    leValues.some((le) => le === "1" || le === "1.0"),
    `No bucket edge at exactly 1 s; found ${leValues.join(", ")}.`,
  );
  const info = await promJson(
    ctx,
    stack,
    `/api/v1/series?${matching('target_info{job="questify-api"}')}`,
  );
  ensure(info.length >= 1, "No target_info series arrived for the API.");
  const extraInfo = labelsOf(info).filter((label) => !TARGET_INFO_LABELS.includes(label));
  ensure(
    extraInfo.length === 0,
    `Resource attributes off the closed list were stored: ${extraInfo.join(", ")}.`,
  );
}

const labelsOf = (series) => [...new Set(series.flatMap((labels) => Object.keys(labels)))];

/**
 * The premise of ADR-626: Prometheus stores every attribute it is sent, so the API's closed list is the only filter. A
 * job of its own receives the attributes the API never records, and the label audit of the RUNBOOK (the label names of
 * a job's series against the closed list) must find them. If this fails because nothing was stored, a newer Prometheus
 * can drop them (`receive_relabel_configs`): use it, and change the ADR.
 */
export async function checkOffListIsStored(ctx, app) {
  const job = "questify-sentinel";
  const accepted = await sendOtlp(
    app,
    metricsPayload(`sentinel-${ctx.runId}`, { job, offList: true }),
    authorization(ctx),
  );
  ensure(accepted.status === 200, `The sentinel export was refused: ${accepted.status}.`);
  const series = await waitFor("the sentinel series", async () => {
    const found = await promJson(
      ctx,
      app,
      `/api/v1/series?${matching(`{job="${job}",__name__!="target_info"}`)}`,
    );
    return found.length > 0 ? found : undefined;
  });
  const audit = labelsOf(series).filter((label) => !SERIES_LABELS.includes(label));
  for (const key of ["user_email", "client_address", "url_full"]) {
    ensure(
      audit.includes(key),
      `Prometheus did not store the off-list attribute ${key} (found ${audit.join(", ") || "none"}): ADR-626's premise changed, see the message of this stage.`,
    );
  }
  const stored = JSON.stringify(series);
  ensure(
    FORBIDDEN.values.slice(0, 3).every((value) => stored.includes(value)),
    "The off-list values were not stored as the audit expects.",
  );
  const promoted = labelsOf(series).filter((label) => label === "host_name");
  ensure(promoted.length === 0, "A resource attribute was promoted to a label on every series.");
}

/** The rules are loaded and healthy, the Alertmanager is found, and Prometheus asks for the password. */
export async function checkPrometheus(ctx, stack) {
  const alerting = await waitFor("every rule to be evaluated", async () => {
    const data = await promJson(ctx, stack, "/api/v1/rules");
    const rules = data.groups
      .flatMap((group) => group.rules)
      .filter((rule) => rule.type === "alerting");
    return rules.length === 20 && rules.every((rule) => rule.health === "ok") ? rules : undefined;
  });
  ensure(alerting.length === 20, "Not all 20 alert rules are loaded.");
  await waitFor("the Alertmanager to be found", async () => {
    const data = await promJson(ctx, stack, "/api/v1/alertmanagers");
    return data.activeAlertmanagers.some((found) => found.url.includes("127.0.0.1:9093"));
  });
  await waitFor("both stack parts to be scraped", async () => {
    const data = await promJson(ctx, stack, `/api/v1/query?query=${encodeURIComponent("min(up)")}`);
    return data.result[0]?.value[1] === "1";
  });
  for (const [what, headers] of REFUSED_CREDENTIALS(ctx)) {
    for (const path of ["/api/v1/query?query=up", "/", "/-/healthy"]) {
      const response = await request(url(stack, path), { headers });
      ensure(
        response.status === 401,
        `Prometheus answered ${response.status} to ${path} with ${what}, not 401.`,
      );
    }
  }
}

/** The ports the app listens on: only Caddy's is open outside the machine; the container's health check passes. */
export async function checkListeners(stack) {
  await waitForGrafana(stack);
  const rows = inside(stack.name, "netstat -ltn")
    .split("\n")
    .filter((line) => line.startsWith("tcp"));
  const addresses = rows.map((row) => row.trim().split(/\s+/)[3]);
  const outside = addresses.filter((address) => !address.startsWith("127.0.0.1:"));
  ensure(
    outside.length > 0 && outside.every((address) => address.endsWith(":8080")),
    `Listening outside the machine: ${outside.join(", ")}; only :8080 is allowed.`,
  );
  for (const port of [9090, 9093, 3000]) {
    ensure(
      addresses.includes(`127.0.0.1:${port}`),
      `Nothing listens on 127.0.0.1:${port}; found ${addresses.join(", ")}.`,
    );
  }
  const test = JSON.parse(
    docker(["inspect", "--format", "{{json .Config.Healthcheck.Test}}", stack.name]).stdout,
  );
  const health = docker(["exec", stack.name, "/bin/sh", "-c", test[1]], { allowFailure: true });
  ensure(health.status === 0, `The health check command fails: ${test[1]}`);
}

export const PROGRAMS = ["alertmanager", "prometheus", "grafana", "caddy"];

/** Starts the app with email off (so it needs only the metrics and Grafana settings) and waits until all four programs run and Grafana has finished starting. */
export async function startVictim(ctx, program) {
  const app = await startApp(ctx, ctx.name(`victim-${program}`), stackEnvWithoutEmail(ctx));
  await waitForGrafana(app);
  await waitFor("all four programs to run", async () => {
    const found = docker(["exec", app.name, "/bin/sh", "-c", `pidof ${PROGRAMS.join(" ")}`], {
      allowFailure: true,
    });
    return found.status === 0 && found.stdout.trim().split(/\s+/).length >= PROGRAMS.length;
  });
  return app;
}

/**
 * Ends one program of the app with `signal` (TERM lets it exit by itself; KILL gives no chance to, which BusyBox's
 * `wait -n` did not notice): the entrypoint must stop the others and exit with an error so the platform restarts it,
 * within `timeoutMs`.
 */
export async function checkProgramDeath(
  app,
  program,
  { signal = "TERM", timeoutMs = 60_000 } = {},
) {
  inside(app.name, `kill -${signal} $(pidof ${program})`);
  await waitFor(
    `the container to stop within ${timeoutMs / 1000} s of ${program} getting ${signal}`,
    async () => !isRunning(app.name),
    { timeoutMs },
  );
  ensure(
    logsOf(app.name).includes(`${program} stopped; stopping the other programs`),
    `The entrypoint did not say that ${program} stopped.`,
  );
  const code = exitCodeOf(app.name);
  ensure(code === 1, `The container exited with ${code} after ${program} died, not 1.`);
}

/**
 * A start with a /data the container's user cannot write (a root-owned volume, the usual first-deploy mistake) must
 * end with status 1 and a message that names /data, not leave a half-working app. The memory file system is
 * root-owned and closed to other users (Docker's own default would be open to everyone).
 */
export async function checkUnwritableData(ctx) {
  const name = ctx.name("no-data");
  start({
    name,
    image: ctx.image,
    env: stackEnvWithoutEmail(ctx),
    tmpfs: ["/data:rw,mode=0755,uid=0"],
  });
  await waitFor("the container to stop without a writable /data", async () => !isRunning(name), {
    timeoutMs: 10_000,
  });
  const code = exitCodeOf(name);
  ensure(code === 1, `The container exited with ${code} without a writable /data, not 1.`);
  ensure(
    logsOf(name).includes("render-config: /data is not a directory"),
    "The refusal does not name /data.",
  );
  docker(["rm", "--force", name], { allowFailure: true });
}

/** A stop signal (a redeploy) stops every program and ends the container with status 0. */
export function checkGracefulStop(stack) {
  docker(["stop", "--time", "30", stack.name]);
  const code = exitCodeOf(stack.name);
  ensure(code === 0, `The container exited with ${code} after a stop signal, not 0.`);
  ensure(
    logsOf(stack.name).includes("stop signal received"),
    "The entrypoint did not log the stop signal.",
  );
}

/**
 * With alert email off (Q-581) the app starts from the metrics and Grafana settings alone, says so once, evaluates
 * every rule, finds its Alertmanager, takes an alert, and has no email integration that could send it.
 */
export async function checkNoEmailMode(ctx, app) {
  const said = logsOf(app.name)
    .split("\n")
    .filter((line) => line.includes("alert email off: no ALERT_SMTP_HOST"));
  ensure(said.length === 1, `The app said "alert email off" ${said.length} times, not once.`);
  await checkPrometheus(ctx, app);
  inside(
    app.name,
    "amtool --alertmanager.url=http://127.0.0.1:9093 alert add alertname=QuestifyNoEmailTest severity=page",
  );
  const received = await waitFor("the Alertmanager to hold the alert", async () =>
    inside(app.name, "wget -q -O - http://127.0.0.1:9093/api/v2/alerts").includes(
      "QuestifyNoEmailTest",
    ),
  );
  ensure(received, "The Alertmanager did not take the alert.");
  const metrics = inside(app.name, "wget -q -O - http://127.0.0.1:9093/metrics");
  ensure(
    /^alertmanager_integrations 0$/m.test(metrics),
    "The Alertmanager has a notification integration while alert email is off.",
  );
}
