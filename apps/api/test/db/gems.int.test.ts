import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Gems = { earned: number; balance: number };
type Sync = {
  achievements: { id: string; tier: string }[];
  quests: { id: string; xp: number }[];
  levelUp: null | { level: number };
  gems: Gems;
};
type Entry = {
  source: string;
  delta: number;
  source_level: number | null;
  achievement_id: string | null;
  tier: string | null;
  questify_award_id: string | null;
};
type Quest = { id: string; gems: number; status: string };

const QUEST = {
  campaignId: null,
  metric: "quests",
  target: 1,
  title: { ar: "مهمة", en: "Quest" },
  xp: 1,
  position: 100,
  status: "active",
};

/**
 * Gems earned (T-404, migration 0067, ADR-285, ADR-286): questify_sync pays every level_reached, achievement_earned and
 * paying questify_award row once, from the `gems` setting and the quest's gems; nothing else credits gems, nothing
 * takes them back, and the gem record is append-only and bound to its source rows. After every test, each player's
 * balance equals the sum of their gem entries.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("gems: the ledger and the sync (database)", () => {
  let f: QuestifyFixture;
  let admin = "";
  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('gems@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = row?.id ?? "";
  });
  afterEach(async () => {
    const drift = await f.owner(
      `SELECT x.player_id FROM player_xp x
       WHERE x.gems <> coalesce((SELECT sum(g.delta) FROM gem_entry g WHERE g.player_id = x.player_id), 0)`,
    );
    expect(drift).toEqual([]);
  });
  afterAll(async () => {
    await f.close();
  });

  const sync = async (player: string) =>
    (await f.asPlayer<{ r: Sync }>(player, "SELECT questify_sync() AS r"))[0]?.r as Sync;
  const entries = async (player: string) =>
    f.owner<Entry>(
      `SELECT source, delta, source_level, achievement_id, tier, questify_award_id::text
       FROM gem_entry WHERE player_id = $1 ORDER BY id`,
      [player],
    );
  const bySource = async (player: string, source: string) =>
    (await entries(player)).filter((row) => row.source === source);
  const balanceOf = async (player: string) =>
    Number(
      (
        await f.owner<{ gems: string }>("SELECT gems FROM player_xp WHERE player_id = $1", [player])
      )[0]?.gems,
    );
  const seat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  const saveQuest = async (fields: object, target: string | null = null) =>
    (
      await f.run<{ r: Quest }>(seat(), "SELECT questify_quest_save($1, $2::jsonb, $3) AS r", [
        target,
        JSON.stringify({ ...QUEST, ...fields }),
        randomUUID(),
      ])
    )[0]?.r as Quest;
  const retireQuest = (id: string) =>
    f.run(seat(), "SELECT questify_quest_retire($1, $2)", [id, randomUUID()]);
  /** Runs `work` with the platform's quest XP set to `xp`, then restores 100. */
  const withQuestXp = async (xp: number, work: () => Promise<void>) => {
    await f.owner(
      "UPDATE platform_setting SET value = jsonb_build_object('questXp', $1::int) WHERE key = 'xp'",
      [xp],
    );
    try {
      await work();
    } finally {
      await f.owner("UPDATE platform_setting SET value = '{\"questXp\": 100}' WHERE key = 'xp'");
    }
  };
  /** Runs `work` with the `gems` setting row holding `value`, then removes the row (0067 leaves none). */
  const withAmounts = async (value: object, work: () => Promise<void>) => {
    await f.owner("INSERT INTO platform_setting (key, value) VALUES ('gems', $1)", [
      JSON.stringify(value),
    ]);
    try {
      await work();
    } finally {
      await f.owner("DELETE FROM platform_setting WHERE key = 'gems'");
    }
  };
  const amounts = async () =>
    (
      await f.owner<{ level_up: number; bronze: number; silver: number; gold: number }>(
        "SELECT * FROM gem_amounts()",
      )
    )[0];

  it("pays a level-up and a tier once at the next sync; a replay pays nothing and answers the balance", async () => {
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    expect(await balanceOf(player)).toBe(0);
    const first = await sync(player);
    expect(first.gems).toEqual({ earned: 30, balance: 30 });
    expect(await entries(player)).toEqual([
      expect.objectContaining({ source: "level", delta: 20, source_level: 2 }),
      expect.objectContaining({
        source: "achievement",
        delta: 10,
        achievement_id: "events-attended",
        tier: "bronze",
      }),
    ]);
    expect(await sync(player)).toEqual({
      achievements: [],
      quests: [],
      levelUp: null,
      gems: { earned: 0, balance: 30 },
      // The daily streak (T-405): the plays above counted today.
      dailyStreak: { days: 1, today: true, next: { days: 3, xp: 50 }, rewards: [] },
    });
    expect(await entries(player)).toHaveLength(2);
  });

  it("pays one entry per level of a jump, and nothing for level 1", async () => {
    const player = await f.newPlayer();
    await withQuestXp(1000, async () => {
      await f.play(await f.newEvent(), player);
    });
    await sync(player);
    expect((await bySource(player, "level")).map((row) => [row.source_level, row.delta])).toEqual([
      [2, 20],
      [3, 20],
      [4, 20],
    ]);
  });

  it("pays once when two syncs cross on two connections; only the first reports it", async () => {
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
    const outcome = await f.crossed(call, call);
    expect(outcome.waited).toBe(true);
    expect((outcome.first as { r: Sync }).r.gems).toEqual({ earned: 30, balance: 30 });
    expect((outcome.second as { r: Sync }).r.gems).toEqual({ earned: 0, balance: 30 });
    expect(await entries(player)).toHaveLength(2);
  });

  it("pays each tier its amount; a three-tier jump pays three entries", async () => {
    const player = await f.newPlayer();
    const [seeded] = await f.owner<{ bronze: number; silver: number; gold: number }>(
      "SELECT bronze, silver, gold FROM achievement WHERE id = 'quests-done'",
    );
    await f.owner(
      "UPDATE achievement SET bronze = 1, silver = 2, gold = 3 WHERE id = 'quests-done'",
    );
    try {
      await f.play(await f.newEvent(), player, 3);
      await sync(player);
    } finally {
      await f.owner(
        "UPDATE achievement SET bronze = $1, silver = $2, gold = $3 WHERE id = 'quests-done'",
        [seeded?.bronze, seeded?.silver, seeded?.gold],
      );
    }
    const tiers = (await bySource(player, "achievement")).filter(
      (row) => row.achievement_id === "quests-done",
    );
    expect(tiers.map((row) => [row.tier, row.delta])).toEqual([
      ["bronze", 10],
      ["silver", 25],
      ["gold", 50],
    ]);
  });

  it("pays a quest's gems once with its award; a 0-gem quest writes no entry and is never due", async () => {
    const paying = await saveQuest({ gems: 30 });
    const free = await saveQuest({ gems: 0, position: 101 });
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player);
    const answer = await sync(player);
    expect(answer.quests.map((quest) => quest.id).toSorted()).toEqual(
      [paying.id, free.id].toSorted(),
    );
    const awards = await f.owner<{ id: string; quest_id: string }>(
      "SELECT id::text, quest_id FROM questify_award WHERE player_id = $1",
      [player],
    );
    const awardOf = (quest: string) => awards.find((row) => row.quest_id === quest)?.id;
    expect(
      (await bySource(player, "questify")).map((row) => [row.questify_award_id, row.delta]),
    ).toEqual([[awardOf(paying.id), 30]]);
    expect(answer.gems.earned).toBe(40);
    const [due] = await f.owner<{ due: boolean }>("SELECT gems_due($1) AS due", [player]);
    expect(due?.due).toBe(false);
    expect((await sync(player)).gems.earned).toBe(0);
    await retireQuest(paying.id);
    await retireQuest(free.id);
  });

  it("freezes a quest's gems once it can pay, refuses a bad amount and keeps the value when it is left out", async () => {
    const draft = await saveQuest({ status: "draft", gems: 5 });
    expect((await saveQuest({ status: "draft", gems: 9 }, draft.id)).gems).toBe(9);
    const active = await saveQuest({ status: "active" }, draft.id);
    expect(active.gems).toBe(9);
    await expect(saveQuest({ status: "active", gems: 10 }, draft.id)).rejects.toMatchObject({
      code: "QY409",
      detail: "frozen",
    });
    expect(
      (await saveQuest({ status: "active", title: { ar: "جديد", en: "New" } }, draft.id)).gems,
    ).toBe(9);
    for (const bad of [-1, 1001, 2.5, "5", null]) {
      await expect(saveQuest({ status: "draft", gems: bad })).rejects.toMatchObject({
        code: "QY422",
        detail: "gems",
      });
    }
    expect((await saveQuest({ status: "draft", position: 102 })).gems).toBe(0);
    const audit = await f.owner<{ after: { fields: string[] } }>(
      "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'questify.quest_updated' ORDER BY id LIMIT 1",
      [draft.id],
    );
    expect(audit[0]?.after.fields).toEqual(["gems"]);
    await retireQuest(draft.id);
  });

  it("seeds the two always-on quests at 25 gems", async () => {
    const seeded = await f.owner<{ metric: string; gems: number }>(
      "SELECT metric, gems FROM questify_quest WHERE created_by IS NULL ORDER BY position",
    );
    expect(seeded).toEqual([
      { metric: "events", gems: 25 },
      { metric: "cities", gems: 25 },
    ]);
  });

  it("reads each amount from the setting only when it is an integer 1 to 1000, else falls back", async () => {
    expect(await amounts()).toEqual({ level_up: 20, bronze: 10, silver: 25, gold: 50 });
    await withAmounts({ levelUp: 7, bronze: 0, silver: 1001, gold: 2.5 }, async () => {
      expect(await amounts()).toEqual({ level_up: 7, bronze: 10, silver: 25, gold: 50 });
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player, 2);
      await sync(player);
      expect((await bySource(player, "level")).map((row) => row.delta)).toEqual([7]);
    });
    await withAmounts({ levelUp: "30", bronze: -5, silver: 1000, gold: null }, async () => {
      expect(await amounts()).toEqual({ level_up: 20, bronze: 10, silver: 1000, gold: 50 });
    });
  });

  it("answers a sync with nothing due without a row lock", async () => {
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    await sync(player);
    const url = new URL(f.db.appUrl);
    url.username = "postgres";
    url.password = "postgres";
    const holder = new Client({ connectionString: url.toString() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM player_xp WHERE player_id = $1 FOR UPDATE", [player]);
      await holder.query("SELECT 1 FROM player WHERE id = $1 FOR UPDATE", [player]);
      const answer = await Promise.race([
        sync(player),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("the sync waited on a row lock")), 3000),
        ),
      ]);
      expect(answer.gems).toEqual({ earned: 0, balance: 30 });
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });

  it("refuses a banned or deleted player", async () => {
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [player]);
    await expect(sync(player)).rejects.toMatchObject({ code: "PI401" });
    expect(await entries(player)).toEqual([]);
    await f.owner("UPDATE player SET status = 'active' WHERE id = $1", [player]);
    expect((await sync(player)).gems.earned).toBe(30);
  });

  it("never moves event points, score or XP, and a removal that drops a level takes no gems back", async () => {
    const player = await f.newPlayer();
    const event = await f.newEvent();
    const enrollment = await f.join(event, player);
    const entry = await f.earn(event, enrollment);
    await f.earn(event, enrollment);
    const facts = async () =>
      (
        await f.owner(
          `SELECT n.score, n.balance, x.xp, x.level FROM enrollment n JOIN player_xp x ON x.player_id = n.player_id
           WHERE n.id = $1`,
          [enrollment],
        )
      )[0];
    const before = await facts();
    expect((await sync(player)).gems.earned).toBe(30);
    expect(await facts()).toEqual(before);
    await f.removeEntry(event, entry);
    expect(await facts()).toMatchObject({ level: 1 });
    expect((await sync(player)).gems).toEqual({ earned: 0, balance: 30 });
    expect(await entries(player)).toHaveLength(2);
    expect(await f.owner("SELECT level FROM level_reached WHERE player_id = $1", [player])).toEqual(
      [{ level: 2 }],
    );
  });

  it("has exactly two writers of the gem record: questify_sync and gem_buy", async () => {
    const writers = await f.owner<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+gem_entry\\M'
       ORDER BY 1`,
    );
    expect(writers.map((row) => row.proname)).toEqual(["gem_buy", "questify_sync"]);
    const balance = await f.owner<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc ~* 'set\\s+gems\\s*='
       ORDER BY 1`,
    );
    expect(balance.map((row) => row.proname)).toEqual(["gem_buy", "questify_sync"]);
  });

  it("has no door that names a recipient or another player", async () => {
    const doors = await f.owner<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('questify_app', p.oid, 'EXECUTE')
         AND (p.proname ~ 'gem' OR p.prosrc ~* '(gem_entry|gem_purchase)\\M')
       ORDER BY 1`,
    );
    expect(doors.map((row) => row.signature)).toEqual([
      "gem_buy(text,integer,uuid)",
      "gem_shop()",
      "own_gems()",
      "questify_sync()",
    ]);
    const [shape] = await f.owner<{ args: string[] }>(
      "SELECT proargnames AS args FROM pg_proc WHERE proname = 'gem_buy'",
    );
    expect(shape?.args).toEqual(["chosen", "seen_price", "request"]);
  });

  it("keeps the gem record append-only for every role", async () => {
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    await sync(player);
    await f.owner(
      "INSERT INTO gem_purchase (player_id, item_id, price, request_key) VALUES ($1, 'shop-map-reader', 40, $2)",
      [player, randomUUID()],
    );
    for (const sql of [
      "UPDATE gem_entry SET delta = 99 WHERE player_id = $1",
      "DELETE FROM gem_entry WHERE player_id = $1",
      "UPDATE gem_purchase SET price = 1 WHERE player_id = $1",
      "DELETE FROM gem_purchase WHERE player_id = $1",
    ]) {
      await expect(f.owner(sql, [player]), sql).rejects.toMatchObject({ code: "42501" });
    }
    for (const table of ["gem_entry", "gem_purchase"]) {
      await expect(f.owner(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("refuses an entry that mixes sources or names another player's source row", async () => {
    const owner = await f.newPlayer();
    const other = await f.newPlayer();
    await f.play(await f.newEvent(), owner, 2);
    await sync(owner);
    const [award] = await f.owner<{ id: string }>(
      `INSERT INTO questify_award (player_id, quest_id)
       SELECT $1, id FROM questify_quest WHERE created_by IS NULL ORDER BY position LIMIT 1 RETURNING id::text`,
      [owner],
    );
    const insert = (fields: Record<string, unknown>) => {
      const columns = Object.keys(fields);
      return f.owner(
        `INSERT INTO gem_entry (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(fields),
      );
    };
    const level = { player_id: owner, delta: 5, source: "level", source_level: 2 };
    for (const mixed of [
      { ...level, achievement_id: "events-attended", tier: "bronze" },
      { ...level, questify_award_id: award?.id },
      { ...level, delta: -5 },
      { ...level, source: "achievement" },
      { player_id: owner, delta: 5, source: "questify" },
      { player_id: owner, delta: 5, source: "purchase", source_level: 2 },
      { player_id: owner, delta: 5, source: "gift" },
      { ...level, delta: 0 },
    ]) {
      await expect(insert(mixed), JSON.stringify(mixed)).rejects.toMatchObject({
        code: expect.stringMatching(/^23(514|505)$/),
      });
    }
    for (const foreign of [
      { player_id: other, delta: 5, source: "level", source_level: 2 },
      {
        player_id: other,
        delta: 5,
        source: "achievement",
        achievement_id: "events-attended",
        tier: "bronze",
      },
      { player_id: other, delta: 5, source: "questify", questify_award_id: award?.id },
    ]) {
      await expect(insert(foreign), JSON.stringify(foreign)).rejects.toMatchObject({
        code: "23503",
      });
    }
    // The stray award is paid by the owner's next sync, keeping the balance equal to the record.
    expect((await sync(owner)).gems.earned).toBe(25);
  });

  it("keeps an item to one source: level reward, souvenir or shop, both ways, and freezes a shop item", async () => {
    await expect(
      f.owner("INSERT INTO gem_shop_item (item_id, price, position) VALUES ('level-3', 10, 50)"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.owner("UPDATE level_item SET item_id = 'shop-map-reader' WHERE level = 3"),
    ).rejects.toMatchObject({
      code: "23514",
    });
    const event = await f.newEvent();
    await expect(
      f.owner(
        `INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience)
         SELECT organizer_id, id, 'shop-dune-ring', 'joined' FROM event WHERE id = $1`,
        [event],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await f.owner(
      "INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES ('souvenir-gem-test', 'frame', 'ت', 'T', 'frame-16')",
    );
    await f.owner(
      `INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience)
       SELECT organizer_id, id, 'souvenir-gem-test', 'joined' FROM event WHERE id = $1`,
      [event],
    );
    await expect(
      f.owner(
        "INSERT INTO gem_shop_item (item_id, price, position) VALUES ('souvenir-gem-test', 10, 50)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.owner("UPDATE item SET name_en = 'Other' WHERE id = 'shop-map-reader'"),
    ).rejects.toMatchObject({
      code: "GS409",
      detail: "shop_item_locked",
    });
    await expect(
      f.owner(
        "INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES ('bad-frame', 'frame', 'ت', 'T', 'frame-21')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("answers no gem field on the public profile", async () => {
    const viewer = await f.newPlayer();
    const shown = await f.newPlayer();
    await f.play(await f.newEvent(), shown, 2);
    await sync(shown);
    const [row] = await f.asPlayer<{ p: Record<string, unknown> }>(
      viewer,
      "SELECT public_player_profile($1) AS p",
      [await f.usernameOf(shown)],
    );
    expect(JSON.stringify(row?.p)).not.toMatch(/gem/i);
  });
});
