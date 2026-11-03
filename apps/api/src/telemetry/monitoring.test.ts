import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { ATTRIBUTE_RULES, RESOURCE_KEYS } from "#src/telemetry/attributes";
import { METRICS } from "#src/telemetry/instruments";

/**
 * Structural checks of the monitoring app's files (T-018b, ADR-620 to ADR-626): no Docker, no network. What the
 * programs make of the files is `pnpm monitoring:validate`, which starts the app; these checks keep the files in
 * step with the API's code and with the RUNBOOK.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const STACK = "ops/monitoring/stack";

type OtlpPayload = {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string }> };
    scopeMetrics: Array<{
      scope: { attributes?: Array<{ key: string }> };
      metrics: Array<Record<string, { dataPoints: Array<{ attributes: Array<{ key: string }> }> }>>;
    }>;
  }>;
};
type Fixtures = {
  DATAPOINT_KEYS: string[];
  RESOURCE_KEYS: string[];
  SERIES_LABELS: string[];
  TARGET_INFO_LABELS: string[];
  metricsPayload: (instance: string, options?: { offList?: boolean }) => OtlpPayload;
};
const fixtures = (await import(
  pathToFileURL(join(ROOT, "ops/monitoring/lib/fixtures.mjs")).href
)) as Fixtures;

/** The Prometheus label names of OpenTelemetry attribute keys (dots become underscores). */
const labels = (keys: readonly string[]): string[] => keys.map((key) => key.replaceAll(".", "_"));

/** The keys of the data points, resource and scope of a payload. */
function keysOf(payload: OtlpPayload): { points: string[]; resource: string[]; scope: string[] } {
  const entry = payload.resourceMetrics[0];
  const metrics = entry?.scopeMetrics[0]?.metrics ?? [];
  const points = metrics.flatMap((metric) =>
    Object.values(metric)
      .filter((data) => typeof data === "object")
      .flatMap((data) =>
        data.dataPoints.flatMap((point) => point.attributes.map((attribute) => attribute.key)),
      ),
  );
  return {
    points: [...new Set(points)],
    resource: (entry?.resource.attributes ?? []).map((attribute) => attribute.key),
    scope: (entry?.scopeMetrics[0]?.scope.attributes ?? []).map((attribute) => attribute.key),
  };
}

describe("the closed list of attributes the validation and the label audit compare with (ADR-603, ADR-626)", () => {
  it("is the list of keys the API may record on a data point, and on its resource", () => {
    expect(fixtures.DATAPOINT_KEYS.toSorted()).toEqual(Object.keys(ATTRIBUTE_RULES).toSorted());
    expect(fixtures.RESOURCE_KEYS.toSorted()).toEqual([...RESOURCE_KEYS].toSorted());
  });

  it("gives the label names Prometheus stores for them", () => {
    expect(fixtures.SERIES_LABELS.toSorted()).toEqual(
      [...labels(Object.keys(ATTRIBUTE_RULES)), "__name__", "job", "instance", "le"].toSorted(),
    );
    expect(fixtures.TARGET_INFO_LABELS.toSorted()).toEqual(
      [
        "__name__",
        "job",
        "instance",
        ...labels(
          RESOURCE_KEYS.filter((key) => key !== "service.name" && key !== "service.instance.id"),
        ),
      ].toSorted(),
    );
  });

  it("is what the test payload carries when it is shaped like the API's, and the payload with off-list attributes goes beyond it", () => {
    const clean = keysOf(fixtures.metricsPayload("instance-1"));
    expect(clean.points.every((key) => fixtures.DATAPOINT_KEYS.includes(key))).toBe(true);
    expect(clean.resource.toSorted()).toEqual([...RESOURCE_KEYS].toSorted());
    expect(clean.scope).toEqual([]);
    const sentinel = keysOf(fixtures.metricsPayload("instance-1", { offList: true }));
    expect(
      sentinel.points.filter((key) => !fixtures.DATAPOINT_KEYS.includes(key)).toSorted(),
    ).toEqual(["client.address", "url.full", "user.email"]);
    expect(
      sentinel.resource.filter((key) => !fixtures.RESOURCE_KEYS.includes(key)).toSorted(),
    ).toEqual(["host.name", "user.email"]);
    expect(sentinel.scope).toEqual(["scope.secret"]);
  });
});

describe("the images", () => {
  const dockerfile = read(`${STACK}/Dockerfile`);

  it("are pinned by version and by digest", () => {
    const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] ?? "");
    expect(bases).toHaveLength(4);
    for (const base of bases) {
      expect(base).toMatch(/^[a-z0-9./-]+:v?\d+(\.\d+)+@sha256:[0-9a-f]{64}$/);
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

  it("copy every file of the folder the scripts and programs read", () => {
    const files = readdirSync(join(ROOT, STACK), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "Dockerfile")
      .map((entry) => entry.name);
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const name of files) {
      expect(dockerfile, name).toContain(name);
    }
  });
});

