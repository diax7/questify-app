import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { migrate } from "#src/db/migrate";

/** Admin connection string of a throw-away PostgreSQL server. Integration tests are skipped when it is not set. */
export const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

// In CI the database tests are the security proof (outsider, isolation, sign-in). A missing database must turn CI red,
// never quietly skip them.
if (process.env["CI"] !== undefined && TEST_DATABASE_URL === undefined) {
  throw new Error(
    "TEST_DATABASE_URL is not set in CI, so the database and security tests would be skipped.",
  );
}

const API_ROOT = join(import.meta.dirname, "..", "..");
const ROLE_PASSWORD = "test-only-password";
const ROLE_SETUP_LOCK = 7_361_903;
/** No test file runs this long; an older database was left by a run that was killed before it could drop it. */
const STALE_AFTER_SECONDS = 2 * 60 * 60;
/** How many leftovers one new database sweeps, so a large backlog never slows one test file down much. */
const SWEEP_LIMIT = 20;
/** How long closing waits for a test's own connections to finish closing before it forces the drop. */
const LINGER_MS = 2000;
const LINGER_STEP_MS = 20;
const NAME = /^questify_test_(?:([0-9]{10})_)?[0-9a-f]{12}$/;

/**
 * Drops test databases left behind by killed runs (a mutation run that was stopped, a crash): names carry their
 * creation time, and anything older than two hours, or from before names carried it, is a leftover. Without this, each
 * killed run leaves its databases and the local server's disk only grows.
 */
async function sweepLeftovers(admin: Client): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'questify_test_%' ORDER BY oid",
  );
  const now = Math.floor(Date.now() / 1000);
  const stale = rows
    .map((row) => row.datname)
    .filter((name) => {
      const born = NAME.exec(name)?.[1];
      return NAME.test(name) && (born === undefined || now - Number(born) > STALE_AFTER_SECONDS);
    })
    .slice(0, SWEEP_LIMIT);
  for (const name of stale) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

export type TestDatabase = Readonly<{
  /** The migration owner (a superuser here). */
  owner: Client;
  /** The running API's role: subject to row-level security. */
  app: Client;
  /** A role with no rights at all. */
  outsider: Client;
  /** Connection string for the API's role, for tests that need a pool. */
  appUrl: string;
  close: () => Promise<void>;
}>;

function urlFor(base: string, database: string, user?: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user !== undefined) {
    url.username = user;
    url.password = ROLE_PASSWORD;
  }
  return url.toString();
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Creates a fresh database, runs the roles script and every migration, and connects the three roles. */
export async function createTestDatabase(
  migrationDirectory = join(API_ROOT, "migrations"),
): Promise<TestDatabase> {
  if (TEST_DATABASE_URL === undefined) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }
  const name = `questify_test_${Math.floor(Date.now() / 1000)}_${randomBytes(6).toString("hex")}`;
  const admin = await connect(TEST_DATABASE_URL);
  await sweepLeftovers(admin);
  await admin.query(`CREATE DATABASE ${name}`);
  // Roles are shared by the whole server, so test files running in parallel must set them one at a time.
  await admin.query("SELECT pg_advisory_lock($1)", [ROLE_SETUP_LOCK]);
  try {
    await admin.query(await readFile(join(API_ROOT, "db", "roles.sql"), "utf8"));
    await admin.query(`ALTER ROLE questify_app PASSWORD '${ROLE_PASSWORD}'`);
    await admin.query(`ALTER ROLE questify_outsider PASSWORD '${ROLE_PASSWORD}'`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [ROLE_SETUP_LOCK]);
  }

  const owner = await connect(urlFor(TEST_DATABASE_URL, name));
  await migrate(owner, migrationDirectory);
  const app = await connect(urlFor(TEST_DATABASE_URL, name, "questify_app"));
  const outsider = await connect(urlFor(TEST_DATABASE_URL, name, "questify_outsider"));

  return {
    owner,
    app,
    outsider,
    appUrl: urlFor(TEST_DATABASE_URL, name, "questify_app"),
    close: async () => {
      await Promise.all([owner.end(), app.end(), outsider.end()]);
      // A test's own pool resolves `end()` before its sockets close; forcing the drop then would terminate them and
      // the pool would raise that as an unhandled error. Wait for them to go, then force whatever is left.
      for (let waited = 0; waited < LINGER_MS; waited += LINGER_STEP_MS) {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
          [name],
        );
        if (rows[0]?.n === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, LINGER_STEP_MS));
      }
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Inserts two organizers with an event each and returns their ids (as the owner, bypassing the rules on purpose). */
export async function seedTwoTenants(owner: Client): Promise<{
  orgA: string;
  orgB: string;
  eventA: string;
  eventB: string;
  playerA: string;
  playerB: string;
}> {
  const one = async (sql: string, values: unknown[] = []): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(sql, values);
    return rows[0]?.id ?? "";
  };
  const orgA = await one(
    "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd') RETURNING id",
  );
  const orgB = await one(
    "INSERT INTO organizer (name, slug) VALUES ('Tabuk Fest', 'tabuk') RETURNING id",
  );
  const eventA = await one(
    "INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at) VALUES ($1, 'NAJD1', 'Tech Fest', 'live', now() - interval '1 hour', now() + interval '30 days') RETURNING id",
    [orgA],
  );
  const eventB = await one(
    "INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at) VALUES ($1, 'TABUK1', 'Winter Fest', 'live', 'private', now() - interval '1 hour', now() + interval '30 days') RETURNING id",
    [orgB],
  );
  const playerA = await one("INSERT INTO player (username) VALUES ('sara_k') RETURNING id");
  const playerB = await one("INSERT INTO player (username) VALUES ('khalid_m') RETURNING id");
  await owner.query(
    "INSERT INTO player_contact (player_id, email) VALUES ($1, 'sara@example.com'), ($2, 'khalid@example.com')",
    [playerA, playerB],
  );
  await owner.query(
    "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
    [orgA, eventA, playerA],
  );
  await owner.query(
    "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
    [orgB, eventB, playerB],
  );
  return { orgA, orgB, eventA, eventB, playerA, playerB };
}

let memberCounter = 0;

/**
 * A staff account that belongs to an organizer, for tests that act in an organizer's name: the database opens an
 * organizer only to its members (migration 0008, "no staff member, no tenant").
 */
export async function addMember(
  owner: Client,
  organizerId: string,
  role: "owner" | "editor" = "owner",
  eventScope: string[] | null = null,
): Promise<string> {
  memberCounter += 1;
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO staff_user (email, password_hash) VALUES ($1, 'unused') RETURNING id",
    [`member${memberCounter}.${randomBytes(3).toString("hex")}@team.test`],
  );
  const id = rows[0]?.id ?? "";
  await owner.query(
    "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, $4)",
    [organizerId, id, role, eventScope],
  );
  return id;
}
