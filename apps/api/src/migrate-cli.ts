import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { appRoleReport } from "./db/app-role-report";
import { migrate, migrationExitCode } from "./db/migrate";

/**
 * One-off database administration, run inside the app container (for example `cranl run -- node migrate.cjs`).
 *   (no flag)   apply pending migrations as the owner (DATABASE_ADMIN_URL); a deadlock or lock timeout on a file is
 *               retried (stderr names each retry). Exit 0: all applied. Exit 75: a file lost the clash on every
 *               attempt and rolled back whole, so running it again is safe. Exit 1: any other failure.
 *   --roles     create the roles first and set the app role password from APP_ROLE_PASSWORD
 *   --check     print what the owner account may do, and change nothing
 *   --verify    connect as the API's own role (DATABASE_URL) and prove its limits, changing nothing
 *   --media     the same for the media database (T-814, ADR-839): its own series (media-migrations, `m0001_…`) as its
 *               owner (MEDIA_DATABASE_ADMIN_URL); with --roles the media role first (MEDIA_ROLE_PASSWORD); with
 *               --verify the media role (MEDIA_DATABASE_URL) and its limits. Same exit codes.
 */
async function verifyMediaRole(): Promise<void> {
  const client = await connected("MEDIA_DATABASE_URL");
  try {
    const { rows } = await client.query<{ who: string; plain: boolean }>(
      `SELECT current_user AS who, NOT (r.rolsuper OR r.rolbypassrls) AS plain
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const tableReadable = await client.query("SELECT 1 FROM media_blob LIMIT 1").then(
      () => true,
      () => false,
    );
    const page = await client.query("SELECT key FROM blob_keys_page(NULL, now(), 1)");
    const definersRun = page.rowCount !== null;
    const ok = rows[0]?.plain === true && !tableReadable && definersRun;
    process.stdout.write(
      `${JSON.stringify({ ok, role: rows[0]?.who, plainRole: rows[0]?.plain, tableReadable, definersRun })}\n`,
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

async function connected(variable: string): Promise<Client> {
  const url = process.env[variable];
  if (url === undefined || url === "") {
    throw new Error(`${variable} is not set.`);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** `--media` without `--verify`: the media role (with --roles), then the media series, as the media database's owner. */
async function migrateMedia(flags: ReadonlySet<string>): Promise<void> {
  const client = await connected("MEDIA_DATABASE_ADMIN_URL");
  try {
    if (flags.has("--roles")) {
      await client.query(await readFile(join(__dirname, "db", "media-roles.sql"), "utf8"));
      const password = process.env["MEDIA_ROLE_PASSWORD"];
      if (password !== undefined && password !== "") {
        await client.query(
          `ALTER ROLE questify_media_app PASSWORD ${client.escapeLiteral(password)}`,
        );
      }
      process.stdout.write("The media role is in place.\n");
    }
    const result = await migrate(client, join(__dirname, "media-migrations"), { series: "media" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}

/** Whether an insert into staff_user without an identity is refused. */
async function unidentifiedInsertBlocked(client: Client): Promise<boolean> {
  try {
    await client.query("INSERT INTO staff_user (email, password_hash) VALUES ('x@x.sa', 'x')");
    return false;
  } catch {
    return true;
  }
}

/**
 * The community tick's settle point reads the API's own sessions through a definer owned by the migration owner,
 * which sees them only as a superuser or with questify_app's privileges (ADR-224, migration 0053).
 */
async function ownerSeesSessions(client: Client): Promise<boolean> {
  const settler = await client.query<{ sees: boolean }>(
    `SELECT r.rolsuper OR pg_has_role(r.oid, 'questify_app', 'USAGE') AS sees
     FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = 'public.community_settle_point()'::regprocedure`,
  );
  return settler.rows[0]?.sees === true;
}

async function migrationTableReadable(client: Client): Promise<boolean> {
  try {
    await client.query("SELECT 1 FROM schema_migration");
    return true;
  } catch {
    return false;
  }
}

async function verifyAppRole(): Promise<void> {
  const client = await connected("DATABASE_URL");
  try {
    const { rows } = await client.query<{ who: string; superuser: boolean; bypass_rls: boolean }>(
      `SELECT current_user AS who, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const staff = await client.query("SELECT count(*)::int AS n FROM staff_user");
    const events = await client.query("SELECT count(*)::int AS n FROM event");
    const blockedWrite = await unidentifiedInsertBlocked(client);
    const sees = await ownerSeesSessions(client);
    const report = appRoleReport({
      role: rows[0],
      staffRows: staff.rows[0]?.n,
      eventRows: events.rows[0]?.n,
      blockedWrite,
      migrationTableReadable: await migrationTableReadable(client),
      ownerSeesSessions: sees,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if (!flags.has("--media")) return mainDatabase();
  return flags.has("--verify") ? verifyMediaRole() : migrateMedia(flags);
}

async function mainDatabase(): Promise<void> {
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
  process.exit(migrationExitCode(error));
});
