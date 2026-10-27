import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
const FILE = "0069_daily.sql";
const PREFIX = "questify-pre-daily-";

/**
 * The plan's lock list: live-path order, the strongest mode any later statement needs. Never ledger_entry, enrollment,
 * event, platform_setting, questify_streak_day, staff_user or audit_log.
 */
const LOCKS = [
  ["xp_entry", "ACCESS EXCLUSIVE"],
  ["player", "SHARE ROW EXCLUSIVE"],
  ["player_xp", "SHARE ROW EXCLUSIVE"],
];

/** A database at 0068 with player A's first completion in event A and a second quest to scan. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  for (const file of await readdir(migrations)) {
    if (file < "0069") await cp(join(migrations, file), join(directory, file));
  }
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  await db.owner.query("INSERT INTO category (event_id, name_en) VALUES ($1, 'Upgrade')", [
    ids.eventA,
  ]);
  const quest = async (title: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, (SELECT id FROM category WHERE event_id = $1 ORDER BY id LIMIT 1), 'enter_code', $2, 10, 100,
                 '{"code":"ABC"}') RETURNING id`,
        [ids.eventA, title],
      )
    ).rows[0]?.id ?? "";
  const first = await quest("First");
  const next = await quest("Next");
  const scan = (target: string) =>
    db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
      target,
      randomUUID(),
    ]);
  const asA = <T>(work: () => Promise<T>) =>
    withRequestContext(db.app, { playerId: ids.playerA }, work);
  await asA(() => scan(first));
  const ownerUrl = new URL(db.appUrl);
  ownerUrl.username = "postgres";
  ownerUrl.password = "postgres";
  const migration = new Client({ connectionString: ownerUrl.toString() });
  await migration.connect();
  const signUp = new Client({ connectionString: ownerUrl.toString() });
  await signUp.connect();
  const sql = await readFile(join(migrations, FILE), "utf8");
  const pid =
    (await migration.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
  return {
    db,
    ids,
    next,
    scan,
    asA,
    migration,
    signUp,
    pid,
    sql,
    close: async () => {
      await Promise.all([
        db.app.query("ROLLBACK"),
        migration.query("ROLLBACK"),
        signUp.query("ROLLBACK"),
      ]);
      await migration.end();
      await signUp.end();
      await db.close();
      if (
        dirname(resolvePath(directory)) !== resolvePath(tmpdir()) ||
        !basename(directory).startsWith(PREFIX)
      )
        throw new Error("unsafe temporary fixture path");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitingOn(observer: Client, pid: number): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await observer.query<{ name: string }>(
      "SELECT relation::regclass::text AS name FROM pg_locks WHERE pid = $1 AND NOT granted AND relation IS NOT NULL",
      [pid],
    );
    if (rows.length > 0) return rows.map((row) => row.name);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the migration never waited");
}

/** The functions that insert or update a player row, narrowed by `extra`. */
async function writersOfPlayer(owner: Client, extra: string): Promise<string[]> {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosrc ~* '(insert\\s+into|update)\\s+player\\M' ${extra} ORDER BY 1`,
  );
  return rows.map((row) => row.name);
}

/** The migration's statements outside function bodies, comments removed. */
function statements(sql: string): string[] {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, "$$$$")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((one) => one.replace(/\s+/g, " ").trim())
    .filter((one) => one.length > 0);
}

/**
 * Migration 0069 against live traffic (T-406, plan "Locks", MINOR-4): applied while a sync, a first-time quest
 * completion, a sign-up and a gem purchase are each in flight, every one waits or finishes and the migration completes
 * with no deadlock; the lock list matches the existing tables the SQL alters or references; no writer of `player`
 * touches xp_entry (so player's lock can never wait on a transaction that then needs xp_entry).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "daily migration (0069) against live traffic",
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.close();
    });

    const upgrade = async (inFlight: () => Promise<void>, held: readonly string[]) => {
      await f.migration.query("BEGIN");
      const upgrading = f.migration.query(f.sql);
      expect(held).toEqual(expect.arrayContaining(await waitingOn(f.db.owner, f.pid)));
      await inFlight();
      await upgrading;
      await f.migration.query("COMMIT");
    };
    const xpOk = async () =>
      (
        await f.db.owner.query<{ ok: boolean }>(
          `SELECT bool_and(x.xp = coalesce((SELECT sum(e.delta) FROM xp_entry e WHERE e.player_id = x.player_id), 0)) AS ok
         FROM player_xp x`,
        )
      ).rows[0]?.ok;

    it("waits for a quest completion in flight (its XP written), and the next completion pays as before", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      await f.scan(f.next);
      await upgrade(async () => {
        await f.db.app.query("COMMIT");
      }, ["xp_entry"]);
      expect(await xpOk()).toBe(true);
    });

    it("waits for a sync in flight (player_xp held, xp_entry read), then the sync answers as before", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      await f.db.app.query("SELECT questify_sync() AS r");
      await upgrade(async () => {
        await f.db.app.query("COMMIT");
      }, ["xp_entry", "player", "player_xp"]);
      const after = await f.asA(() =>
        f.db.app.query<{ r: { gems: unknown } }>("SELECT questify_sync() AS r"),
      );
      expect(after.rows[0]?.r).toHaveProperty("gems");
    });

    it("waits for a sign-up in flight (the player row and its XP row written)", async () => {
      await f.signUp.query("BEGIN");
      await f.signUp.query("INSERT INTO player (username) VALUES ('upgrade_signup')");
      await upgrade(async () => {
        await f.signUp.query("COMMIT");
      }, ["player", "player_xp"]);
      const { rows } = await f.db.owner.query(
        "SELECT 1 FROM player p JOIN player_xp x ON x.player_id = p.id WHERE p.username = 'upgrade_signup'",
      );
      expect(rows).toHaveLength(1);
    });

    it("waits for a gem purchase in flight (player_xp updated), which completes", async () => {
      await f.db.owner.query("UPDATE player_xp SET gems = 100 WHERE player_id = $1", [
        f.ids.playerA,
      ]);
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      const bought = await f.db.app.query<{ r: { gems: number } }>(
        "SELECT gem_buy('shop-map-reader', 40, gen_random_uuid()) AS r",
      );
      expect(bought.rows[0]?.r.gems).toBe(60);
      await upgrade(async () => {
        await f.db.app.query("COMMIT");
      }, ["player_xp"]);
      expect(await xpOk()).toBe(true);
    });

    it("holds its locks briefly: with no traffic it runs well inside its lock timeout", async () => {
      const started = performance.now();
      await f.migration.query("BEGIN");
      await f.migration.query(f.sql);
      await f.migration.query("COMMIT");
      // The bound is the migration's own lock_timeout; the time measured by hand is in the plan's build notes.
      expect(performance.now() - started).toBeLessThan(10_000);
    });

    it("locks every existing table it changes or references up front, in the plan's order", async () => {
      const parts = statements(f.sql);
      const locks = parts.filter((one) => one.startsWith("LOCK TABLE"));
      expect(locks.map((one) => /^LOCK TABLE (\w+) IN (.+) MODE$/.exec(one)?.slice(1, 3))).toEqual(
        LOCKS,
      );
      expect(parts.slice(0, locks.length + 1).map((one) => one.split(" ")[0])).toEqual([
        "SET",
        ...locks.map(() => "LOCK"),
      ]);
      const { rows } = await f.db.owner.query<{ name: string }>(
        "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
      );
      const existing = new Set(rows.map((row) => row.name));
      const touched = new Set<string>();
      for (const one of parts.slice(locks.length + 1)) {
        for (const match of one.matchAll(
          /\b(?:ALTER TABLE|REFERENCES|INSERT INTO|UPDATE|ON|DROP FUNCTION) (\w+)/g,
        )) {
          const name = match[1] ?? "";
          if (existing.has(name)) touched.add(name);
        }
      }
      expect([...touched].toSorted()).toEqual(LOCKS.map(([name]) => name ?? "").toSorted());
    });

    it("finds no writer of player that touches xp_entry (the lock order's premise, MINOR-4)", async () => {
      expect(await writersOfPlayer(f.db.owner, "")).toEqual(expect.arrayContaining(["erase_rows"]));
      expect(await writersOfPlayer(f.db.owner, "AND p.prosrc ~* 'xp_entry'")).toEqual([]);
    });
  },
);
