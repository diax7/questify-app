// Grafana stage of the monitoring validation: Grafana is reached through the app's public port under /grafana, login is
// required, the data source reaches Prometheus with its password, the dashboard is provisioned, and every query of every
// panel is accepted by Grafana and Prometheus.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STACK } from "./context.mjs";
import { inside, logsOf, waitFor } from "./docker.mjs";
import { basic, ensure, postJson, request, requestRawPath } from "./http.mjs";

const DASHBOARD_UID = "questify-slo";
const DATASOURCE_UID = "questify-prometheus";
const PREFIX = "/grafana";

/** Every query (`expr`) of every panel of the dashboard file, with the panel's title. */
export function dashboardQueries() {
  const dashboard = JSON.parse(
    readFileSync(join(STACK, "grafana", "dashboards", "questify-slo.json"), "utf8"),
  );
  return dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({ title: panel.title, ...target })),
  );
}

const get = (base, path, headers) => request(`${base}${PREFIX}${path}`, { headers });

async function checkSubPath(base) {
  const bare = await request(`${base}${PREFIX}`);
  ensure(
    bare.status === 302 && bare.location.startsWith(`${PREFIX}/`),
    `${PREFIX} was answered ${bare.status} ${bare.location}, not a redirect inside ${PREFIX}/.`,
  );
  const login = await get(base, "/login", {});
  ensure(login.status === 200, `The login page was answered ${login.status}.`);
  ensure(
    login.text.includes(`${PREFIX}/public/`),
    "The login page does not load its files from under /grafana/public/: Grafana is not serving from the sub-path.",
  );
}

async function checkLogin(base, admin) {
  for (const path of [
    "/api/user",
    "/api/datasources",
    `/api/dashboards/uid/${DASHBOARD_UID}`,
    "/api/search",
  ]) {
    const response = await get(base, path, {});
    ensure(
      response.status === 401,
      `Grafana answered ${response.status} to ${path} without a login, not 401.`,
    );
  }
  const metrics = await get(base, "/metrics", {});
  ensure(
    !metrics.text.includes("grafana_build_info"),
    `Grafana served its metrics at /metrics without a login (${metrics.status}).`,
  );
  const wrong = await get(base, "/api/user", { authorization: basic("admin", "not-the-password") });
  ensure(wrong.status === 401, `Grafana accepted a wrong password: ${wrong.status}.`);
  const right = await get(base, "/api/user", admin);
  ensure(right.status === 200, `Grafana refused the admin password: ${right.status}.`);
}

async function checkProvisioning(base, admin) {
  const sources = (await get(base, "/api/datasources", admin)).json();
  ensure(sources.length === 1, `Expected one data source, found ${sources.length}.`);
  const [source] = sources;
  ensure(
    source.uid === DATASOURCE_UID && source.type === "prometheus",
    "The data source is not the Prometheus one.",
  );
  ensure(
    source.isDefault && source.basicAuth,
    "The data source is not the default or does not use the password.",
  );
  const health = await get(base, `/api/datasources/uid/${DATASOURCE_UID}/health`, admin);
  ensure(
    health.status === 200,
    `The data source cannot reach Prometheus: ${health.status} ${health.text}`,
  );
  const found = (await get(base, "/api/search?query=Questify", admin)).json();
  ensure(
    found.some((item) => item.uid === DASHBOARD_UID),
    "The SLO dashboard was not provisioned.",
  );
}

async function runQuery(base, admin, query) {
  const target = {
    refId: "A",
    datasource: { type: "prometheus", uid: DATASOURCE_UID },
    expr: query.expr,
    instant: query.instant,
    range: query.range,
    intervalMs: 60_000,
    maxDataPoints: 500,
  };
  const response = await postJson(
    `${base}${PREFIX}/api/ds/query`,
    { queries: [target], from: "now-1h", to: "now" },
    admin,
  );
  const result = response.status === 200 ? response.json().results?.A : undefined;
  ensure(
    result !== undefined && result.error === undefined,
    `The query of "${query.title}" failed: ${response.text}`,
  );
}

/** Waits until Grafana answers its health page on its own port inside the container (Caddy does not pass that page on). */
export const waitForGrafana = (app) =>
  waitFor(
    "Grafana to start",
    async () => {
      inside(app.name, `wget -q -O /dev/null http://127.0.0.1:3000${PREFIX}/api/health`);
      return true;
    },
    { timeoutMs: 120_000 },
  );

/** Grafana's health page answers without a login and names its version, so Caddy answers 404 to it, however it is written. */
async function checkHealthPageBlocked(base, admin) {
  const paths = [
    "/api/health",
    "/api/health/",
    "//api/health",
    "/api/%68ealth",
    "/API/Health",
    "/api/health?x=1",
  ];
  for (const path of paths) {
    for (const headers of [{}, admin]) {
      const response = await get(base, path, headers);
      ensure(
        response.status === 404,
        `${PREFIX}${path} was answered ${response.status} through the app's port, not 404.`,
      );
    }
  }
}

/**
 * A path with a `.` or `..` segment, plain or with %2e or %2f, is refused (400) whatever it would clean to, so none
 * reaches Grafana's health page. Sent raw, because `fetch` would collapse the segments before sending.
 */
async function checkDotSegmentsRefused(stack, admin) {
  const paths = [
    "/api/x/../health",
    "/api/../api/health",
    "/api/%2e%2e/api/health",
    "/api/%2E%2E/api/health",
    "/api/x/.%2e/health",
    "/api/x/%2e./health",
    "/api/x/..%2fhealth",
    "/api/x/%2e%2e%2fhealth",
    "/api/health/..",
    "/./api/health",
    "//api/x/../health",
    "/../grafana/api/health",
  ];
  for (const path of paths) {
    for (const headers of [{}, admin]) {
      const { status } = await requestRawPath(stack.port, `${PREFIX}${path}`, headers);
      ensure(
        status === 400,
        `${PREFIX}${path} was answered ${status} through the app's port, not 400.`,
      );
    }
  }
}

/** Grafana is part of the running app: it must be up behind Caddy, log-in only, provisioned, and answer every query. */
export async function checkGrafana(ctx, stack) {
  const base = `http://127.0.0.1:${stack.port}`;
  await waitForGrafana(stack);
  const admin = { authorization: basic("admin", ctx.secrets.grafanaAdmin) };
  ensure(
    !logsOf(stack.name).includes("plugin.backgroundinstaller"),
    "Grafana is downloading plugins at start: GF_PLUGINS_PREINSTALL_DISABLED is not in force.",
  );
  await checkSubPath(base);
  await checkHealthPageBlocked(base, admin);
  await checkDotSegmentsRefused(stack, admin);
  await checkLogin(base, admin);
  await checkProvisioning(base, admin);
  const probe = { title: "a probe", expr: "vector(1)", instant: true, range: false };
  await waitFor(
    "Grafana's Prometheus plugin to answer",
    async () => (await runQuery(base, admin, probe), true),
  );
  const queries = dashboardQueries();
  ensure(queries.length >= 20, `The dashboard has only ${queries.length} queries.`);
  for (const query of queries) await runQuery(base, admin, query);
}
