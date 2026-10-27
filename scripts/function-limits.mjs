// Ratchet for the function limits of docs/rules.md (at most 100 lines, cyclomatic complexity 8; Q-271, T-023).
// Runs oxlint with .oxlintrc.limits.json (a config only this script reads, so the normal lint gate stays clean),
// then compares the offending functions with scripts/function-limits-baseline.json.
//   node scripts/function-limits.mjs            fail on a new offender or a baselined function that grew
//   node scripts/function-limits.mjs --update   rewrite the baseline, only when nothing grew (it only shrinks)
// A function is identified by file, name (or "<anonymous>") and rule; several functions sharing that identity in
// one file are matched largest to largest, so moving a function inside its file changes nothing. A renamed
// offender counts as a new one: split it instead.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ANONYMOUS = "<anonymous>";
const RULES = ["complexity", "lines"];
const LINE_PATTERN =
  /^(.+?):(\d+):\d+: (.+) \[Error\/eslint\((complexity|max-lines-per-function)\)\]$/;

export function parseOffenders(output) {
  const offenders = [];
  for (const line of output.split(/\r?\n/)) {
    const match = LINE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    const [, file, lineNumber, message, eslintRule] = match;
    const rule = eslintRule === "complexity" ? "complexity" : "lines";
    const value = rule === "complexity" ? /complexity of (\d+)/ : /too many lines \((\d+)\)/;
    const measured = value.exec(message);
    if (measured === null) {
      throw new Error(`Cannot read the measured value from the oxlint line: ${line}`);
    }
    offenders.push({
      file: file.replaceAll("\\", "/"),
      name: /`([^`]+)`/.exec(message)?.[1] ?? ANONYMOUS,
      rule,
      value: Number(measured[1]),
      line: Number(lineNumber),
    });
  }
  return offenders;
}

// { "<file>": { "<name>": { complexity: [values, largest first], lines: [values, largest first] } } }
export function toBaseline(offenders) {
  const baseline = {};
  for (const { file, name, rule, value } of offenders) {
    const names = (baseline[file] ??= {});
    const rules = (names[name] ??= {});
    (rules[rule] ??= []).push(value);
  }
  return sortBaseline(baseline);
}

function sortBaseline(baseline) {
  const sorted = {};
  for (const file of Object.keys(baseline).toSorted()) {
    sorted[file] = {};
    for (const name of Object.keys(baseline[file]).toSorted()) {
      sorted[file][name] = {};
      for (const rule of RULES) {
        const values = baseline[file][name][rule];
        if (values !== undefined) {
          sorted[file][name][rule] = values.toSorted((a, b) => b - a);
        }
      }
    }
  }
  return sorted;
}

const oneLine = (_, inner) => `[${inner.trim().split(/,\s*/).join(", ")}]`;

export function formatBaseline(baseline) {
  const text = JSON.stringify(baseline, null, 2).replace(/\[\s+([\d,\s]+?)\s+\]/g, oneLine);
  return `${text}\n`;
}

function groupByIdentity(offenders) {
  const groups = new Map();
  for (const offender of offenders) {
    const key = JSON.stringify([offender.file, offender.name, offender.rule]);
    const group = groups.get(key) ?? [];
    group.push(offender);
    groups.set(key, group);
  }
  return new Map(
    [...groups].map(([key, group]) => [
      key,
      group.toSorted((a, b) => b.value - a.value || a.line - b.line),
    ]),
  );
}

function baselineValues(baseline, file, name, rule) {
  return baseline[file]?.[name]?.[rule] ?? [];
}

function baselineIdentities(baseline) {
  const identities = [];
  for (const [file, names] of Object.entries(baseline)) {
    for (const [name, rules] of Object.entries(names)) {
      for (const rule of Object.keys(rules)) {
        identities.push([file, name, rule]);
      }
    }
  }
  return identities;
}

export function compare(baseline, offenders) {
  const failures = [];
  const improvements = [];
  const groups = groupByIdentity(offenders);
  for (const group of groups.values()) {
    const { file, name, rule } = group[0];
    const allowed = baselineValues(baseline, file, name, rule);
    group.forEach((offender, index) => {
      const limit = allowed[index];
      if (limit === undefined) {
        failures.push({ ...offender, kind: "new" });
      } else if (offender.value > limit) {
        failures.push({ ...offender, kind: "grew", was: limit });
      } else if (offender.value < limit) {
        improvements.push({ ...offender, kind: "shrunk", was: limit });
      }
    });
  }
  for (const [file, name, rule] of baselineIdentities(baseline)) {
    const current = groups.get(JSON.stringify([file, name, rule]))?.length ?? 0;
    for (const was of baselineValues(baseline, file, name, rule).slice(current)) {
      improvements.push({ file, name, rule, was, kind: "gone" });
    }
  }
  return { failures, improvements };
}

export function describeFinding(finding) {
  const unit = finding.rule === "complexity" ? "complexity" : "lines";
  const where = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  const subject = `${finding.name} (${where})`;
  switch (finding.kind) {
    case "new":
      return `new offender: ${subject} has ${finding.value} ${unit}`;
    case "grew":
      return `grew: ${subject} went from ${finding.was} to ${finding.value} ${unit}`;
    case "shrunk":
      return `shrunk: ${subject} went from ${finding.was} to ${finding.value} ${unit}`;
    default:
      return `gone: ${finding.name} (${finding.file}) no longer exceeds ${unit} (was ${finding.was})`;
  }
}

function runOxlint(root) {
  const require = createRequire(join(root, "package.json"));
  const bin = join(dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
  const result = spawnSync(
    process.execPath,
    [bin, "-c", ".oxlintrc.limits.json", "-f", "unix", "apps", "packages"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error !== undefined || result.status === null || result.status > 1) {
    throw new Error(`oxlint did not run: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const baselinePath = join(root, "scripts", "function-limits-baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const offenders = parseOffenders(runOxlint(root));
  const { failures, improvements } = compare(baseline, offenders);
  for (const improvement of improvements) {
    process.stdout.write(`${describeFinding(improvement)}\n`);
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${describeFinding(failure)}\n`);
    }
    process.stderr.write(
      `${failures.length} function limit violation(s): split the function (docs/rules.md: 100 lines, complexity 8).\n`,
    );
    return 1;
  }
  if (argv.includes("--update")) {
    writeFileSync(baselinePath, formatBaseline(toBaseline(offenders)));
    process.stdout.write(`Baseline rewritten: ${offenders.length} limit violations remain.\n`);
    return 0;
  }
  const hint = improvements.length > 0 ? " Run with --update to lock in the progress." : "";
  process.stdout.write(
    `Function limits hold: ${offenders.length} baselined violations, none new.${hint}\n`,
  );
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
