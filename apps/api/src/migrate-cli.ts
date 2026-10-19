import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { migrate } from "./db/migrate";

/**
 * One-off database administration, run inside the app container (for example `cranl run -- node migrate.cjs`).
 *   (no flag)   apply pending migrations as the owner (DATABASE_ADMIN_URL)
 *   --roles     create the roles first and set the app role password from APP_ROLE_PASSWORD
 *   --check     print what the owner account may do, and change nothing
 */
async function main(): Promise<void> {
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