describe("the app's one public door", () => {
  const caddyfile = read(`${STACK}/Caddyfile`);
  const entrypoint = read(`${STACK}/entrypoint.sh`);
  const dockerfile = read(`${STACK}/Dockerfile`);

  it("is Caddy on port 8080, with Grafana under /grafana and everything else Prometheus", () => {
    expect([...caddyfile.matchAll(/^:(\d+) \{$/gm)].map((match) => match[1])).toEqual(["8080"]);
    expect(caddyfile).toContain("@grafana path /grafana /grafana/*");
    expect(caddyfile).toMatch(/handle @grafana \{\s+reverse_proxy 127\.0\.0\.1:3000\s+\}/);
    expect(caddyfile).toMatch(/\n\thandle \{\s+reverse_proxy 127\.0\.0\.1:9090\s+\}/);
    expect([...caddyfile.matchAll(/reverse_proxy (\S+)/g)].map((match) => match[1])).toEqual([
      "127.0.0.1:3000",
      "127.0.0.1:9090",
    ]);
    expect(dockerfile).toContain("EXPOSE 8080");
  });

  it("keeps its admin endpoint, certificates and a credential out of the file", () => {
    expect(caddyfile).toContain("admin off");
    expect(caddyfile).toContain("auto_https off");
    const directives = caddyfile
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(directives).not.toMatch(/basic_?auth|password|token/i);
  });

  it("puts every other program on this machine only", () => {
    expect(entrypoint).toContain("--web.listen-address=127.0.0.1:9090");
    expect(entrypoint).toContain("--web.listen-address=127.0.0.1:9093");
    expect(dockerfile).toContain("GF_SERVER_HTTP_ADDR=127.0.0.1");
    expect(dockerfile).toContain("GF_SERVER_HTTP_PORT=3000");
    expect(dockerfile).toContain("GF_SERVER_SERVE_FROM_SUB_PATH=true");
  });
});

describe("the supervisor", () => {
  const entrypoint = read(`${STACK}/entrypoint.sh`);

  it("starts the four programs and stops the container when any of them exits", () => {
    for (const program of ["alertmanager", "prometheus", "grafana", "caddy"]) {
      expect(entrypoint, program).toMatch(new RegExp(`^launch ${program} `, "m"));
    }
    expect(entrypoint).toContain("wait -n");
    expect(entrypoint).toMatch(/stop_all\nexit 1\n$/);
  });

  it("stops everything and exits cleanly on a stop signal", () => {
    expect(entrypoint).toContain("trap stop_on_signal TERM INT");
    expect(entrypoint).toMatch(/stop_on_signal\(\) \{[^}]*stop_all[^}]*exit 0/s);
  });
});

describe("Prometheus", () => {
  const entrypoint = read(`${STACK}/entrypoint.sh`);
  const dockerfile = read(`${STACK}/Dockerfile`);
  const prometheus = parse(read(`${STACK}/prometheus.yml`)) as {
    rule_files: string[];
    alerting: { alertmanagers: Array<{ static_configs: Array<{ targets: string[] }> }> };
    otlp: Record<string, unknown>;
    scrape_configs: Array<{ job_name: string }>;
  };

  it("loads a copy of the alert rules that is the file in ops/alerts", () => {
    expect(read(`${STACK}/questify.rules.yml`)).toBe(read("ops/alerts/questify.rules.yml"));
    expect(prometheus.rule_files).toEqual(["/etc/prometheus/questify.rules.yml"]);
    expect(dockerfile).toContain("COPY prometheus.yml questify.rules.yml /etc/prometheus/");
  });

  it("receives the API's OTLP, asks every request for the password, and leaves the other doors shut", () => {
    expect(entrypoint).toContain("--web.enable-otlp-receiver");
    expect(entrypoint).toContain("--web.config.file=/tmp/web.yml");
    expect(entrypoint).not.toContain("--web.enable-remote-write-receiver");
    expect(entrypoint).not.toContain("--web.enable-admin-api");
    expect(entrypoint).not.toContain("--web.enable-lifecycle");
    expect(prometheus.alerting.alertmanagers[0]?.static_configs[0]?.targets).toEqual([
      "127.0.0.1:9093",
    ]);
  });

  it("spells names the way the alert rules do, and promotes no resource attribute or scope", () => {
    expect(prometheus.otlp).toEqual({
      translation_strategy: "UnderscoreEscapingWithSuffixes",
      promote_resource_attributes: [],
      promote_scope_metadata: false,
    });
  });

  it("scrapes only the app's own two parts", () => {
    expect(prometheus.scrape_configs.map((job) => job.job_name)).toEqual([
      "prometheus",
      "alertmanager",
    ]);
  });

  it("pins the look-back the loop alerts depend on, and keeps the 30-day window within the disk", () => {
    expect(entrypoint).toContain("--query.lookback-delta=5m");
    expect(entrypoint).toContain("--storage.tsdb.retention.time=30d");
    expect(entrypoint).toContain("--storage.tsdb.retention.size=4GB");
  });
});

