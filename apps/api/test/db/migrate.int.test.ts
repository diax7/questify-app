import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { migrate } from "#src/db/migrate";
import { TEST_DATABASE_URL } from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("migrate", () => {
  let admin: Client;
  let scratch: Client;
  let dir: string;
  const dbName = `questify_migrate_${Date.now()}`;

  beforeAll(async () => {
    admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(TEST_DATABASE_URL ?? "");
    url.pathname = `/${dbName}`;
    scratch = new Client({ connectionString: url.toString() });
    await scratch.connect();
    dir = await mkdtemp(join(tmpdir(), "migrations-"));
  });

  afterAll(async () => {
    await scratch.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("applies new files once, in order, and skips them next time", async () => {
    await writeFile(join(dir, "0001_one.sql"), "CREATE TABLE one (id int);");
    await writeFile(join(dir, "0002_two.sql"), "CREATE TABLE two (id int);");
    const first = await migrate(scratch, dir);
    expect(first).toEqual({ applied: ["0001_one.sql", "0002_two.sql"], alreadyApplied: [] });
    const second = await migrate(scratch, dir);
    expect(second).toEqual({ applied: [], alreadyApplied: ["0001_one.sql", "0002_two.sql"] });
  });

  it("applies only the new file when one is added", async () => {
    await writeFile(join(dir, "0003_three.sql"), "CREATE TABLE three (id int);");
    const result = await migrate(scratch, dir);
    expect(result.applied).toEqual(["0003_three.sql"]);
  });

  it("refuses a file edited after it was applied", async () => {
    await writeFile(join(dir, "0001_one.sql"), "CREATE TABLE one (id int, extra int);");
    await expect(migrate(scratch, dir)).rejects.toThrow(
      /0001_one.sql was changed after it was applied/,
    );
    await writeFile(join(dir, "0001_one.sql"), "CREATE TABLE one (id int);");
  });

  it("rolls back a failing migration and records nothing", async () => {
    await writeFile(join(dir, "0004_bad.sql"), "CREATE TABLE four (id int); SELECT nonsense();");
    await expect(migrate(scratch, dir)).rejects.toThrow(/0004_bad.sql failed and was rolled back/);
    const { rows } = await scratch.query("SELECT to_regclass('four') AS table_name");
    expect(rows[0]?.table_name).toBeNull();
    const recorded = await scratch.query(
      "SELECT 1 FROM schema_migration WHERE version = '0004_bad.sql'",
    );
    expect(recorded.rowCount).toBe(0);
    await rm(join(dir, "0004_bad.sql"));
  });

  it("rejects a badly named file", async () => {
    await writeFile(join(dir, "oops.sql"), "SELECT 1;");
    await expect(migrate(scratch, dir)).rejects.toThrow(/must be named like/);
    await rm(join(dir, "oops.sql"));
  });

  it("rejects two files with the same number", async () => {
    await writeFile(join(dir, "0003_other.sql"), "SELECT 1;");
    await expect(migrate(scratch, dir)).rejects.toThrow(/Two migration files use the number 0003/);
    await rm(join(dir, "0003_other.sql"));
  });
});
