// The load test (T-804, NFR-002/003/005/025): `node ops/load/run.mjs [options]`; docs/RUNBOOK.md "Load test".
// Local by default: builds the load API from this checkout, seeds a throw-away database on the local PostgreSQL,
// starts the API, drives completions and a sign-in rush from separate processes, prints the report, and drops the
// database and Redis keys in `finally`. `--target` against anything but this PC needs `--remote` and a plan seeded there.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { completionReport, rushReport, verdict } from "./report.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "apps", "api", "test", "load-bundle");
const MIN_FREE_GB = 8;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const { values: opt } = parseArgs({
  options: {
    events: { type: "string", default: "10" },
    players: { type: "string", default: "2500" },
    quests: { type: "string", default: "20" },
    // Event 1's players when above 0: one skewed event among small ones, for the generic-plan check (ADR-674).
    "big-event-players": { type: "string", default: "0" },
    "rate-per-event": { type: "string", default: "20000" },
    duration: { type: "string", default: "60" },
    warmup: { type: "string", default: "10" },
    drivers: { type: "string", default: "5" },
    sockets: { type: "string", default: "64" },
    "max-in-flight": { type: "string", default: "4000" },
    "api-instances": { type: "string", default: "1" },
    "pool-size": { type: "string", default: "10" },
    "probe-every": { type: "string", default: "2000" },
    rush: { type: "string", default: "25:10,50:10,100:10,200:10" },
    "rush-per-address": { type: "string", default: "50" },
    // The rush's first phone number (+96659 and 7 digits); move it on between runs against one database.
    "rush-first": { type: "string", default: "0" },
    "skip-completions": { type: "boolean", default: false },
    "pg-container": { type: "string", default: "questifyapp-postgres-1" },
    "admin-url": {
      type: "string",
      default:
        process.env["TEST_DATABASE_URL"] ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres",
    },
    "redis-url": {
      type: "string",
      default: process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:56379",
    },
    target: { type: "string" },
    plan: { type: "string" },
    remote: { type: "boolean", default: false },
  },
});
const num = (/** @type {string} */ name) => {
  const value = Number(opt[name]);
  if (!(value >= 0)) throw new Error(`--${name} must be a number; got "${opt[name]}".`);
  return value;
};

const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

function freeGb() {
  const fs = statfsSync(ROOT);
  return (fs.bavail * fs.bsize) / 1024 ** 3;
}

function checkDisk(stage) {
  const gb = freeGb();
  say(`disk ${stage}: ${gb.toFixed(1)} GB free`);
  if (gb < MIN_FREE_GB)
    throw new Error(
      `Only ${gb.toFixed(1)} GB free (${stage}); the load test stops under ${MIN_FREE_GB} GB.`,
    );
  return gb;
}

function runSync(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const prepare = (args) =>
  runSync(process.execPath, [join(BUNDLE, "prepare.mjs"), ...args], {
    TEST_DATABASE_URL: opt["admin-url"],
    LOAD_REDIS_URL: opt["redis-url"],
    LOAD_EVENTS: opt.events,
    LOAD_PLAYERS: opt.players,
    LOAD_QUESTS: opt.quests,
    LOAD_BIG_EVENT: opt["big-event-players"],
  });

/** Bundles the load API and the seeding script from this checkout with the API's own esbuild. */
function build() {
  const api = join(ROOT, "apps", "api");
  const esbuild = createRequire(join(api, "package.json"))("esbuild");
  esbuild.buildSync({
    entryPoints: [join(api, "test", "load", "server.ts"), join(api, "test", "load", "prepare.ts")],
    absWorkingDir: api,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["pg", "fastify", "@node-rs/argon2", "zod", "redis"],
    outdir: BUNDLE,
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
}

/** Starts one load API and resolves with its process once it says it is ready. */
function startApi(plan, port) {
  const child = spawn(process.execPath, [join(BUNDLE, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOAD_DATABASE_URL: plan.appUrl,
      LOAD_REDIS_URL: opt["redis-url"],
      LOAD_REDIS_PREFIX: plan.redisPrefix,
      LOAD_PORT: String(port),
      DATABASE_POOL_SIZE: opt["pool-size"],
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let said = "";
    child.stderr.on("data", (chunk) => {
      said += chunk;
      if (said.includes("load api ready")) resolve(child);
    });
    child.on("exit", (code) => reject(new Error(`The load API stopped (${code}): ${said}`)));
  });
}

/** The CPU time a process has used, in ms (Windows and Linux), or null when it cannot be read. */
function cpuMsOf(pid) {
  try {
    if (process.platform === "win32") {
      const out = runSync("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`,
      ]);
      return Number(out.trim());
    }
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? [];
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / 100;
  } catch {
    return null;
  }
}

/** Samples the PostgreSQL container's CPU every 5 s until `stop()`; the samples in % of one core. */
function samplePostgres() {
  const samples = [];
  const timer = setInterval(() => {
    const child = spawn("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}",
      opt["pg-container"],
    ]);
    let out = "";
    // Without docker (a native PostgreSQL) the sample stays empty instead of crashing the run before its cleanup.
    child.on("error", () => {});
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("exit", () => {
      const value = Number.parseFloat(out);
      if (Number.isFinite(value)) samples.push(value);
    });
  }, 5000);
  return () => {
    clearInterval(timer);
    return samples;
  };
}

function runDriver(job, dir, name) {
  const jobFile = join(dir, `${name}.job.json`);
  const resultFile = join(dir, `${name}.result.json`);
  writeFileSync(jobFile, JSON.stringify(job));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(ROOT, "ops", "load", "driver.mjs"), jobFile, resultFile],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve(JSON.parse(readFileSync(resultFile, "utf8")))
        : reject(new Error(`Driver ${name} failed (${code}).`)),
    );
  });
}