describe("the Alertmanager", () => {
  const dockerfile = read(`${STACK}/Dockerfile`);
  const alertmanager = parse(read(`${STACK}/alertmanager.yml.in`)) as {
    route: { receiver: string; routes: Array<{ matchers: string[]; receiver: string }> };
    receivers: Array<{ name: string }>;
  };

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
    const template = read(`${STACK}/questify.email.tmpl.in`);
    expect(template).toContain(".Annotations.runbook");
    expect(template).toContain("@MONITORING_ENVIRONMENT@");
    const config = read(`${STACK}/alertmanager.yml.in`);
    for (const name of ["ALERT_SMTP_HOST", "ALERT_SMTP_USER", "ALERT_MAIL_FROM", "ALERT_MAIL_TO"]) {
      expect(config).toContain(`@${name}@`);
    }
    expect(config).toContain("smtp_auth_password_file: /tmp/smtp-password");
    expect(config).toContain("smtp_require_tls: true");
  });

  it("has a no-email configuration with one receiver that sends nothing (Q-581)", () => {
    const config = parse(read(`${STACK}/alertmanager.nomail.yml`)) as {
      route: { receiver: string; routes?: unknown };
      receivers: Array<Record<string, unknown>>;
    };
    expect(config.route.receiver).toBe("discard");
    expect(config.route.routes).toBeUndefined();
    expect(config.receivers).toEqual([{ name: "discard" }]);
    expect(dockerfile).toContain("alertmanager.nomail.yml");
  });

  it("is rendered with no-email only when ALERT_SMTP_HOST is unset or empty", () => {
    const script = read(`${STACK}/render-config.sh`);
    expect(script).toContain('if [ -n "${ALERT_SMTP_HOST:-}" ]; then');
    expect(script).toContain("alert email off: no ALERT_SMTP_HOST");
    for (const name of [
      "ALERT_SMTP_USER",
      "ALERT_SMTP_PASSWORD",
      "ALERT_MAIL_FROM",
      "ALERT_MAIL_TO",
    ]) {
      expect(script).toMatch(new RegExp(`^  check ${name} `, "m"));
    }
  });
});

describe("Grafana", () => {
  const dockerfile = read(`${STACK}/Dockerfile`);
  const dashboard = JSON.parse(read(`${STACK}/grafana/dashboards/questify-slo.json`)) as {
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
      "GF_PLUGINS_PREINSTALL_DISABLED=true",
    ]) {
      expect(dockerfile).toContain(setting);
    }
    expect(dockerfile).not.toMatch(/GF_SECURITY_(ADMIN_PASSWORD|SECRET_KEY)=/);
    expect(dockerfile).not.toMatch(/GF_SERVER_ROOT_URL=/);
  });

  it("reads the data source's password from the environment and talks to the Prometheus beside it", () => {
    const text = read(`${STACK}/grafana/provisioning/datasources/prometheus.yml`);
    expect(text).toContain("url: http://127.0.0.1:9090");
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

  it("shows the firing alerts as a count and as a list, the only place they show while email is off", () => {
    const firing = dashboard.panels.filter((panel) =>
      panel.targets?.some((target) => target.expr.includes('ALERTS{alertstate="firing"}')),
    );
    expect(firing.map((panel) => panel.title).toSorted()).toEqual([
      "Alerts firing",
      "Firing alerts",
    ]);
  });
});

describe("the runbook", () => {
  const runbook = read("docs/RUNBOOK.md");
  const start = runbook.indexOf("## Monitoring stack on CranL");
  const end = runbook.indexOf("\n## ", start + 5);
  const section = start < 0 ? "" : runbook.slice(start, end < 0 ? undefined : end);

  /** Setting names the app reads: `check NAME` in the render script, `${NAME}` in the Grafana data source. */
  function settingsOf(): string[] {
    const names = new Set<string>();
    const add = (text: string, pattern: RegExp): void => {
      for (const match of text.matchAll(pattern)) names.add(match[1] ?? "");
    };
    add(read(`${STACK}/render-config.sh`), /^\s*check ([A-Z_]+) /gm);
    add(read(`${STACK}/grafana/provisioning/datasources/prometheus.yml`), /\$\{([A-Z_]+)\}/g);
    return [...names].toSorted();
  }

  it("has the section", () => {
    expect(start).toBeGreaterThan(0);
    expect(section).toContain("### The app");
    expect(section).toContain("### Pointing the API at it");
    expect(section).toContain("### Rotating the password");
    expect(section).toContain("### Auditing the stored labels");
    expect(section).toContain("### Retention and backups");
  });

  it("names every setting the app reads, and the API's telemetry settings", () => {
    const settings = settingsOf();
    expect(settings.length).toBeGreaterThanOrEqual(11);
    for (const name of [
      ...settings,
      "TELEMETRY_EXPORTER",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "TELEMETRY_TRACE_RATIO",
    ]) {
      expect(section, name).toContain(`\`${name}\``);
    }
  });

  it("gives the port, the volume, the OTLP address and the closed list of labels", () => {
    expect(section).toContain("ops/monitoring/stack");
    expect(section).toContain("8080");
    expect(section).toContain("/data");
    expect(section).toContain("/api/v1/otlp");
    expect(section).toContain("authorization=Basic%20");
    for (const label of [...fixtures.SERIES_LABELS, ...fixtures.TARGET_INFO_LABELS]) {
      expect(section, label).toContain(`\`${label}\``);
    }
  });
});
