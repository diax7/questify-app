import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
const FILE = "0067_gems.sql";

/** The plan's lock list (plan review MAJOR-1): live-path order, the strongest mode any later statement needs. */
const LOCKS = [
  ["player", "EXCLUSIVE"],
  ["player_xp", "ACCESS EXCLUSIVE"],
  ["level_reached", "SHARE ROW EXCLUSIVE"],
  ["achievement_earned", "SHARE ROW EXCLUSIVE"],
  ["questify_quest", "ACCESS EXCLUSIVE"],
  ["questify_award", "ACCESS EXCLUSIVE"],
  ["item", "ACCESS EXCLUSIVE"],
  ["player_item", "ACCESS EXCLUSIVE"],
  ["level_item", "SHARE ROW EXCLUSIVE"],
  ["souvenir_rule", "SHARE ROW EXCLUSIVE"],
];

/** A database at 0066 with a player who reached levels 2 to 4, a bronze tier and a seeded Questify award. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "questify-pre-gems-"));
  for (const file of await readdir(migrations)) {
    if (file < "0067") await cp(join(migrations, file), join(directory, file));
  }
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  const quest = async (title: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, (SELECT id FROM category WHERE event_id = $1 ORDER BY id LIMIT 1), 'enter_code', $2, 10, '{"code":"ABC"}') RETURNING id`,
        [ids.eventA, title],
      )
    ).rows[0]?.id;
  await db.owner.query(
    "INSERT INTO category (event_id, name_en) SELECT $1, 'Upgrade' WHERE NOT EXISTS (SELECT 1 FROM category WHERE event_id = $1)",
    [ids.eventA],
  );
  const first = await quest("First");
  const next = await quest("Next");
  await db.owner.query(
    "UPDATE platform_setting SET value = jsonb_build_object('questXp', 1000) WHERE key = 'xp'",
  );
  const scan = (target: string | undefined) =>
    db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
      target,
      randomUUID(),
    ]);
  await withRequestContext(db.app, { playerId: ids.playerA }, () => scan(first));
  await withRequestContext(db.app, { playerId: ids.playerA }, () =>
    db.app.query("SELECT questify_sync()"),
  );
  await db.owner.query(
    "INSERT INTO questify_award (player_id, quest_id) SELECT $1, id FROM questify_quest WHERE metric = 'cities'",
    [ids.playerA],
  );
  const ownerUrl = new URL(db.appUrl);
  ownerUrl.username = "postgres";
  ownerUrl.password = "postgres";
  const migration = new Client({ connectionString: ownerUrl.toString() });
  await migration.connect();
  const sql = await readFile(join(migrations, FILE), "utf8");
  return {
    db,
    ids,
    next,
    scan,
    migration,
    sql,
    close: async () => {
      await Promise.all([db.app.query("ROLLBACK"), migration.query("ROLLBACK")]);
      await migration.end();
      await db.close();
      if (
        dirname(resolvePath(directory)) !== resolvePath(tmpdir()) ||
        !basename(directory).startsWith("questify-pre-gems-")
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
  "gems migration (0067) against live traffic",
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.close();
    });

    it("waits for a scan in flight (platform_setting read, player_xp held), then pays every earlier row once", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      await f.scan(f.next);
      await f.migration.query("BEGIN");
      const pid =
        (await f.migration.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ??
        0;
      const upgrading = f.migration.query(f.sql);
      expect(["player", "player_xp"]).toEqual(
        expect.arrayContaining(await waitingOn(f.db.owner, pid)),
      );
      await f.db.app.query("COMMIT");
      await upgrading;
      await f.migration.query("COMMIT");
      const sync = async () =>
        (
          await withRequestContext(f.db.app, { playerId: f.ids.playerA }, () =>
            f.db.app.query<{ r: { gems: { earned: number; balance: number } } }>(
              "SELECT questify_sync() AS r",
            ),
          )
        ).rows[0]?.r.gems;
      // Levels 2 to 6 (2000 XP) at 20, the bronze tier at 10 and the seeded cities quest at 25.
      expect(await sync()).toEqual({ earned: 135, balance: 135 });
      expect(await sync()).toEqual({ earned: 0, balance: 135 });
      const { rows } = await f.db.owner.query<{ source: string; n: number }>(
        "SELECT source, count(*)::int AS n FROM gem_entry WHERE player_id = $1 GROUP BY source ORDER BY source",
        [f.ids.playerA],
      );
      expect(rows).toEqual([
        { source: "achievement", n: 1 },
        { source: "level", n: 5 },
        { source: "questify", n: 1 },
      ]);
    });

    it("locks every existing table it changes up front, in the plan's order, and never platform_setting", async () => {
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
      const locked = LOCKS.map(([name]) => name ?? "");
      expect([...touched].filter((name) => !locked.includes(name))).toEqual([]);
      expect(touched.has("platform_setting")).toBe(false);
      // Locked without being changed: player drains erasures; level_item and souvenir_rule hold the exclusive-source map.
      expect(locked.filter((name) => !touched.has(name)).toSorted()).toEqual([
        "level_item",
        "player",
        "souvenir_rule",
      ]);
    });
  },
);
