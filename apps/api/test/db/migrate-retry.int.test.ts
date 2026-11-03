import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as waitFor } from "node:timers/promises";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXIT_FAILED,
  EXIT_LOCK_CLASH,
  MigrationLockClashError,
  migrate,
  migrationExitCode,
} from "#src/db/migrate";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/** A file that creates a table, writes a row, then waits for a lock that another session holds. */
const CLASH_FILE = `SET LOCAL lock_timeout = '150ms';
CREATE TABLE half_done (n int);
INSERT INTO ran VALUES (1);
LOCK TABLE contested IN ACCESS EXCLUSIVE MODE;
INSERT INTO half_done VALUES (1);`;
const FIRST_FILE = "CREATE TABLE first_ran (n int); INSERT INTO first_ran VALUES (1);";
const GATE = 424_242;

async function pidOf(client: Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return rows[0]?.pid ?? 0;
}

async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}.`);
    }
    await waitFor(25);
  }
}

describe.skipIf(TEST_DATABASE_URL === undefined)("migrate retries a lock clash", () => {
  let admin: Client;
  let dbName: string;
  let migrator: Client;
  let holder: Client;
  let observer: Client;
  let dir: string;
  let delays: number[];
  let lines: string[];
  let beforeRetry: () => Promise<void>;
  let seenBetween: Array<{ halfDone: string | null; ran: number; recorded: string[] | null }>;

  async function connect(): Promise<Client> {
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${dbName}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  async function isWaiting(pid: number, kind: "relation" | "advisory"): Promise<boolean> {
    const { rowCount } = await observer.query(
      "SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = $2 AND NOT granted",
      [pid, kind],
    );
    return (rowCount ?? 0) > 0;
  }

  /** What the database looks like while the migration waits to retry. */
  async function snapshot(): Promise<(typeof seenBetween)[number]> {
    const { rows } = await migrator.query<(typeof seenBetween)[number]>(
      `SELECT to_regclass('half_done')::text AS "halfDone",
              (SELECT count(*)::int FROM ran) AS ran,
              (SELECT array_agg(version ORDER BY version) FROM schema_migration) AS recorded`,
    );
    return rows[0] ?? { halfDone: null, ran: -1, recorded: null };
  }

  function run(): Promise<Awaited<ReturnType<typeof migrate>>> {
    return migrate(migrator, dir, {
      random: () => 0.5,
      log: (line) => lines.push(line),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        await beforeRetry();
      },
    });
  }

  beforeEach(async () => {
    admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    dbName = `questify_migrate_retry_${randomBytes(6).toString("hex")}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    [migrator, holder, observer] = [await connect(), await connect(), await connect()];
    dir = await mkdtemp(join(tmpdir(), "migrations-retry-"));
    delays = [];
    lines = [];
    seenBetween = [];
    beforeRetry = () => Promise.resolve();
    await migrator.query("CREATE TABLE contested (id int); CREATE TABLE ran (n int)");
  });

  afterEach(async () => {
    await Promise.all([migrator.end(), holder.end(), observer.end()]);
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("rolls a lock timeout back whole, waits, runs the file again and applies it once", async () => {
    await writeFile(join(dir, "0001_first.sql"), FIRST_FILE);
    await writeFile(join(dir, "0002_clash.sql"), CLASH_FILE);
    await holder.query("BEGIN; LOCK TABLE contested IN ACCESS EXCLUSIVE MODE");
    beforeRetry = async () => {
      seenBetween.push(await snapshot());
      await holder.query("ROLLBACK");
    };

    const result = await run();

    expect(result).toEqual({ applied: ["0001_first.sql", "0002_clash.sql"], alreadyApplied: [] });
    expect(seenBetween).toEqual([{ halfDone: null, ran: 0, recorded: ["0001_first.sql"] }]);
    expect(delays).toEqual([1000]);
    expect(lines).toEqual([
      "Migration 0002_clash.sql hit a lock clash (SQLSTATE 55P03) on attempt 1 of 4 and was rolled back whole; retrying in 1000 ms.",
    ]);
    const counts = await migrator.query<{ ran: number; first: number; half: number; rows: number }>(
      `SELECT (SELECT count(*)::int FROM ran) AS ran, (SELECT count(*)::int FROM first_ran) AS first,
              (SELECT count(*)::int FROM half_done) AS half, (SELECT count(*)::int FROM schema_migration) AS rows`,
    );
    expect(counts.rows[0]).toEqual({ ran: 1, first: 1, half: 1, rows: 2 });
  });

  it("gives a file that sets no lock timeout the runner's 10 s, so it times out and retries (Q-540)", async () => {
    await writeFile(
      join(dir, "0001_no_timeout.sql"),
      CLASH_FILE.replace("SET LOCAL lock_timeout = '150ms';\n", ""),
    );
    await holder.query("BEGIN; LOCK TABLE contested IN ACCESS EXCLUSIVE MODE");
    beforeRetry = async () => {
      await holder.query("ROLLBACK");
    };
    const started = Date.now();

    const result = await run();

    expect(result.applied).toEqual(["0001_no_timeout.sql"]);
    expect(lines).toEqual([
      "Migration 0001_no_timeout.sql hit a lock clash (SQLSTATE 55P03) on attempt 1 of 4 and was rolled back whole; retrying in 1000 ms.",
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500);
  }, 40_000);

  it("retries a real deadlock that aborts the migration, and applies the file once", async () => {
    await migrator.query("CREATE TABLE a (id int); CREATE TABLE b (id int)");
    await writeFile(
      join(dir, "0001_deadlock.sql"),
      `CREATE TABLE migrated (n int);
       LOCK TABLE a IN ACCESS EXCLUSIVE MODE;
       SELECT pg_advisory_xact_lock(${GATE});
       LOCK TABLE b IN ACCESS EXCLUSIVE MODE;
       INSERT INTO migrated VALUES (1);`,
    );
    // The migration checks for a deadlock after 200 ms and the other session after 30 s, so when the cycle closes the
    // migration is the one PostgreSQL aborts.
    await migrator.query("SET deadlock_timeout = '200ms'");
    await holder.query("SET deadlock_timeout = '30s'");
    await holder.query("BEGIN; LOCK TABLE b IN ACCESS EXCLUSIVE MODE");
    await observer.query("SELECT pg_advisory_lock($1)", [GATE]);
    const migratorPid = await pidOf(migrator);
    const holderPid = await pidOf(holder);
    let holderGetsA: Promise<unknown> = Promise.resolve();
    beforeRetry = async () => {
      await holderGetsA;
      await holder.query("ROLLBACK");
    };

    const running = run();
    await eventually(() => isWaiting(migratorPid, "advisory"), "the migration to wait at the gate");
    holderGetsA = holder.query("LOCK TABLE a IN ACCESS EXCLUSIVE MODE");
    await eventually(() => isWaiting(holderPid, "relation"), "the other session to wait for a");
    await observer.query("SELECT pg_advisory_unlock($1)", [GATE]);
    const result = await running;

    expect(result).toEqual({ applied: ["0001_deadlock.sql"], alreadyApplied: [] });
    expect(delays).toEqual([1000]);
    expect(lines).toEqual([
      "Migration 0001_deadlock.sql hit a lock clash (SQLSTATE 40P01) on attempt 1 of 4 and was rolled back whole; retrying in 1000 ms.",
    ]);
    const migrated = await migrator.query("SELECT n FROM migrated");
    expect(migrated.rows).toEqual([{ n: 1 }]);
  });

  it("fails on the fourth clash with the SQLSTATE, leaves nothing of the file, and is safe to run again", async () => {
    await writeFile(join(dir, "0001_first.sql"), FIRST_FILE);
    await writeFile(join(dir, "0002_clash.sql"), CLASH_FILE);
    await holder.query("BEGIN; LOCK TABLE contested IN ACCESS EXCLUSIVE MODE");
    beforeRetry = async () => {
      seenBetween.push(await snapshot());
    };

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MigrationLockClashError);
    expect(error).toMatchObject({ file: "0002_clash.sql", sqlstate: "55P03", attempts: 4 });
    expect((error as Error).message).toContain("SQLSTATE 55P03, lock timeout");
    expect(migrationExitCode(error)).toBe(EXIT_LOCK_CLASH);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => /attempt (\d) of 4/.exec(line)?.[1])).toEqual(["1", "2", "3"]);
    expect(seenBetween).toEqual(
      Array.from({ length: 3 }, () => ({ halfDone: null, ran: 0, recorded: ["0001_first.sql"] })),
    );
    const after = await snapshot();
    expect(after).toEqual({ halfDone: null, ran: 0, recorded: ["0001_first.sql"] });

    await holder.query("ROLLBACK");
    const again = await run();
    expect(again).toEqual({ applied: ["0002_clash.sql"], alreadyApplied: ["0001_first.sql"] });
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it.each([
    ["an undefined function", "42883", "SELECT nonsense();"],
    [
      "a duplicate key",
      "23505",
      "CREATE TABLE u (id int PRIMARY KEY); INSERT INTO u VALUES (1), (1);",
    ],
    ["a statement timeout", "57014", "SET LOCAL statement_timeout = '50ms'; SELECT pg_sleep(2);"],
  ])("fails at once, without a retry, on %s (%s)", async (_label, sqlstate, statement) => {
    await writeFile(join(dir, "0001_bad.sql"), `CREATE TABLE half_done (n int); ${statement}`);

    const error = await run().catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(MigrationLockClashError);
    expect((error as Error).message).toMatch(
      /^Migration 0001_bad.sql failed and was rolled back: /,
    );
    expect((error as Error & { cause: { code: string } }).cause.code).toBe(sqlstate);
    expect(migrationExitCode(error)).toBe(EXIT_FAILED);
    expect(delays).toEqual([]);
    expect(lines).toEqual([]);
    expect(await snapshot()).toEqual({ halfDone: null, ran: 0, recorded: null });
  });
});
