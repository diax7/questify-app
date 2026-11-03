import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ATTRIBUTE_RULES, RESOURCE_KEYS } from "#src/telemetry/attributes";
import { METRICS } from "#src/telemetry/instruments";

/**
 * Structural checks of the monitoring stack's files (T-018b, ADR-620 to ADR-625): no Docker, no network. What the
 * programs make of the files is `pnpm monitoring:validate`, which starts the stack; these checks keep the files in
 * step with the API's code and with the RUNBOOK.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

type Group = Readonly<{ context: string; statements: readonly string[] }>;
type Config = Readonly<{
  extensions: Record<string, { tokens?: string[]; client_auth?: { password: string } }>;
  receivers: { otlp: { protocols: { http: { auth: { authenticator: string } } } } };
  processors: Record<
    string,
    { error_mode?: string; metric_statements?: Group[]; trace_statements?: Group[] }
  >;
  exporters: Record<string, { translation_strategy?: string; http?: { endpoint: string } }>;
  service: { pipelines: Record<string, { processors: string[]; exporters: string[] }> };
}>;

const collectorText = read("ops/monitoring/collector/config.yaml");
const collector = parse(collectorText) as Config;
const transform = collector.processors["transform/closed_attributes"];

/** The keys named by the `keep_keys(<path>, [...])` statements of a group, by path. */
function keptKeys(group: Group): Record<string, string[]> {
  const kept: Record<string, string[]> = {};
  for (const statement of group.statements) {
    const match = /^keep_keys\(([a-z_.]+), \[([^\]]*)\]\)$/.exec(statement);
    if (match?.[1] !== undefined) {
      kept[match[1]] = [...(match[2] ?? "").matchAll(/"([^"]+)"/g)].map((key) => key[1] ?? "");
    }
  }
  return kept;
}

const groupOf = (groups: readonly Group[] | undefined, context: string): Group => {
  const found = groups?.filter((group) => group.context === context) ?? [];
  expect(found, `one ${context} group`).toHaveLength(1);
  return found[0] as Group;
};

describe("the collector keeps only the closed list of attributes (ADR-603, defence in depth)", () => {
  const recorded = Object.keys(ATTRIBUTE_RULES).toSorted();

  it("runs the keep statements as groups of one context each, and fails closed", () => {
    expect(transform?.error_mode).toBe("propagate");
    for (const groups of [transform?.metric_statements, transform?.trace_statements]) {
      expect(groups?.length).toBeGreaterThan(0);
      for (const group of groups ?? []) {
        expect(["resource", "scope", "datapoint", "exemplar", "span", "spanevent"]).toContain(
          group.context,
        );
        for (const statement of group.statements) {
          expect(statement, group.context).toMatch(new RegExp(`\\(${group.context}\\.`));
        }
      }
    }
  });

  it("lists exactly the attributes the API may record on data points and spans", () => {
    const datapoint = keptKeys(groupOf(transform?.metric_statements, "datapoint"));
    const span = keptKeys(groupOf(transform?.trace_statements, "span"));
    expect(datapoint["datapoint.attributes"]?.toSorted()).toEqual(recorded);
    expect(span["span.attributes"]?.toSorted()).toEqual(recorded);
  });

  it("lists exactly the resource attributes the API sets, and nothing on the scope, exemplars or events", () => {
    for (const groups of [transform?.metric_statements, transform?.trace_statements]) {
      const resource = keptKeys(groupOf(groups, "resource"));
      expect(resource["resource.attributes"]?.toSorted()).toEqual([...RESOURCE_KEYS].toSorted());
      expect(keptKeys(groupOf(groups, "scope"))["scope.attributes"]).toEqual([]);
    }
    expect(keptKeys(groupOf(transform?.metric_statements, "exemplar"))).toEqual({
      "exemplar.filtered_attributes": [],
    });
    expect(keptKeys(groupOf(transform?.trace_statements, "spanevent"))).toEqual({
      "spanevent.attributes": [],
    });
    expect(groupOf(transform?.trace_statements, "span").statements).toContain(
      'set(span.status.message, "")',
    );
  });

  it("runs the filter right after the memory limiter and before anything is exported", () => {
    for (const pipeline of Object.values(collector.service.pipelines)) {
      expect(pipeline.processors).toEqual([
        "memory_limiter",
        "transform/closed_attributes",
        "batch",
      ]);
    }
    expect(collector.service.pipelines["metrics"]?.exporters).toEqual(["prometheus_remote_write"]);
    expect(collector.service.pipelines["traces"]?.exporters).toEqual(["nop"]);
  });
});

