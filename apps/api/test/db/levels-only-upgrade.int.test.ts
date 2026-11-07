import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

const migrations = join(import.meta.dirname, "../../migrations");
const SETTINGS = "0163_levels_only_settings.sql";
const REST = "0164_levels_only.sql";

/** The plan's lock list (plan review 86): live-path order, the strongest mode any later statement needs. */
const LOCKS = [
  ["xp_entry", "ACCESS EXCLUSIVE"],
  ["player", "EXCLUSIVE"],
  ["player_xp", "ACCESS EXCLUSIVE"],
  ["level_reached", "ACCESS EXCLUSIVE"],
  ["achievement_earned", "ACCESS EXCLUSIVE"],
  ["achievement", "SHARE ROW EXCLUSIVE"],
  ["questify_quest", "ACCESS EXCLUSIVE"],
  ["questify_award", "ACCESS EXCLUSIVE"],
  ["gem_shop_item", "ACCESS EXCLUSIVE"],
  ["gem_purchase", "ACCESS EXCLUSIVE"],
  ["gem_entry", "ACCESS EXCLUSIVE"],
  ["item", "ACCESS EXCLUSIVE"],
  ["player_item", "ACCESS EXCLUSIVE"],
  ["level_item", "SHARE ROW EXCLUSIVE"],
  ["souvenir_rule", "SHARE ROW EXCLUSIVE"],
];

