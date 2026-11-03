// The live stage of the monitoring validation: the Prometheus app and the collector run on a private network and
// receive OTLP the way the API sends it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectorEnv, MONITORING, prometheusEnv } from "./context.mjs";
import { hostPort, isRunning, logsOf, start, waitFor, docker } from "./docker.mjs";
import { FORBIDDEN, metricsPayload, tracesPayload } from "./fixtures.mjs";
import { basic, ensure, postJson, rawStatus, request } from "./http.mjs";

const COLLECTOR_OVERRIDE = `# Test only: plain http inside the private network, and the traces printed so their attributes can be read.
exporters:
  prometheus_remote_write:
    http:
      tls:
        insecure: true
  debug:
    verbosity: detailed
service:
  pipelines:
    traces:
      exporters: [debug]
`;

/** The attribute keys the collector's config keeps on data points, read from the file the app ships. */
export function allowedKeys() {
  const text = readFileSync(join(MONITORING, "collector", "config.yaml"), "utf8");
  const list = /keep_keys\(datapoint\.attributes, \[([^\]]*)\]\)/.exec(text)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const authorization = (ctx) => ({
  authorization: basic("questify-metrics", ctx.secrets.metricsPassword),
});

/** Starts the Prometheus app, then the collector in front of it, and returns their host ports. */
export async function startStack(ctx) {
  const prometheusName = ctx.name("prometheus");
  start({
    name: prometheusName,
    image: ctx.image("prometheus"),
    network: ctx.network,
    env: prometheusEnv(ctx, "smtp.example.test:587"),
    publish: [9090],
  });
  const prometheusPort = hostPort(prometheusName, 9090);
  await waitFor("Prometheus to be ready", async () => {
    const ready = await request(`http://127.0.0.1:${prometheusPort}/-/ready`, {
      headers: authorization(ctx),
    });
    return ready.status === 200;
  });
  const directory = mkdtempSync(join(tmpdir(), "questify-collector-"));
  writeFileSync(join(directory, "override.yaml"), COLLECTOR_OVERRIDE);
  const collectorName = ctx.name("collector");
  start({
    name: collectorName,
    image: ctx.image("collector"),
    network: ctx.network,
    env: collectorEnv(ctx, `http://${prometheusName}:9090/api/v1/write`),
    publish: [4318],
    mounts: [{ source: directory, target: "/override" }],
    args: ["--config=/etc/otelcol-contrib/config.yaml", "--config=/override/override.yaml"],
  });
  const collectorPort = hostPort(collectorName, 4318);
  await waitFor(
    "the collector to listen",
    async () => (await rawStatus(collectorPort, "")) === 401,
  );
  rmSync(directory, { recursive: true, force: true });
  return { prometheusName, prometheusPort, collectorName, collectorPort };
}

/** A token the collector does not know, or none, opens nothing; both configured tokens open it. */
export async function checkIngestAuth(ctx, stack) {
  const url = `http://127.0.0.1:${stack.collectorPort}/v1/metrics`;
  const instance = `validate-${ctx.runId}`;
  const refused = [
    ["no token", {}],
    ["a wrong token", { authorization: "Bearer not-the-token" }],
    ["the scheme without a token", { authorization: "Bearer" }],
    ["a token in the wrong scheme", { authorization: `Basic ${ctx.secrets.tokenA}` }],
  ];
  for (const [what, headers] of refused) {
    const response = await postJson(url, metricsPayload(instance), headers);
    ensure(
      response.status === 401,
      `The collector answered ${response.status} to ${what}, not 401.`,
    );
  }
  const tokenAnswer = await postJson(url, metricsPayload(instance), {
    authorization: `Bearer ${ctx.secrets.tokenA}`,
  });
  ensure(
    tokenAnswer.status === 200,
    `Token A was refused: ${tokenAnswer.status} ${tokenAnswer.text}`,
  );
  const traces = await postJson(
    `http://127.0.0.1:${stack.collectorPort}/v1/traces`,
    tracesPayload(instance),
    {
      authorization: `Bearer ${ctx.secrets.tokenB}`,
    },
  );
  ensure(traces.status === 200, `Token B was refused: ${traces.status} ${traces.text}`);
}

/** A token slot left empty must not open the door to a request that carries no token. */
export async function checkEmptyTokenSlot(ctx, stack) {
  const name = ctx.name("collector-empty-slot");
  start({
    name,
    image: ctx.image("collector"),
    network: ctx.network,
    env: {
      ...collectorEnv(ctx, `http://${stack.prometheusName}:9090/api/v1/write`),
      OTEL_INGEST_TOKEN_B: "",
    },
    publish: [4318],
  });
  const port = hostPort(name, 4318);
  await waitFor("the second collector to listen", async () => (await rawStatus(port, "")) === 401);
  for (const line of [
    "Authorization: Bearer ",
    "Authorization: Bearer",
    "Authorization:",
    "Authorization: ",
  ]) {
    const status = await rawStatus(port, line);
    ensure(status === 401, `With an empty token slot, "${line}" was answered ${status}, not 401.`);
  }
  const good = await rawStatus(port, `Authorization: Bearer ${ctx.secrets.tokenA}`);
  ensure(good === 200, `With an empty token slot, the other token was answered ${good}.`);
}