describe("the collector's doors", () => {
  it("asks for a bearer token on the receiver, from two environment variables", () => {
    expect(collector.receivers.otlp.protocols.http.auth.authenticator).toBe(
      "bearertokenauth/ingest",
    );
    expect(collector.extensions["bearertokenauth/ingest"]?.tokens).toEqual([
      "${env:OTEL_INGEST_TOKEN_A}",
      "${env:OTEL_INGEST_TOKEN_B}",
    ]);
  });

  it("holds no secret and no address: they come from the environment", () => {
    expect(collector.extensions["basicauth/metrics_store"]?.client_auth?.password).toBe(
      "${env:METRICS_PASSWORD}",
    );
    expect(collector.exporters["prometheus_remote_write"]?.http?.endpoint).toBe(
      "${env:PROMETHEUS_REMOTE_WRITE_URL}",
    );
    expect(collectorText).not.toMatch(/insecure:\s*true/);
  });

  it("spells names the way the alert rules do", () => {
    expect(collector.exporters["prometheus_remote_write"]?.translation_strategy).toBe(
      "UnderscoreEscapingWithSuffixes",
    );
  });
});

describe("the images", () => {
  const dockerfiles = ["collector", "prometheus", "grafana"].map((app) => [
    app,
    read(`ops/monitoring/${app}/Dockerfile`),
  ]);

  it("are pinned by version and by digest", () => {
    for (const [app, text] of dockerfiles) {
      const bases = [...(text ?? "").matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] ?? "");
      expect(bases.length, app).toBeGreaterThan(0);
      for (const base of bases) {
        expect(base, app).toMatch(/^[a-z0-9./-]+:v?\d+(\.\d+)+@sha256:[0-9a-f]{64}$/);
      }
    }
  });

  it("are the tools of the validation, pinned in the same way", () => {
    const pinned = [
      ...read("ops/monitoring/lib/static-checks.mjs").matchAll(
        /"([a-z/]+:v[\d.]+@sha256:[0-9a-f]{64})"/g,
      ),
      ...read("ops/monitoring/lib/context.mjs").matchAll(
        /"(httpd:[\d.]+-alpine@sha256:[0-9a-f]{64})"/g,
      ),
    ];
    expect(pinned).toHaveLength(3);
  });
});

describe("the Prometheus app", () => {
  const entrypoint = read("ops/monitoring/prometheus/entrypoint.sh");
  const dockerfile = read("ops/monitoring/prometheus/Dockerfile");
  const prometheus = parse(read("ops/monitoring/prometheus/prometheus.yml")) as {
    rule_files: string[];
    alerting: { alertmanagers: Array<{ static_configs: Array<{ targets: string[] }> }> };
  };
  const alertmanager = parse(read("ops/monitoring/prometheus/alertmanager.yml.in")) as {
    route: { receiver: string; routes: Array<{ matchers: string[]; receiver: string }> };
    receivers: Array<{ name: string }>;
  };

  it("loads a copy of the alert rules that is the file in ops/alerts", () => {
    expect(read("ops/monitoring/prometheus/questify.rules.yml")).toBe(
      read("ops/alerts/questify.rules.yml"),
    );
    expect(prometheus.rule_files).toEqual(["/etc/prometheus/questify.rules.yml"]);
    expect(dockerfile).toContain("COPY prometheus.yml questify.rules.yml /etc/prometheus/");
  });

  it("keeps the Alertmanager on this machine, and everything else behind the password", () => {
    expect(entrypoint).toContain("--web.listen-address=127.0.0.1:9093");
    expect(prometheus.alerting.alertmanagers[0]?.static_configs[0]?.targets).toEqual([
      "127.0.0.1:9093",
    ]);
    expect(entrypoint).toContain("--web.config.file=/tmp/web.yml");
    expect(entrypoint).toContain("--web.enable-remote-write-receiver");
    expect(entrypoint).not.toContain("--web.enable-admin-api");
    expect(entrypoint).not.toContain("--web.enable-lifecycle");
  });

  it("pins the look-back the loop alerts depend on, and keeps the 30-day window within the disk", () => {
    expect(entrypoint).toContain("--query.lookback-delta=5m");
    expect(entrypoint).toContain("--storage.tsdb.retention.time=30d");
    expect(entrypoint).toContain("--storage.tsdb.retention.size=4GB");
  });

  it("sends every severity the rules use to a receiver", () => {
    const severities = new Set(
      (
        parse(read("ops/alerts/questify.rules.yml")) as {
          groups: Array<{ rules: Array<{ labels: { severity: string } }> }>;
        }
      ).groups
        .flatMap((group) => group.rules)
        .map((rule) => rule.labels.severity),
    );
    const routed = alertmanager.route.routes.map((route) => route.matchers.join());
    const known = [...severities].filter(
      (severity) => severity === "warning" || routed.includes(`severity="${severity}"`),
    );
    expect(known.toSorted()).toEqual([...severities].toSorted());
    expect(alertmanager.route.receiver).toBe("warning");
    for (const route of alertmanager.route.routes) {
      expect(alertmanager.receivers.map((receiver) => receiver.name)).toContain(route.receiver);
    }
  });

  it("mails the runbook link and the environment, and holds no address or secret itself", () => {
    const template = read("ops/monitoring/prometheus/questify.email.tmpl.in");
    expect(template).toContain(".Annotations.runbook");
    expect(template).toContain("@MONITORING_ENVIRONMENT@");
    const config = read("ops/monitoring/prometheus/alertmanager.yml.in");
    for (const name of ["ALERT_SMTP_HOST", "ALERT_SMTP_USER", "ALERT_MAIL_FROM", "ALERT_MAIL_TO"]) {
      expect(config).toContain(`@${name}@`);
    }
    expect(config).toContain("smtp_auth_password_file: /tmp/smtp-password");
    expect(config).toContain("smtp_require_tls: true");
  });
});