/** A database at 0162: player A holds gems, a bought and equipped frame, an unspent balance and a shop audit entry. */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "questify-pre-levels-"));
  for (const file of await readdir(migrations)) {
    if (file < "0163") await cp(join(migrations, file), join(directory, file));
  }
  const db = await createTestDatabase(directory);
  const ids = await seedTwoTenants(db.owner);
  await db.owner.query(
    "INSERT INTO category (event_id, name_en) SELECT $1, 'Upgrade' WHERE NOT EXISTS (SELECT 1 FROM category WHERE event_id = $1)",
    [ids.eventA],
  );
  const quest = async (title: string) =>
    (
      await db.owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, (SELECT id FROM category WHERE event_id = $1 ORDER BY id LIMIT 1), 'enter_code', $2, 10, '{"code":"ABC"}') RETURNING id`,
        [ids.eventA, title],
      )
    ).rows[0]?.id;
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
  const asA = <T>(work: () => Promise<T>) =>
    withRequestContext(db.app, { playerId: ids.playerA }, work);
  await asA(() => scan(first));
  await asA(() => db.app.query("SELECT questify_sync()"));
  await db.owner.query("UPDATE player_xp SET gems = 500 WHERE player_id = $1", [ids.playerA]);
  await asA(() => db.app.query("SELECT gem_buy('shop-falcon-ring', 110, gen_random_uuid())"));
  await asA(() => db.app.query(`SELECT equip_player('{"frameId": "shop-falcon-ring"}')`));
  await db.owner.query(
    `INSERT INTO audit_log (actor_type, action, target_type, target_id, before, after)
     VALUES ('system', 'catalog.gem_shop.update', 'gem_shop_item', 'shop-map-reader', '{"price": 40}', '{"price": 45}')`,
  );
  const ownerUrl = new URL(db.appUrl);
  ownerUrl.username = "postgres";
  ownerUrl.password = "postgres";
  const connect = async () => {
    const client = new Client({ connectionString: ownerUrl.toString() });
    await client.connect();
    return client;
  };
  const migration = await connect();
  const reader = await connect();
  const appUrl = new URL(db.appUrl);
  const syncing = new Client({ connectionString: appUrl.toString() });
  await syncing.connect();
  const settings = await readFile(join(migrations, SETTINGS), "utf8");
  const rest = await readFile(join(migrations, REST), "utf8");
  return {
    db,
    ids,
    next,
    scan,
    asA,
    migration,
    reader,
    syncing,
    settings,
    rest,
    close: async () => {
      await Promise.all(
        [db.app, migration, reader, syncing].map((one) => one.query("ROLLBACK").catch(() => null)),
      );
      await Promise.all([migration, reader, syncing].map((one) => one.end()));
      await db.close();
      if (
        dirname(resolvePath(directory)) !== resolvePath(tmpdir()) ||
        !basename(directory).startsWith("questify-pre-levels-")
      )
        throw new Error("unsafe temporary fixture path");
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitingOn(observer: Client, pid: number): Promise<string[]> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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

const pidOf = async (client: Client) =>
  (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;

describe.skipIf(TEST_DATABASE_URL === undefined)("levels only (0163 and 0164) on live data", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f?.close();
  });

  const run = async () => {
    await f.migration.query("BEGIN");
    await f.migration.query(f.settings);
    await f.migration.query("COMMIT");
    await f.migration.query("BEGIN");
    await f.migration.query(f.rest);
    await f.migration.query("COMMIT");
  };

  it("removes every gem object, keeps the bought frame owned and equipped, and leaves points and XP as they were", async () => {
    const snapshot = async () =>
      (
        await f.db.owner.query(
          `SELECT (SELECT jsonb_agg(l ORDER BY l.id) FROM ledger_entry l) AS ledger,
                  (SELECT jsonb_agg(e ORDER BY e.id) FROM (SELECT id, score, balance FROM enrollment) e) AS scores,
                  (SELECT jsonb_agg(x ORDER BY x.id) FROM (SELECT id, player_id, delta, source FROM xp_entry) x) AS xp,
                  (SELECT jsonb_agg(p ORDER BY p.player_id) FROM (SELECT player_id, xp, level FROM player_xp) p) AS levels`,
        )
      ).rows[0];
    const before = await snapshot();
    await run();
    expect(await snapshot()).toEqual(before);

    const named = await f.db.owner.query(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname ~ '(^|_)gems?(_|$)' OR p.prosrc ~ 'gem_')
       UNION ALL
       SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname ~ '(^|_)gems?(_|$)'
       UNION ALL
       SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND a.attname ~ '(^|_)gems?(_|$)' AND NOT a.attisdropped AND c.relkind = 'r'
       UNION ALL
       SELECT t.tgname FROM pg_trigger t WHERE t.tgname ~ '(^|_)gems?(_|$)'
       UNION ALL
       SELECT c.conname FROM pg_constraint c WHERE c.conname ~ '(^|_)gems?(_|$)'`,
    );
    expect(named.rows).toEqual([]);

    const { rows: owned } = await f.db.owner.query(
      "SELECT source, source_level, source_rule_id, source_event_id, source_achievement_id, source_tier FROM player_item WHERE player_id = $1 AND item_id = 'shop-falcon-ring'",
      [f.ids.playerA],
    );
    expect(owned).toEqual([
      {
        source: "questify",
        source_level: null,
        source_rule_id: null,
        source_event_id: null,
        source_achievement_id: null,
        source_tier: null,
      },
    ]);
    const { rows: equipped } = await f.db.owner.query(
      "SELECT frame_id FROM player_equipment WHERE player_id = $1",
      [f.ids.playerA],
    );
    expect(equipped).toEqual([{ frame_id: "shop-falcon-ring" }]);

    const { rows: guard } = await f.db.owner.query(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'owned_item_guard' AND tgrelid = 'player_item'::regclass",
    );
    expect(guard).toEqual([{ tgenabled: "A" }]);
    await expect(
      f.db.owner.query("UPDATE player_item SET source = 'level' WHERE player_id = $1", [
        f.ids.playerA,
      ]),
    ).rejects.toThrow(/acknowledged or erased/);

    const { rows: audit } = await f.db.owner.query(
      "SELECT 1 FROM audit_log WHERE action = 'catalog.gem_shop.update'",
    );
    expect(audit).toHaveLength(1);
    const { rows: setting } = await f.db.owner.query(
      "SELECT key FROM platform_setting WHERE key = 'gems'",
    );
    expect(setting).toEqual([]);

    const { rows: seeded } = await f.db.owner.query(
      "SELECT achievement_id, tier, item_id FROM achievement_item ORDER BY achievement_id",
    );
    expect(seeded).toEqual([
      { achievement_id: "cities-played", tier: "gold", item_id: "shop-dune-ring" },
      { achievement_id: "community-goals", tier: "gold", item_id: "shop-pearl-ring" },
      { achievement_id: "events-attended", tier: "gold", item_id: "shop-compass-ring" },
      { achievement_id: "quests-done", tier: "gold", item_id: "shop-falcon-ring" },
      { achievement_id: "top-ten", tier: "gold", item_id: "shop-moon-ring" },
    ]);
  });

  it("pays nothing for tiers earned before it, and skips a seeded item the player bought", async () => {
    await f.db.owner.query(
      "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'quests-done', 'gold')",
      [f.ids.playerA],
    );
    await run();
    const { rows } = await f.asA(() =>
      f.db.app.query<{ r: { achievements: unknown[]; items: unknown[] } }>(
        "SELECT questify_sync() AS r",
      ),
    );
    expect(rows[0]?.r.items).toEqual([]);
    const paid = await f.db.owner.query(
      "SELECT 1 FROM xp_entry WHERE player_id = $1 AND source = 'achievement' AND achievement_id = 'quests-done'",
      [f.ids.playerA],
    );
    expect(paid.rows).toEqual([]);
    const { rows: item } = await f.db.owner.query(
      "SELECT source FROM player_item WHERE player_id = $1 AND item_id = 'shop-falcon-ring'",
      [f.ids.playerA],
    );
    expect(item).toEqual([{ source: "questify" }]);
  });

  it("0163 waits for a scan holding player_xp and completes; the old sync still works before 0164", async () => {
    await f.db.app.query("BEGIN");
    await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
    await f.scan(f.next);
    const pid = await pidOf(f.migration);
    await f.migration.query("BEGIN");
    const settled = f.migration.query(f.settings);
    expect(await waitingOn(f.db.owner, pid)).toContain("platform_setting");
    await f.db.app.query("COMMIT");
    await settled;
    await f.migration.query("COMMIT");
    const { rows } = await f.asA(() =>
      f.db.app.query<{ r: { gems: { earned: number } } }>("SELECT questify_sync() AS r"),
    );
    expect(rows[0]?.r.gems.earned).toBeGreaterThanOrEqual(0);
  });

  /** Today's challenge for the period, then its three answers in the open transaction: the third one finishes the play. */
  async function finishDaily(live: Awaited<ReturnType<typeof fixture>>) {
    const owner = live.db.owner;
    // Started content is frozen by guards that bind the owner too; this throwaway database starts today's challenge.
    await owner.query("ALTER TABLE daily_challenge DISABLE TRIGGER daily_challenge_guard");
    await owner.query(
      "ALTER TABLE daily_challenge_question DISABLE TRIGGER daily_challenge_question_guard",
    );
    const { rows: period } = await owner.query<{ starts_on: string }>(
      "SELECT starts_on::text AS starts_on FROM daily_current('challenge')",
    );
    // One transaction: the challenge must hold its three questions when it commits.
    await owner.query("BEGIN");
    const { rows: made } = await owner.query<{ id: string }>(
      "INSERT INTO daily_challenge (starts_on) VALUES ($1) RETURNING id",
      [period[0]?.starts_on],
    );
    const questions: string[] = [];
    for (const position of [1, 2, 3]) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO daily_question (prompt_ar, prompt_en, options_ar, options_en, answer)
         VALUES ($1, $2, ARRAY['خيار 1', 'خيار 2', 'خيار 3'], ARRAY['Option 1', 'Option 2', 'Option 3'], 2)
         RETURNING id`,
        [`سؤال ${position}`, `Question ${position}`],
      );
      questions.push(rows[0]?.id ?? "");
      await owner.query(
        "INSERT INTO daily_challenge_question (challenge_id, position, question_id) VALUES ($1, $2, $3)",
        [made[0]?.id, position, rows[0]?.id],
      );
    }
    await owner.query("COMMIT");
    for (const [at, question] of questions.entries()) {
      await live.db.app.query(
        "SELECT daily_answer_submit($1::bigint, $2::uuid, $3::smallint, 2::smallint)",
        [made[0]?.id, question, at + 1],
      );
    }
  }

  it.each([
    ["a scan", "scan"],
    ["a sync", "sync"],
    ["a ranking read holding item", "ranking"],
    ["a profile read holding item", "profile"],
    ["a daily challenge finish holding player_xp", "daily"],
  ])("0164 waits for %s in flight and completes with no deadlock", async (_name, kind) => {
    await f.migration.query("BEGIN");
    await f.migration.query(f.settings);
    await f.migration.query("COMMIT");
    await f.db.app.query("BEGIN");
    await f.db.app.query("SELECT set_config('app.player_id', $1, true)", [f.ids.playerA]);
    if (kind === "scan") await f.scan(f.next);
    if (kind === "sync") await f.db.app.query("SELECT questify_sync()");
    if (kind === "ranking") {
      await f.db.app.query("SELECT * FROM ranking_top($1, 10)", [f.ids.eventA]);
    }
    if (kind === "profile") await f.db.app.query("SELECT * FROM own_equipment()");
    if (kind === "daily") await finishDaily(f);
    const pid = await pidOf(f.migration);
    await f.migration.query("BEGIN");
    const upgrading = f.migration.query(f.rest);
    await waitingOn(f.db.owner, pid);
    await f.db.app.query("COMMIT");
    await upgrading;
    await f.migration.query("COMMIT");
    const { rows } = await f.asA(() =>
      f.db.app.query<{ r: { items: unknown[] } }>("SELECT questify_sync() AS r"),
    );
    expect(rows[0]?.r).toHaveProperty("items");
    expect(rows[0]?.r).not.toHaveProperty("gems");
  });

  it("0164 locks every existing table it changes up front, in the plan's order, and never platform_setting", async () => {
    const parts = statements(f.rest);
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
        /\b(?:ALTER TABLE|REFERENCES|INSERT INTO|UPDATE|ON|DROP TABLE) (\w+)/g,
      )) {
        const name = match[1] ?? "";
        if (existing.has(name)) touched.add(name);
      }
    }
    const locked = LOCKS.map(([name]) => name ?? "");
    expect([...touched].filter((name) => !locked.includes(name))).toEqual([]);
    expect(touched.has("platform_setting")).toBe(false);
    expect(/platform_setting/.test(parts.slice(locks.length + 1).join(";"))).toBe(false);
    // Locked without being named: player drains erasures; level_reached loses gem_entry's key; level_item and
    // souvenir_rule hold the exclusive-source map.
    expect(locked.filter((name) => !touched.has(name)).toSorted()).toEqual([
      "level_item",
      "level_reached",
      "player",
      "souvenir_rule",
    ]);
  });

  it("0163 changes platform_setting alone", () => {
    const parts = statements(f.settings);
    const tables = new Set<string>();
    for (const one of parts) {
      for (const match of one.matchAll(/\b(?:ALTER TABLE|DELETE FROM|LOCK TABLE) (\w+)/g)) {
        tables.add(match[1] ?? "");
      }
    }
    expect([...tables]).toEqual(["platform_setting"]);
  });
});
