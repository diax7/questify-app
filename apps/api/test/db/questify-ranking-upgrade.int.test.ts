import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
} from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
const FILE = "0072_questify_ranking.sql";
const PREFIX = "questify-pre-ranking-";

/**
 * The lock list: xp_entry (every XP payer writes it before player_xp.xp), then player SHARE for its new index (no
 * writer of player touches xp_entry). No key to player_xp, so no player_xp row lock.
 */
// The backfill check also reads player_xp, but only with ACCESS SHARE (a plain read), so it is not listed.
const LOCKS = [
  ["xp_entry", "ACCESS EXCLUSIVE"],
  ["player", "SHARE"],
];

/**
 * A database at 0071 with veterans: player A's credit moved back into last month and removed this month, plus a new
 * credit; player B's "set your interests" award (a `questify` entry). A third quest is left for a scan in flight.
 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  for (const file of await readdir(migrations)) {
    if (file < "0072") await cp(join(migrations, file), join(directory, file));
  }
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  const staff = await addMember(db.owner, ids.orgA, "owner");
  await db.owner.query("INSERT INTO category (event_id, name_en) VALUES ($1, 'Upgrade')", [
    ids.eventA,
  ]);
  const quest = async (title: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, (SELECT id FROM category WHERE event_id = $1 ORDER BY id LIMIT 1), 'enter_code', $2, 10, 1,
                 '{"code":"ABC"}') RETURNING id`,
        [ids.eventA, title],
      )
    ).rows[0]?.id ?? "";
  const scan = (target: string) =>
    db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
      target,
      randomUUID(),
    ]);
  const as = <T>(player: string, work: () => Promise<T>) =>
    withRequestContext(db.app, { playerId: player }, work);
  const old = await quest("Old");
  await as(ids.playerA, () => scan(old));
  await db.owner.query("ALTER TABLE xp_entry DISABLE TRIGGER xp_entry_no_update_or_delete");
  await db.owner.query(
    "UPDATE xp_entry SET created_at = created_at - interval '40 days' WHERE player_id = $1",
    [ids.playerA],
  );
  await db.owner.query("ALTER TABLE xp_entry ENABLE ALWAYS TRIGGER xp_entry_no_update_or_delete");
  const credit = (
    await db.owner.query<{ id: string }>(
      "SELECT id FROM ledger_entry WHERE quest_id = $1 AND kind = 'quest'",
      [old],
    )
  ).rows[0]?.id;
  await withRequestContext(db.app, { organizerId: ids.orgA, staffUserId: staff }, () =>
    db.app.query("SELECT * FROM remove_award($1, $2, 'cheat', $3, $4)", [
      ids.eventA,
      credit,
      randomUUID(),
      randomUUID(),
    ]),
  );
  await as(ids.playerA, async () => scan(await quest("New")));
  await as(ids.playerB, async () => {
    await db.app.query("SELECT set_preferences(NULL, ARRAY['music'])");
    await db.app.query("SELECT questify_sync()");
  });
  const next = await quest("Next");
  const ownerUrl = new URL(db.appUrl);
  ownerUrl.username = "postgres";
  ownerUrl.password = "postgres";
  const migration = new Client({ connectionString: ownerUrl.toString() });
  await migration.connect();
  const other = new Client({ connectionString: ownerUrl.toString() });
  await other.connect();
  const sql = await readFile(join(migrations, FILE), "utf8");
  const pid =
    (await migration.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
  return {
    db,
    ids,
    next,
    scan,
    migration,
    other,
    pid,
    sql,
    close: async () => {
      await Promise.all([
        db.app.query("ROLLBACK"),
        migration.query("ROLLBACK"),
        other.query("ROLLBACK"),
      ]);
      await migration.end();
      await other.end();
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

/**
 * Migration 0072 on a database with XP history (T-408, plan "Migration vs live traffic"): the backfill equals the
 * ledger (a removal in its credit's month), the lock list, a scan in flight, a row lock on player_xp that never blocks
 * it, a sign-up in flight, and the check that aborts on a total that disagrees with the ledger.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "ranking migration (0072) on XP history and live traffic",
  () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture();
    });
    afterEach(async () => {
      await f?.close();
    });

    const migrate = async () => {
      await f.migration.query("BEGIN");
      await f.migration.query(f.sql);
      await f.migration.query("COMMIT");
    };
    const boards = async (player: string) =>
      (
        await f.db.owner.query<{ board: string; xp: string; v: string; top: string }>(
          `SELECT b.board, b.xp, b.xp_version AS v,
                  (SELECT max(e.id) FROM xp_entry e WHERE e.player_id = b.player_id
                     AND (b.board = 'all' OR xp_month_of(e.id) = b.board)) AS top
           FROM xp_board b WHERE b.player_id = $1 ORDER BY b.board`,
          [player],
        )
      ).rows;
    const months = async () =>
      (
        await f.db.owner.query<{ now: string; last: string }>(
          "SELECT questify_month(now()) AS now, questify_month(now() - interval '40 days') AS last",
        )
      ).rows[0];

    it("fills both boards from the ledger, a removal on its credit's month, versions the highest ids", async () => {
      await migrate();
      const month = await months();
      const a = await boards(f.ids.playerA);
      expect(a.map((row) => [row.board, Number(row.xp)])).toEqual([
        [month?.last, 0],
        [month?.now, 100],
        ["all", 100],
      ]);
      expect(a.every((row) => row.v === row.top)).toBe(true);
      const b = await boards(f.ids.playerB);
      expect(b.map((row) => [row.board, Number(row.xp)])).toEqual([
        [month?.now, 100],
        ["all", 100],
      ]);
      const totals = await f.db.owner.query<{ ok: boolean }>(
        `SELECT bool_and(coalesce(b.xp, 0) = x.xp) AS ok FROM player_xp x
         LEFT JOIN xp_board b ON b.player_id = x.player_id AND b.board = 'all'`,
      );
      expect(totals.rows[0]?.ok).toBe(true);
    });

    it("locks exactly xp_entry and player up front, and touches no other existing table outside a function", async () => {
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
          /\b(?:ALTER TABLE|REFERENCES|INSERT INTO|UPDATE|ON|FROM|JOIN|DROP FUNCTION) (\w+)/g,
        )) {
          const name = match[1] ?? "";
          if (existing.has(name)) touched.add(name);
        }
      }
      expect([...touched].toSorted()).toEqual(LOCKS.map(([name]) => name ?? "").toSorted());
    });

    it("waits for a scan in flight, whose credit then lands on both boards", async () => {
      await f.db.app.query("BEGIN");
      await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
      await f.scan(f.next);
      await f.migration.query("BEGIN");
      const upgrading = f.migration.query(f.sql);
      expect(await waitingOn(f.db.owner, f.pid)).toEqual(["xp_entry"]);
      await f.db.app.query("COMMIT");
      await upgrading;
      await f.migration.query("COMMIT");
      const month = await months();
      expect((await boards(f.ids.playerA)).map((row) => [row.board, Number(row.xp)])).toEqual([
        [month?.last, 0],
        [month?.now, 200],
        ["all", 200],
      ]);
    });

    it("never waits on a player_xp row lock (as the daily finish holds); that writer's entry lands on the board", async () => {
      await f.other.query("BEGIN");
      await f.other.query("SELECT 1 FROM player_xp WHERE player_id = $1 FOR UPDATE", [
        f.ids.playerB,
      ]);
      await migrate();
      await f.other.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerB]);
      await f.other.query(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [f.ids.orgA, f.ids.eventA, f.ids.playerB],
      );
      await f.other.query("SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
        f.next,
        randomUUID(),
      ]);
      await f.other.query("COMMIT");
      const month = await months();
      expect((await boards(f.ids.playerB)).map((row) => [row.board, Number(row.xp)])).toEqual([
        [month?.now, 200],
        ["all", 200],
      ]);
    });

    it("waits for a sign-up in flight (on player), which completes without waiting on it", async () => {
      await f.other.query("BEGIN");
      await f.other.query("INSERT INTO player (username) VALUES ('ranking_signup')");
      await f.migration.query("BEGIN");
      const upgrading = f.migration.query(f.sql);
      expect(await waitingOn(f.db.owner, f.pid)).toEqual(["player"]);
      await f.other.query("COMMIT");
      await upgrading;
      await f.migration.query("COMMIT");
      const { rows } = await f.db.owner.query(
        "SELECT 1 FROM player p JOIN player_xp x ON x.player_id = p.id WHERE p.username = 'ranking_signup'",
      );
      expect(rows).toHaveLength(1);
    });

    it("finds no writer of player that touches xp_entry (the lock order's premise)", async () => {
      const { rows } = await f.db.owner.query<{ name: string }>(
        `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~* '(insert\\s+into|update)\\s+player\\M'
           AND p.prosrc ~* 'xp_entry' ORDER BY 1`,
      );
      expect(rows).toEqual([]);
    });

    it("aborts when a total disagrees with the ledger", async () => {
      await f.db.owner.query("UPDATE player_xp SET xp = xp + 1 WHERE player_id = $1", [
        f.ids.playerA,
      ]);
      await f.migration.query("BEGIN");
      await expect(f.migration.query(f.sql)).rejects.toThrow(/do not match the XP ledger/);
    });
  },
);
