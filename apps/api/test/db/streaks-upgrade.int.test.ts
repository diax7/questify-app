import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
const FILE = "0068_streaks.sql";
const PREFIX = "questify-pre-streaks-";

/** The plan's lock list: live-path order, the strongest mode any later statement needs; never player or platform_setting. */
const LOCKS = [
  ["enrollment", "EXCLUSIVE"],
  ["event", "SHARE ROW EXCLUSIVE"],
  ["quest_completion", "SHARE ROW EXCLUSIVE"],
  ["xp_entry", "ACCESS EXCLUSIVE"],
  ["ledger_entry", "ACCESS EXCLUSIVE"],
  ["player_xp", "SHARE ROW EXCLUSIVE"],
];

/** A database at 0067 with player A's first completion in a live multi-day event and a second quest to scan. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  for (const file of await readdir(migrations)) {
    if (file < "0068") await cp(join(migrations, file), join(directory, file));
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
  const sql = await readFile(join(migrations, FILE), "utf8");
  const pid =
    (await migration.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
  return {
    db,
    ids,
    first,
    next,
    scan,
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
  "streaks migration (0068) against live traffic",
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
    const dayRows = async () =>
      (
        await f.db.owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM event_streak_day d JOIN enrollment n ON n.id = d.enrollment_id WHERE n.player_id = $1",
          [f.ids.playerA],
        )
      ).rows[0]?.n;

    it("waits for a scan in flight (its enrollment held, its entry written), then the next scan writes the day", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      await f.scan(f.next);
      await upgrade(async () => {
        await f.db.app.query("COMMIT");
      }, ["enrollment"]);
      expect(await dayRows()).toBe(0);
      await f.asA(() => f.scan(f.next));
      expect(await dayRows()).toBe(1);
      expect(
        (
          await f.db.owner.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM questify_streak_day WHERE player_id = $1",
            [f.ids.playerA],
          )
        ).rows[0]?.n,
      ).toBe(1);
    });

    it("waits for a sync in flight (player_xp held, xp_entry written), and the sync after it answers the streak", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      const paid = await f.db.app.query<{ r: { gems: { earned: number } } }>(
        "SELECT questify_sync() AS r",
      );
      expect(paid.rows[0]?.r.gems.earned).toBeGreaterThan(0);
      await upgrade(async () => {
        await f.db.app.query("COMMIT");
      }, ["xp_entry", "enrollment", "player_xp"]);
      await f.asA(() => f.scan(f.next));
      const after = await f.asA(() =>
        f.db.app.query<{ r: { dailyStreak: { days: number } | null } }>(
          "SELECT questify_sync() AS r",
        ),
      );
      expect(after.rows[0]?.r.dailyStreak).toMatchObject({ days: 1, rewards: [] });
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
      const locked = LOCKS.map(([name]) => name ?? "");
      expect([...touched].toSorted()).toEqual(locked.toSorted());
      expect(touched.has("platform_setting")).toBe(false);
      expect(touched.has("player")).toBe(false);
    });
  },
);
