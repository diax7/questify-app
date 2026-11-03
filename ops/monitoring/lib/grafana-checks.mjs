// Grafana stage of the monitoring validation: login is required, the data source reaches the Prometheus app with its
// password, the dashboard is provisioned, and every query of every panel is accepted by Grafana and Prometheus.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grafanaEnv, MONITORING } from "./context.mjs";
import { hostPort, start, waitFor } from "./docker.mjs";
import { basic, ensure, postJson, request } from "./http.mjs";

const DASHBOARD_UID = "questify-slo";
const DATASOURCE_UID = "questify-prometheus";

/** Every query (`expr`) of every panel of the dashboard file, with the panel's title. */
export function dashboardQueries() {
  const dashboard = JSON.parse(
    readFileSync(join(MONITORING, "grafana", "dashboards", "questify-slo.json"), "utf8"),
  );
  return dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => ({ title: panel.title, ...target })),
  );
}

async function get(base, path, headers) {
  return request(`${base}${path}`, { headers });
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
    `${base}/api/ds/query`,
    { queries: [target], from: "now-1h", to: "now" },
    admin,
  );
  const result = response.status === 200 ? response.json().results?.A : undefined;
  ensure(
    result !== undefined && result.error === undefined,
    `The query of "${query.title}" failed: ${response.text}`,
  );
}

export async function checkGrafana(ctx, stack) {
  const name = ctx.name("grafana");
  start({
    name,
    image: ctx.image("grafana"),
    network: ctx.network,
    env: grafanaEnv(ctx, `http://${stack.prometheusName}:9090`),
    publish: [3000],
  });
  const base = `http://127.0.0.1:${hostPort(name, 3000)}`;
  await waitFor(
    "Grafana to start",
    async () => (await get(base, "/api/health", {})).status === 200,
    {
      timeoutMs: 120_000,
    },
  );
  const admin = { authorization: basic("admin", ctx.secrets.grafanaAdmin) };
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
