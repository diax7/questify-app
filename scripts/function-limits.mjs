// Ratchet for the function limits of docs/rules.md (at most 100 lines, cyclomatic complexity 8; Q-271, T-023).
// Runs oxlint with .oxlintrc.limits.json (a config only this script reads, so the normal lint gate stays clean),
// then compares the offending functions with scripts/function-limits-baseline.json.
//   node scripts/function-limits.mjs            fail on a new offender or a baselined function that grew
//   node scripts/function-limits.mjs --update   rewrite the baseline, only when nothing grew (it only shrinks)
// A function is identified by file, name (or "<anonymous>") and rule; several functions sharing that identity in
// one file are matched by value first and then largest to largest, so moving a function inside its file changes
// nothing. A renamed offender counts as a new one: split it instead.
// The oxlint run is cross-checked (exit status, the "N problems" summary, no unrecognised output) so that a broken
// config or a crash can never read as "no offenders" and wipe the baseline.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ANONYMOUS = "<anonymous>";
const RULES = ["complexity", "lines"];
const LINE_PATTERN =
  /^(.+?):(\d+):\d+: (.+) \[Error\/eslint\((complexity|max-lines-per-function)\)\]$/;
const SUMMARY_PATTERN = /^(\d+) problems?$/;

function parseOffender(line, match) {
  const [, file, lineNumber, message, eslintRule] = match;
  const rule = eslintRule === "complexity" ? "complexity" : "lines";
  const value = rule === "complexity" ? /complexity of (\d+)/ : /too many lines \((\d+)\)/;
  const measured = value.exec(message);
  if (measured === null) {
    throw new Error(`Cannot read the measured value from the oxlint line: ${line}`);
  }
  return {
    file: file.replaceAll("\\", "/"),
    name: /`([^`]+)`/.exec(message)?.[1] ?? ANONYMOUS,
    rule,
    value: Number(measured[1]),
    line: Number(lineNumber),
  };
}

// Sorts every non-blank line of oxlint's `-f unix` output into an offender, the summary count, or "unexpected".
export function parseScan(output) {
  const offenders = [];
  const unexpected = [];
  let summary;
  for (const line of output.split(/\r?\n/)) {
    const match = LINE_PATTERN.exec(line);
    const total = SUMMARY_PATTERN.exec(line.trim());
    if (match !== null) {
      offenders.push(parseOffender(line, match));
    } else if (total !== null) {
      summary = Number(total[1]);
    } else if (line.trim() !== "") {
      unexpected.push(line);
    }
  }
  return { offenders, summary, unexpected };
}

export function parseOffenders(output) {
  return parseScan(output).offenders;
}

function unverified(reason, { stdout, stderr }) {
  const excerpt = `${stderr ?? ""}${stdout ?? ""}`.trim().split(/\r?\n/).slice(0, 5).join("\n");
  return new Error(
    `The oxlint run cannot be trusted (${reason}); nothing was compared or written.${
      excerpt === "" ? "" : `\n${excerpt}`
    }`,
  );
}

// Returns the offenders of a run that is consistent with itself, and throws for anything else.
// result: { status, stdout, stderr, error } as spawnSync gives it.
export function verifyScan(result) {
  const { status, stdout = "", stderr = "", error } = result;
  if (error !== undefined || status === null || status > 1) {
    throw unverified(`it did not finish: ${error?.message ?? `exit status ${status}`}`, result);
  }
  const { offenders, summary, unexpected } = parseScan(stdout);
  if (unexpected.length > 0) {
    throw unverified(`unrecognised output: ${unexpected[0]}`, result);
  }
  if (status === 0 && (offenders.length > 0 || (summary ?? 0) > 0)) {
    throw unverified("exit status 0 but problems were reported", result);
  }
  if (status === 1 && (offenders.length === 0 || summary !== offenders.length)) {
    throw unverified(
      `exit status 1 with ${offenders.length} offenders read and a summary of ${summary ?? "none"}`,
      result,
    );
  }
  if (offenders.length === 0 && stderr.trim() !== "") {
    throw unverified("nothing read and the error stream is not empty", result);
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

// Every identity (file, name, rule) with its current offenders (largest first) and its baselined values.
function identities(baseline, offenders) {
  const map = new Map();
  const entry = (file, name, rule) => {
    const key = JSON.stringify([file, name, rule]);
    if (!map.has(key)) {
      map.set(key, { file, name, rule, current: [], allowed: [] });
    }
    return map.get(key);
  };
  for (const [file, names] of Object.entries(baseline)) {
    for (const [name, rules] of Object.entries(names)) {
      for (const [rule, values] of Object.entries(rules)) {
        entry(file, name, rule).allowed = values;
      }
    }
  }
  for (const offender of offenders) {
    entry(offender.file, offender.name, offender.rule).current.push(offender);
  }
  for (const item of map.values()) {
    item.current = item.current.toSorted((a, b) => b.value - a.value || a.line - b.line);
  }
  return [...map.values()];
}

// Equal values cancel out first; of the rest, the largest pairs with the largest, and a surplus current function
// is a new offender (a function that is baselined but absent is gone).
function compareIdentity({ file, name, rule, current, allowed }) {
  const failures = [];
  const improvements = [];
  const remaining = [...allowed];
  const unmatched = [];
  for (const offender of current) {
    const index = remaining.indexOf(offender.value);
    if (index >= 0) {
      remaining.splice(index, 1);
    } else {
      unmatched.push(offender);
    }
  }
  unmatched.forEach((offender, index) => {
    const was = remaining[index];
    if (was === undefined) {
      failures.push({ ...offender, kind: "new" });
    } else if (offender.value > was) {
      failures.push({ ...offender, kind: "grew", was });
    } else {
      improvements.push({ ...offender, kind: "shrunk", was });
    }
  });
  for (const was of remaining.slice(unmatched.length)) {
    improvements.push({ file, name, rule, was, kind: "gone" });
  }
  return { failures, improvements };
}

export function compare(baseline, offenders) {
  const failures = [];
  const improvements = [];
  for (const item of identities(baseline, offenders)) {
    const result = compareIdentity(item);
    failures.push(...result.failures);
    improvements.push(...result.improvements);
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

const REQUIRED_RULES = {
  complexity: ["error", 8],
  "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],
};

// The limits config must still define both rules with the values of docs/rules.md; a config that drops one would
// make its offenders look "gone" and let --update erase them from the baseline.
export function verifyConfig(config) {
  for (const [rule, required] of Object.entries(REQUIRED_RULES)) {
    if (JSON.stringify(config?.rules?.[rule]) !== JSON.stringify(required)) {
      throw new Error(
        `.oxlintrc.limits.json must define ${rule} as ${JSON.stringify(required)}; nothing was compared or written.`,
      );
    }
  }
}

// The whole decision, without any I/O: { code, out, err, newBaseline } where newBaseline is the text to write.
// scan is what spawnSync returned for the oxlint run; a run that fails verifyScan can neither pass nor update.
export function runRatchet({ baseline, config, scan, update }) {
  let offenders;
  try {
    verifyConfig(config);
    offenders = verifyScan(scan);
  } catch (error) {
    return { code: 1, out: [], err: [error.message], newBaseline: undefined };
  }
  const { failures, improvements } = compare(baseline, offenders);
  const out = improvements.map(describeFinding);
  if (failures.length > 0) {
    const err = failures.map(describeFinding);
    err.push(
      `${failures.length} function limit violation(s): split the function (docs/rules.md: 100 lines, complexity 8).`,
    );
    return { code: 1, out, err, newBaseline: undefined };
  }
  if (update) {
    out.push(`Baseline rewritten: ${offenders.length} limit violations remain.`);
    return { code: 0, out, err: [], newBaseline: formatBaseline(toBaseline(offenders)) };
  }
  const hint = improvements.length > 0 ? " Run with --update to lock in the progress." : "";
  out.push(`Function limits hold: ${offenders.length} baselined violations, none new.${hint}`);
  return { code: 0, out, err: [], newBaseline: undefined };
}

function scanWithOxlint(root) {
  const require = createRequire(join(root, "package.json"));
  const bin = join(dirname(require.resolve("oxlint/package.json")), "bin", "oxlint");
  return spawnSync(
    process.execPath,
    [bin, "-c", ".oxlintrc.limits.json", "-f", "unix", "apps", "packages"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const baselinePath = join(root, "scripts", "function-limits-baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const config = JSON.parse(readFileSync(join(root, ".oxlintrc.limits.json"), "utf8"));
  const { code, out, err, newBaseline } = runRatchet({
    baseline,
    config,
    scan: scanWithOxlint(root),
    update: argv.includes("--update"),
  });
  if (newBaseline !== undefined) {
    writeFileSync(baselinePath, newBaseline);
  }
  for (const line of out) {
    process.stdout.write(`${line}\n`);
  }
  for (const line of err) {
    process.stderr.write(`${line}\n`);
  }
  return code;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
