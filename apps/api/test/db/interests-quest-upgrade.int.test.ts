import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
const FILE = "0071_interests_quest.sql";
const PREFIX = "questify-pre-interests-";

/** The plan's lock list: the only table the migration alters or writes. */
const LOCKS = [["questify_quest", "ACCESS EXCLUSIVE"]];

type Sync = { quests: { id: string; xp: number }[] };

/** A database at 0070 where player A already chose interests (a veteran of T-407). */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  for (const file of await readdir(migrations)) {
    if (file < "0071") await cp(join(migrations, file), join(directory, file));
  }
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  const asA = <T>(work: () => Promise<T>) =>
    withRequestContext(db.app, { playerId: ids.playerA }, work);
  await asA(() => db.app.query("SELECT set_preferences(NULL, ARRAY['sport', 'music'])"));
  const ownerUrl = new URL(db.appUrl);
  ownerUrl.username = "postgres";
  ownerUrl.password = "postgres";
  const migration = new Client({ connectionString: ownerUrl.toString() });
  await migration.connect();
  const sql = await readFile(join(migrations, FILE), "utf8");
  const pid =
    (await migration.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
  return {
    db,
    ids,
    asA,
    migration,
    pid,
    sql,
    close: async () => {
      await Promise.all([db.app.query("ROLLBACK"), migration.query("ROLLBACK")]);
      await migration.end();
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

/** The migration's statements outside function bodies, comments removed. */
function statements(sql: string): string[] {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, "$$$$")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((one) => one.replace(/\s+/g, " ").trim())
    .filter((one) => one.length > 0);
}

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "interests quest migration (0071) against live traffic",
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.close();
    });

    const quests = async () =>
      (
        await f.db.owner.query(
          "SELECT id, metric, target, xp, gems, position, status FROM questify_quest ORDER BY position, id",
        )
      ).rows;
    const syncA = async () =>
      (await f.asA(() => f.db.app.query<{ r: Sync }>("SELECT questify_sync() AS r"))).rows[0]?.r;

    it("waits for a sync in flight, then pays a veteran who chose interests once at the next sync", async () => {
      const before = await quests();
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      const inFlight = await f.db.app.query<{ r: Sync }>("SELECT questify_sync() AS r");
      expect(inFlight.rows[0]?.r.quests).toEqual([]);
      await f.migration.query("BEGIN");
      const upgrading = f.migration.query(f.sql);
      expect(await waitingOn(f.db.owner, f.pid)).toEqual(["questify_quest"]);
      await f.db.app.query("COMMIT");
      await upgrading;
      await f.migration.query("COMMIT");

      const after = await quests();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual([
        {
          id: expect.any(String),
          metric: "interests_set",
          target: 1,
          xp: 100,
          gems: 10,
          position: 3,
          status: "active",
        },
      ]);
      const interests = after.at(-1)?.id;
      expect((await syncA())?.quests).toEqual([
        { id: interests, title: expect.any(Object), xp: 100 },
      ]);
      expect((await syncA())?.quests).toEqual([]);
      const { rows } = await f.db.owner.query(
        "SELECT quest_id FROM questify_award WHERE player_id = $1",
        [f.ids.playerA],
      );
      expect(rows).toEqual([{ quest_id: interests }]);
    });

    it("locks every existing table it changes or references up front, and nothing else", async () => {
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
      expect([...touched]).toEqual(["questify_quest"]);
    });
  },
);
