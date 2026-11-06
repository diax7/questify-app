// What the load test (run.mjs) and the one-at-a-time profile (profile.mjs) share on this PC: the bundle of the load API
// and its seeding script, the seeding script's commands, one load API process, and the disk check.
import { spawn, spawnSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");
const BUNDLE = join(ROOT, "apps", "api", "test", "load-bundle");
const MIN_FREE_GB = 8;
export const CODE_PORT_OFFSET = 100;
export const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

/** The node-pg of the API package, for scripts here that read the database directly. */
export const pg = () => createRequire(join(ROOT, "apps", "api", "package.json"))("pg");

/** Free disk space in GB; throws under 8 GB, the floor below which the tests' databases have filled C: before. */
export function checkDisk(stage) {
  const fs = statfsSync(ROOT);
  const gb = (fs.bavail * fs.bsize) / 1024 ** 3;
  say(`disk ${stage}: ${gb.toFixed(1)} GB free`);
  if (gb < MIN_FREE_GB)
    throw new Error(
      `Only ${gb.toFixed(1)} GB free (${stage}); the load test stops under ${MIN_FREE_GB} GB.`,
    );
  return gb;
}

/** A local run creates and drops databases and Redis keys: refuse an admin or Redis address that is not this PC. */
export function requireLoopback(opt) {
  for (const name of ["admin-url", "redis-url"]) {
    const host = new URL(opt[name]).hostname;
    if (!LOOPBACK.has(host))
      throw new Error(
        `--${name} points at ${host}, not this PC: a local run creates and drops data there.`,
      );
  }
}

export function runSync(command, args, env = {}) {
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

/**
 * Runs the bundled seeding script (`create <plan.json>`, `count <database>`, `drop <database> <prefix>`) with
 * `settings`: the admin URL, the Redis URL and the LOAD_* sizes of apps/api/test/load/prepare.ts.
 *
 * @param {readonly string[]} args
 * @param {Readonly<Record<string, string>>} settings
 */
export const prepare = (args, settings) =>
  runSync(process.execPath, [join(BUNDLE, "prepare.mjs"), ...args], settings);

/** Bundles the load API and the seeding script from this checkout with the API's own esbuild. */
export function build() {
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

/** How long a load API may take to say it is ready (it connects to PostgreSQL and Redis first). */
const START_TIMEOUT_MS = 60_000;

/**
 * Starts one load API on `port` and resolves with its process once it says it is ready.
 *
 * @param {{ appUrl: string; redisPrefix: string }} plan
 * @param {Readonly<{ port: number; redisUrl: string; poolSize: string }>} options
 */
export function startApi(plan, options) {
  const child = spawn(process.execPath, [join(BUNDLE, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOAD_DATABASE_URL: plan.appUrl,
      LOAD_REDIS_URL: options.redisUrl,
      LOAD_REDIS_PREFIX: plan.redisPrefix,
      LOAD_PORT: String(options.port),
      LOAD_CODE_PORT: String(options.port + CODE_PORT_OFFSET),
      DATABASE_POOL_SIZE: options.poolSize,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let said = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `The load API did not say it was ready within ${START_TIMEOUT_MS / 1000} s: ${said}`,
        ),
      );
    }, START_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => {
      said += chunk;
      if (said.includes("load api ready")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The load API stopped (${code}): ${said}`));
    });
  });
}