describe("Grafana", () => {
  const dockerfile = read("ops/monitoring/grafana/Dockerfile");
  const dashboard = JSON.parse(read("ops/monitoring/grafana/dashboards/questify-slo.json")) as {
    uid: string;
    editable: boolean;
    panels: Array<{ title: string; description?: string; targets?: Array<{ expr: string }> }>;
  };

  it("needs a login, offers no sign-up and calls nobody outside", () => {
    for (const setting of [
      "GF_AUTH_ANONYMOUS_ENABLED=false",
      "GF_USERS_ALLOW_SIGN_UP=false",
      "GF_SECURITY_COOKIE_SECURE=true",
      "GF_ANALYTICS_REPORTING_ENABLED=false",
      "GF_ANALYTICS_CHECK_FOR_UPDATES=false",
      "GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false",
    ]) {
      expect(dockerfile).toContain(setting);
    }
    expect(dockerfile).not.toMatch(/GF_SECURITY_(ADMIN_PASSWORD|SECRET_KEY)=/);
  });

  it("reads the data source's address and password from the environment", () => {
    const text = read("ops/monitoring/grafana/provisioning/datasources/prometheus.yml");
    expect(text).toContain("url: ${PROMETHEUS_URL}");
    expect(text).toContain("basicAuthPassword: ${METRICS_PASSWORD}");
  });

  it("has a dashboard that is read-only and asks only for series that exist", () => {
    expect(dashboard.uid).toBe("questify-slo");
    expect(dashboard.editable).toBe(false);
    const recorded = new Set<string>();
    for (const metric of Object.values(METRICS)) {
      const base = `${metric.name.replaceAll(".", "_")}${metric.unit === "s" ? "_seconds" : ""}`;
      if (metric.kind === "counter") recorded.add(`${base}_total`);
      if (metric.kind === "gauge") recorded.add(base);
      if (metric.kind === "histogram")
        for (const part of ["bucket", "sum", "count"]) recorded.add(`${base}_${part}`);
    }
    const expressions = dashboard.panels.flatMap((panel) =>
      (panel.targets ?? []).map((target) => target.expr),
    );
    expect(expressions.length).toBeGreaterThanOrEqual(20);
    for (const expr of expressions) {
      const bare = expr.replace(/\{[^}]*\}/g, "").replace(/\b(?:by|on)\s*\([^)]*\)/g, "");
      const names =
        bare.match(/\b(?:http_server|questify|prometheus|alertmanager)_[a-z0-9_]+/g) ?? [];
      for (const name of names) {
        expect(
          recorded.has(name) || /^(prometheus|alertmanager)_/.test(name),
          `${name} in ${expr}`,
        ).toBe(true);
      }
    }
  });

  it("shows every service level that has a measure", () => {
    const text = JSON.stringify(dashboard);
    for (const objective of ["SLO-1", "SLO-2", "SLO-3", "SLO-4", "SLO-7", "SLO-8"]) {
      expect(text, objective).toContain(objective);
    }
  });
});

describe("the runbook", () => {
  const runbook = read("docs/RUNBOOK.md");
  const start = runbook.indexOf("## Monitoring stack on CranL");
  const end = runbook.indexOf("\n## ", start + 5);
  const section = start < 0 ? "" : runbook.slice(start, end < 0 ? undefined : end);

  /** Setting names an app reads: `${env:NAME}` in the collector, `check NAME` in the shell scripts, `${NAME}` in Grafana. */
  function settingsOf(): string[] {
    const names = new Set<string>();
    const add = (text: string, pattern: RegExp): void => {
      for (const match of text.matchAll(pattern)) names.add(match[1] ?? "");
    };
    add(collectorText, /\$\{env:([A-Z_]+)\}/g);
    add(read("ops/monitoring/prometheus/render-config.sh"), /^check ([A-Z_]+) /gm);
    add(read("ops/monitoring/grafana/entrypoint.sh"), /^check ([A-Z_]+) /gm);
    add(read("ops/monitoring/grafana/provisioning/datasources/prometheus.yml"), /\$\{([A-Z_]+)\}/g);
    return [...names].toSorted();
  }

  it("has the section", () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toContain("### The three apps");
    expect(section).toContain("### Pointing the API at it");
    expect(section).toContain("### Rotating the ingest token");
    expect(section).toContain("### Retention and backups");
  });

  it("names every setting the three apps read, and the API's telemetry settings", () => {
    const settings = settingsOf();
    expect(settings.length).toBeGreaterThanOrEqual(12);
    for (const name of [
      ...settings,
      "TELEMETRY_EXPORTER",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "TELEMETRY_TRACE_RATIO",
      "GF_SECURITY_ADMIN_PASSWORD",
      "GF_SECURITY_SECRET_KEY",
      "GF_SERVER_ROOT_URL",
    ]) {
      expect(section, name).toContain(`\`${name}\``);
    }
  });
});
