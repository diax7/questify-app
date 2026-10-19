import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { migrate } from "./db/migrate";

/**
 * One-off database administration, run inside the app container (for example `cranl run -- node migrate.cjs`).
 *   (no flag)   apply pending migrations as the owner (DATABASE_ADMIN_URL)
 *   --roles     create the roles first and set the app role password from APP_ROLE_PASSWORD
 *   --check     print what the owner account may do, and change nothing
 *   --verify    connect as the API's own role (DATABASE_URL) and prove its limits, changing nothing
 */
async function verifyAppRole(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL is not set.");
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ who: string; superuser: boolean; bypass_rls: boolean }>(
      `SELECT current_user AS who, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const role = rows[0];
    const staff = await client.query("SELECT count(*)::int AS n FROM staff_user");
    const events = await client.query("SELECT count(*)::int AS n FROM event");
    let blockedWrite = false;
    try {
      await client.query("INSERT INTO staff_user (email, password_hash) VALUES ('x@x.sa', 'x')");
    } catch {
      blockedWrite = true;
    }
    let migrationTableReadable = true;
    try {
      await client.query("SELECT 1 FROM schema_migration");
    } catch {
      migrationTableReadable = false;
    }
    const ok =
      role?.superuser === false &&
      role.bypass_rls === false &&
      staff.rows[0]?.n === 0 &&
      blockedWrite &&
      !migrationTableReadable;
    process.stdout.write(
      `${JSON.stringify({ ok, role: role?.who, superuser: role?.superuser, bypassRls: role?.bypass_rls, staffRowsVisible: staff.rows[0]?.n, eventsVisible: events.rows[0]?.n, unidentifiedInsertBlocked: blockedWrite, migrationTableReadable })}
`,
    );
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--verify")) {
    await verifyAppRole();
    return;
  }
  const url = process.env["DATABASE_ADMIN_URL"];
  if (url === undefined || url === "") {
    throw new Error("DATABASE_ADMIN_URL is not set.");
  }
  const flags = new Set(process.argv.slice(2));
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (flags.has("--check")) {
      const { rows } = await client.query(
        `SELECT current_user AS who, version() AS server,
                r.rolsuper AS superuser, r.rolcreaterole AS can_create_role, r.rolbypassrls AS bypass_rls
         FROM pg_roles r WHERE r.rolname = current_user`,
      );
      process.stdout.write(`${JSON.stringify(rows[0])}\n`);
      return;
    }
    if (flags.has("--roles")) {
      await client.query(await readFile(join(__dirname, "db", "roles.sql"), "utf8"));
      const password = process.env["APP_ROLE_PASSWORD"];
      if (password !== undefined && password !== "") {
        await client.query(`ALTER ROLE questify_app PASSWORD ${client.escapeLiteral(password)}`);
      }
      process.stdout.write("Roles are in place.\n");
    }
    const result = await migrate(client, join(__dirname, "migrations"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Database task failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