const promUrl = (stack, path) => `http://127.0.0.1:${stack.prometheusPort}${path}`;

async function promJson(ctx, stack, path) {
  const response = await request(promUrl(stack, path), { headers: authorization(ctx) });
  ensure(
    response.status === 200,
    `Prometheus answered ${response.status} to ${path}: ${response.text}`,
  );
  return response.json().data;
}

const matching = (selector) => `match[]=${encodeURIComponent(selector)}`;

/** Names and labels are the ones the alert rules use, and only the closed list of attributes arrived. */
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

  const permitted = new Set([
    ...allowedKeys().map((key) => key.replaceAll(".", "_")),
    "__name__",
    "job",
    "instance",
    "le",
  ]);
  const series = await promJson(ctx, stack, `/api/v1/series?${matching(selector)}`);
  const seen = new Set(series.flatMap((labels) => Object.keys(labels)));
  const extra = [...seen].filter((label) => !permitted.has(label));
  ensure(extra.length === 0, `Labels off the closed list reached Prometheus: ${extra.join(", ")}.`);
  const stored = JSON.stringify(series);
  for (const value of FORBIDDEN.values)
    ensure(!stored.includes(value), `A forbidden value reached Prometheus: ${value}.`);

  const leValues = await promJson(
    ctx,
    stack,
    `/api/v1/label/le/values?${matching("http_server_request_duration_seconds_bucket")}`,
  );
  ensure(
    leValues.some((le) => le === "1" || le === "1.0"),
    `No bucket edge at exactly 1 s; found ${leValues.join(", ")}.`,
  );
  await checkTargetInfo(ctx, stack);
}

async function checkTargetInfo(ctx, stack) {
  const series = await promJson(
    ctx,
    stack,
    `/api/v1/series?${matching('target_info{job="questify-api"}')}`,
  );
  ensure(series.length >= 1, "No target_info series arrived for the API.");
  const permitted = new Set([
    "__name__",
    "job",
    "instance",
    "service_version",
    "deployment_environment_name",
  ]);
  const extra = series
    .flatMap((labels) => Object.keys(labels))
    .filter((label) => !permitted.has(label));
  ensure(
    extra.length === 0,
    `Resource attributes off the closed list reached target_info: ${extra.join(", ")}.`,
  );
}

/** Traces are printed by the test override; none of what the API never records may be in them. */
export function checkTracesOutput(stack) {
  const logs = logsOf(stack.collectorName);
  ensure(logs.includes("/v1/health"), "The span did not come out of the traces pipeline.");
  for (const key of [...FORBIDDEN.keys, "scope.secret"]) {
    ensure(!logs.includes(key), `The attribute ${key} came out of the traces pipeline.`);
  }
  for (const value of FORBIDDEN.values)
    ensure(!logs.includes(value), `The value ${value} came out of the traces pipeline.`);
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
  for (const [what, headers] of [
    ["no password", {}],
    ["a wrong password", { authorization: basic("questify-metrics", "not-the-password") }],
    ["a wrong user", { authorization: basic("admin", ctx.secrets.metricsPassword) }],
  ]) {
    const response = await request(promUrl(stack, "/api/v1/query?query=up"), { headers });
    ensure(response.status === 401, `Prometheus answered ${response.status} to ${what}, not 401.`);
  }
  const write = await request(promUrl(stack, "/api/v1/write"), { method: "POST" });
  ensure(
    write.status === 401,
    `Remote write answered ${write.status} without a password, not 401.`,
  );
}

/** The Alertmanager listens on the loopback only, and the container's own health check (an open port) passes. */
export function checkListeners(stack) {
  const listening = docker(["exec", stack.prometheusName, "/bin/sh", "-c", "netstat -ltn"]).stdout;
  ensure(
    /127\.0\.0\.1:9093\s/.test(listening),
    "The Alertmanager is not listening on 127.0.0.1:9093.",
  );
  ensure(
    !/(0\.0\.0\.0|:::|\[::\]):9093\s/.test(listening),
    "The Alertmanager listens on more than the loopback.",
  );
  const health = docker(["exec", stack.prometheusName, "nc", "-z", "127.0.0.1", "9090"], {
    allowFailure: true,
  });
  ensure(health.status === 0, "The health check command (nc -z 127.0.0.1 9090) fails.");
}

/** The Alertmanager is not part of the public surface, and its death takes the container down so CranL restarts it. */
export async function checkSupervisor(stack) {
  docker(["exec", stack.prometheusName, "/bin/sh", "-c", "kill $(pidof alertmanager)"]);
  await waitFor(
    "the container to stop after the Alertmanager died",
    async () => !isRunning(stack.prometheusName),
  );
  ensure(
    logsOf(stack.prometheusName).includes("the Alertmanager stopped"),
    "The entrypoint did not say why it stopped.",
  );
}
