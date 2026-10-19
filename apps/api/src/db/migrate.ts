import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "pg";

/** Held while migrating so two servers starting together cannot both run the same migration. */
const LOCK_KEY = 7_361_902;
const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export type MigrationResult = Readonly<{ applied: string[]; alreadyApplied: string[] }>;

/**
 * Applies the SQL files in `directory` that have not run yet, oldest first, each in its own transaction.
 *
 * @throws Error when a file name is wrong, a number is used twice, or an applied file was edited afterwards.
 */
export async function migrate(client: Client, directory: string): Promise<MigrationResult> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).toSorted();
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
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${name} was changed after it was applied. Add a new migration instead of editing it.`,
          );
        }
        alreadyApplied.push(name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)", [
          name,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(
          `Migration ${name} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      applied.push(name);
    }
    return { applied, alreadyApplied };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
