import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import type { Client } from "pg";

/** Held while migrating so two servers starting together cannot both run the same migration. */
const LOCK_KEY = 7_361_902;
const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** SQLSTATE of the two clashes with live traffic that PostgreSQL ends by aborting one side (ADR-291). */
const LOCK_CLASH_CODES: ReadonlyMap<string, string> = new Map([
  ["40P01", "deadlock"],
  ["55P03", "lock timeout"],
]);
/** A file that clashes is run again this many times, so four attempts in all, before the run gives up. */
export const MAX_LOCK_CLASH_RETRIES = 3;
/** The wait before retry n is this times 2^(n-1), spread by `retryDelayMs`. */
export const RETRY_BASE_DELAY_MS = 1000;

/**
 * Exit codes of `node migrate.cjs` that the deploy loop relies on (docs/RUNBOOK.md, "Migration retry").
 * 0 means every file is applied; 75 means a file lost a lock clash on every attempt, rolled back whole, and the same
 * command is safe to run again; 1 is any other failure and must be read, not retried.
 */
export const EXIT_FAILED = 1;
export const EXIT_LOCK_CLASH = 75;

export type MigrationResult = Readonly<{ applied: string[]; alreadyApplied: string[] }>;

export type MigrateOptions = Readonly<{
  /** Waits between attempts. Tests replace it so no run really waits. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Source of the backoff jitter, a number in [0, 1). */
  random?: () => number;
  /** Receives one line per retry: file, SQLSTATE and attempt. Defaults to standard error. */
  log?: (line: string) => void;
}>;

/** A file whose transaction lost a lock clash on every attempt. Each attempt rolled back whole; running it again is safe. */
export class MigrationLockClashError extends Error {
  constructor(
    readonly file: string,
    readonly sqlstate: string,
    readonly attempts: number,
    cause: unknown,
  ) {
    super(
      `Migration ${file} hit a lock clash (SQLSTATE ${sqlstate}, ${LOCK_CLASH_CODES.get(sqlstate) ?? "lock clash"}) on all ${attempts} attempts and was rolled back each time; nothing of it was applied. Run it again in a quiet minute: ${describeFailure(cause)}`,
      { cause },
    );
    this.name = "MigrationLockClashError";
  }
}

/** The exit code `node migrate.cjs` ends with for a failed run. */
export function migrationExitCode(error: unknown): number {
  return error instanceof MigrationLockClashError ? EXIT_LOCK_CLASH : EXIT_FAILED;
}

/** The wait before retry number `retry` (1 for the first): half to one and a half times the doubling base. */
export function retryDelayMs(retry: number, random: () => number): number {
  return Math.round(RETRY_BASE_DELAY_MS * 2 ** (retry - 1) * (0.5 + random()));
}

function lockClashCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && LOCK_CLASH_CODES.has(code) ? code : undefined;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkNames(names: readonly string[]): void {
  const numbers = new Set<string>();
  for (const name of names) {
    const match = FILE_NAME.exec(name);
    if (match === null) {
      throw new Error(`Migration file "${name}" must be named like 0002_add_quests.sql.`);
    }
    if (numbers.has(match[1] ?? "")) {
      throw new Error(`Two migration files use the number ${match[1]}.`);
    }
    numbers.add(match[1] ?? "");
  }
}

async function rollBack(client: Client, name: string, failure: unknown): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    throw new Error(
      `Migration ${name} failed (${describeFailure(failure)}) and the rollback also failed (${describeFailure(error)}). Check schema_migration and the schema before running it again.`,
      { cause: error },
    );
  }
}

/**
 * Runs one file as one transaction. A deadlock (40P01) or lock timeout (55P03) rolls the whole transaction back and
 * runs the file again, up to `MAX_LOCK_CLASH_RETRIES` times with a jittered, doubling wait; any other error fails at
 * once. Only a rolled-back transaction is ever retried, so a file is never applied twice or half-applied.
 */
async function applyFile(
  client: Client,
  file: Readonly<{ name: string; sql: string; checksum: string }>,
  options: MigrateOptions,
): Promise<void> {
  const sleep = options.sleep ?? ((milliseconds: number) => waitFor(milliseconds));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  for (let attempt = 1; ; attempt += 1) {
    await client.query("BEGIN");
    try {
      // A file that sets no lock timeout of its own never waits on a lock for longer than this (Q-540).
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query(file.sql);
      await client.query("INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)", [
        file.name,
        file.checksum,
      ]);
      await client.query("COMMIT");
      return;
    } catch (error) {
      await rollBack(client, file.name, error);
      const sqlstate = lockClashCode(error);
      if (sqlstate === undefined) {
        throw new Error(
          `Migration ${file.name} failed and was rolled back: ${describeFailure(error)}`,
          { cause: error },
        );
      }
      if (attempt > MAX_LOCK_CLASH_RETRIES) {
        throw new MigrationLockClashError(file.name, sqlstate, attempt, error);
      }
      const delay = retryDelayMs(attempt, random);
      log(
        `Migration ${file.name} hit a lock clash (SQLSTATE ${sqlstate}) on attempt ${attempt} of ${MAX_LOCK_CLASH_RETRIES + 1} and was rolled back whole; retrying in ${delay} ms.`,
      );
      await sleep(delay);
    }
  }
}

/**
 * Applies the SQL files in `directory` that have not run yet, oldest first, each in its own transaction. A file that
 * loses a deadlock or lock-timeout clash with live traffic is run again (see `applyFile`).
 *
 * @throws Error when a file name is wrong, a number is used twice, an applied file was edited afterwards, or a file fails.
 * @throws MigrationLockClashError when a file lost the lock clash on every attempt.
 */
export async function migrate(
  client: Client,
  directory: string,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).toSorted();
  checkNames(names);

  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migration (
         version    text PRIMARY KEY,
         checksum   text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       );
       ALTER TABLE schema_migration ENABLE ROW LEVEL SECURITY;
       ALTER TABLE schema_migration FORCE ROW LEVEL SECURITY;
       REVOKE ALL ON schema_migration FROM PUBLIC;`,
    );
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migration",
    );
    const done = new Map(rows.map((row) => [row.version, row.checksum]));

    const applied: string[] = [];
    const alreadyApplied: string[] = [];
    for (const name of names) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = done.get(name);
      if (previous === undefined) {
        await applyFile(client, { name, sql, checksum }, options);
        applied.push(name);
      } else if (previous === checksum) {
        alreadyApplied.push(name);
      } else {
        throw new Error(
          `Migration ${name} was changed after it was applied. Add a new migration instead of editing it.`,
        );
      }
    }
    return { applied, alreadyApplied };
  } finally {
    // A lost connection already dropped the session lock; its error must not hide the one that ended the run.
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
  }
}