function baseJob(baseUrls) {
  return { baseUrls, sockets: num("sockets"), maxInFlight: num("max-in-flight") };
}

async function completionsPhase(plan, baseUrls, dir, apiPids) {
  const drivers = Math.max(1, Math.min(num("drivers"), plan.events.length));
  const jobs = Array.from({ length: drivers }, (_x, d) => ({
    ...baseJob(baseUrls.slice(d % baseUrls.length).concat(baseUrls.slice(0, d % baseUrls.length))),
    mode: "completions",
    events: plan.events.filter((_e, i) => i % drivers === d),
    ratePerEventPerMinute: num("rate-per-event"),
    warmupSeconds: num("warmup"),
    durationSeconds: num("duration"),
    probeEveryMs: num("probe-every"),
  }));
  const cpuBefore = apiPids.map(cpuMsOf);
  const stopSampling = samplePostgres();
  const results = await Promise.all(jobs.map((job, d) => runDriver(job, dir, `completions-${d}`)));
  const pgCpu = stopSampling();
  const window = num("warmup") + num("duration");
  const apiCpu = apiPids.map((pid, i) => {
    const after = cpuMsOf(pid);
    return after === null || cpuBefore[i] === null
      ? null
      : Math.round(((after - cpuBefore[i]) / (window * 1000)) * 100);
  });
  const report = completionReport(results, num("duration"));
  const asked = (num("rate-per-event") / 60) * plan.events.length;
  return {
    askedPerSecond: Math.round(asked),
    ...report,
    verdict: verdict(report, asked),
    apiCpuPercentOfOneCore: apiCpu,
    postgresCpuPercent:
      pgCpu.length === 0
        ? null
        : {
            mean: Math.round(pgCpu.reduce((a, b) => a + b, 0) / pgCpu.length),
            max: Math.max(...pgCpu),
          },
  };
}

async function rushPhase(plan, baseUrls, dir) {
  const steps = opt.rush
    .split(",")
    .filter(Boolean)
    .map((part) => {
      const [rate, seconds] = part.split(":").map(Number);
      return { ratePerSecond: rate, seconds };
    });
  if (steps.length === 0) return [];
  const job = {
    ...baseJob(baseUrls),
    mode: "rush",
    rush: {
      steps,
      perAddress: num("rush-per-address"),
      accept: plan.accept,
      firstIndex: num("rush-first"),
    },
  };
  const result = await runDriver(job, dir, "rush");
  return rushReport(result.rush);
}

function machine() {
  return {
    platform: `${os.type()} ${os.release()}`,
    node: process.version,
    cpu: os.cpus()[0]?.model.trim(),
    logicalCpus: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

async function measure(plan, baseUrls, dir, apiPids) {
  const report = {
    startedAt: new Date().toISOString(),
    machine: machine(),
    options: { ...opt, "admin-url": undefined, "redis-url": undefined, target: undefined },
    sizes: plan.sizes,
  };
  if (!opt["skip-completions"]) {
    report.completions = await completionsPhase(plan, baseUrls, dir, apiPids);
    if (plan.database !== undefined && !opt.remote)
      report.database = JSON.parse(prepare(["count", plan.database]));
  }
  report.rush = await rushPhase(plan, baseUrls, dir);
  return report;
}

async function runLocal(dir) {
  checkDisk("before");
  build();
  const planFile = join(dir, "plan.json");
  prepare(["create", planFile]);
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const apis = [];
  const cleanUp = () => {
    for (const api of apis) api.kill();
    prepare(["drop", plan.database, plan.redisPrefix]);
  };
  // Ctrl+C mid-run still drops the database (the drivers are this process's children and stop with it).
  const interrupted = () => {
    cleanUp();
    process.exit(130);
  };
  process.once("SIGINT", interrupted);
  try {
    checkDisk("after seeding");
    const ports = Array.from({ length: Math.max(1, num("api-instances")) }, (_x, i) => 4810 + i);
    for (const port of ports) apis.push(await startApi(plan, port));
    return await measure(
      plan,
      ports.map((port) => `http://127.0.0.1:${port}`),
      dir,
      apis.map((api) => api.pid),
    );
  } finally {
    process.removeListener("SIGINT", interrupted);
    cleanUp();
  }
}

async function runRemote(dir) {
  const targets = (opt.target ?? "").split(",").filter(Boolean);
  const remote = targets.some((url) => !LOOPBACK.has(new URL(url).hostname));
  if (remote && !opt.remote)
    throw new Error("--target is not this PC: add --remote, and never point it at production.");
  if (opt.plan === undefined)
    throw new Error("--target needs --plan, seeded in that environment (RUNBOOK).");
  return measure(JSON.parse(readFileSync(opt.plan, "utf8")), targets, dir, []);
}

async function main() {
  const dir = join(ROOT, "ops", "load", "out", new Date().toISOString().replaceAll(":", "-"));
  mkdirSync(dir, { recursive: true });
  const report = opt.target === undefined ? await runLocal(dir) : await runRemote(dir);
  report.diskAfterGb = Math.round(checkDisk("after") * 10) / 10;
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  say(JSON.stringify(report, null, 2));
  say(`report: ${join(dir, "report.json")}`);
}

main().catch((error) => {
  process.stderr.write(`load test: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
