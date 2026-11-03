import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_RULES,
  OPERATIONS,
  POOL_STATES,
  POOLS,
  ROUTE_CLASSES,
  TICKS,
} from "#src/telemetry/attributes";
import { METRICS } from "#src/telemetry/instruments";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

type Rule = Readonly<{
  alert: string;
  expr: string;
  for?: string;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
}>;

const rules: Rule[] = (
  parse(read("ops/alerts/questify.rules.yml")) as { groups: Array<{ rules: Rule[] }> }
).groups.flatMap((group) => group.rules);

const RUNBOOK = read("docs/RUNBOOK.md");
const SLO = read("docs/SLO.md");

/** The series a metric becomes in a Prometheus-style store: dots to underscores, the unit of time, `_total`. */
function seriesNames(): Set<string> {
  const names = new Set<string>();
  for (const metric of Object.values(METRICS)) {
    const unit = metric.unit === "s" ? "_seconds" : "";
    const base = `${metric.name.replaceAll(".", "_")}${unit}`;
    if (metric.kind === "counter") names.add(`${base}_total`);
    if (metric.kind === "gauge") names.add(base);
    if (metric.kind === "histogram") {
      for (const part of ["bucket", "sum", "count"]) names.add(`${base}_${part}`);
    }
  }
  return names;
}

const LABELS = new Set<string>([
  ...Object.keys(ATTRIBUTE_RULES).map((key) => key.replaceAll(".", "_")),
  "le",
  "instance",
  "job",
]);
const PROMQL_WORDS = new Set([
  "sum",
  "rate",
  "increase",
  "max",
  "by",
  "and",
  "or",
  "time",
  "absent",
]);

/** An expression's metric names and label names, with the quoted strings taken out. */
function partsOf(expr: string): { metrics: string[]; labels: string[] } {
  const bare = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\[[^\]]*\]/g, "[]");
  const labels = [
    ...[...bare.matchAll(/([a-zA-Z_]\w*)\s*(?:=~|!~|!=|=)\s*""/g)].map((match) => match[1] ?? ""),
    ...[...bare.matchAll(/\bby\s*\(([^)]*)\)/g)].flatMap((match) =>
      (match[1] ?? "").split(",").map((label) => label.trim()),
    ),
  ];
  const identifiers = [...bare.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/g)].map((match) => match[0]);
  const metrics = identifiers.filter((word) => !PROMQL_WORDS.has(word) && !labels.includes(word));
  return { metrics: [...new Set(metrics)], labels: [...new Set(labels)] };
}

/** Every `label="value"` or `label=~"a|b"` matcher in an expression, by label. */
function matchers(expr: string, label: string): string[] {
  const pattern = new RegExp(`${label}\\s*=~?\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
  return [...expr.matchAll(pattern)].map((match) => (match[1] ?? "").replace(/\\\\/g, "\\"));
}

/** `community\.(a|b)|redis\.c` as the event names it matches. */
function eventNames(regex: string): string[] {
  const names: string[] = [];
  for (const match of regex.matchAll(/([a-z_]+)\\\.\(([a-z_|]+)\)|([a-z_]+)\\\.([a-z_]+)/g)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      names.push(...match[2].split("|").map((tail) => `${match[1]}.${tail}`));
    } else {
      names.push(`${match[3]}.${match[4]}`);
    }
  }
  return names;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the alert rules", () => {
  it("has the alerts, each with a name, a severity, a summary and a runbook link", () => {
    expect(rules.length).toBeGreaterThanOrEqual(15);
    expect(new Set(rules.map((rule) => rule.alert)).size).toBe(rules.length);
    for (const rule of rules) {
      expect(rule.alert, rule.alert).toMatch(/^Questify[A-Z][A-Za-z]+$/);
      expect(["page", "warning"], rule.alert).toContain(rule.labels?.["severity"]);
      expect(rule.annotations?.["summary"], rule.alert).toBeTruthy();
      expect(rule.annotations?.["runbook"], rule.alert).toBe(
        `docs/RUNBOOK.md#${rule.alert.toLowerCase()}`,
      );
      expect(rule.for, rule.alert).toMatch(/^\d+[smh]$/);
    }
  });

  it("has a runbook entry for every alert and no entry for a rule that is gone", () => {
    const section = RUNBOOK.slice(RUNBOOK.indexOf("## Telemetry and alerts"));
    const end = section.indexOf("\n## ", 5);
    const entries = [
      ...(end < 0 ? section : section.slice(0, end)).matchAll(/^### (Questify\w+)$/gm),
    ];
    const documented = entries.map((entry) => entry[1]);
    expect(documented.toSorted()).toEqual(rules.map((rule) => rule.alert).toSorted());
  });

  it("is listed in the service levels document", () => {
    for (const rule of rules) {
      expect(SLO, rule.alert).toContain(rule.alert);
    }
  });

  it("uses only metrics the API records and labels it sets", () => {
    const known = seriesNames();
    for (const rule of rules) {
      const { metrics, labels } = partsOf(rule.expr);
      expect(
        metrics.filter((name) => !known.has(name)),
        `${rule.alert}: metrics`,
      ).toEqual([]);
      expect(
        labels.filter((label) => !LABELS.has(label)),
        `${rule.alert}: labels`,
      ).toEqual([]);
    }
  });

  it("names only loops, operations, pools and route classes that exist", () => {
    const sets: Array<[string, readonly string[]]> = [
      ["questify_tick", TICKS],
      ["questify_operation", OPERATIONS],
      ["questify_pool", POOLS],
      ["questify_pool_state", POOL_STATES],
      ["questify_route_class", ROUTE_CLASSES],
    ];
    for (const rule of rules) {
      for (const [label, allowed] of sets) {
        for (const value of matchers(rule.expr, label)) {
          expect(allowed, `${rule.alert}: ${label}`).toContain(value);
        }
      }
    }
  });

  it("names only events the code logs, so a rename cannot silence an alert", () => {
    const code = sourceFiles(join(ROOT, "apps/api/src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const missing: string[] = [];
    for (const rule of rules) {
      for (const value of matchers(rule.expr, "questify_event")) {
        const names = eventNames(value);
        for (const name of names.length > 0 ? names : [value]) {
          if (!code.includes(`"${name}"`)) missing.push(`${rule.alert}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
