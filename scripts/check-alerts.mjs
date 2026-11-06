// Runs `promtool check rules` and `promtool test rules` on ops/alerts/ (RUNBOOK, "Telemetry and alerts") when the change
// touches ops/alerts/ or ops/monitoring/ (`needsAlertChecks` in scripts/ci-scope.mjs). Part of `pnpm ci:changed`, so the
// PR gate runs it as well. promtool comes from the Prometheus image the monitoring stack builds on, pinned by digest, so
// Docker must be running when the rules changed.
// Usage: node scripts/check-alerts.mjs [base]
// The base is the argument, else $CI_SCOPE_BASE (CI sets it), else origin/main; uncommitted and new files count too.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changesSince, needsAlertChecks } from "./ci-scope.mjs";

/** The same image and digest as ops/monitoring/stack/Dockerfile; raise both together. */
export const PROMETHEUS_IMAGE =
  "prom/prometheus:v3.15.1@sha256:fa3302279710be2f21a8301ec17a8b4f2301fd829bd113839b3b6b02b6f191a2";

/** The two promtool runs, as `docker run` arguments with ops/alerts mounted read-only at /rules. */
export function promtoolRuns(alertsDir) {
  const run = (...args) => [
    "run",
    "--rm",
    "--entrypoint",
    "promtool",
    "-v",
    `${alertsDir}:/rules:ro`,
    PROMETHEUS_IMAGE,
    ...args,
  ];
  return [
    run("check", "rules", "/rules/questify.rules.yml"),
    run("test", "rules", "/rules/questify.rules.test.yml"),
  ];
}

function gitFiles(args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");
}

/** Files changed but not committed, and new files git does not ignore. */
function uncommitted() {
  return [
    ...gitFiles(["diff", "--name-only", "HEAD"]),
    ...gitFiles(["ls-files", "--others", "--exclude-standard"]),
  ];
}

function main(base) {
  const committed = changesSince(base)?.files;
  const files = committed === undefined ? undefined : [...committed, ...uncommitted()];
  if (!needsAlertChecks(files)) {
    process.stderr.write(
      "alert rules: nothing under ops/alerts/ or ops/monitoring/ changed, promtool skipped\n",
    );
    return;
  }
  const alertsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "alerts");
  for (const args of promtoolRuns(alertsDir)) {
    const result = spawnSync("docker", args, { stdio: "inherit" });
    if (result.error !== undefined) {
      throw new Error(
        `Could not start Docker to run promtool (${result.error.message}). Start Docker, or run the two promtool commands of RUNBOOK "Telemetry and alerts" by hand.`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `promtool ${args.slice(-3).join(" ")} failed with exit code ${result.status}.`,
      );
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv[2] ?? process.env["CI_SCOPE_BASE"] ?? "origin/main");
}
