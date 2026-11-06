import { randomUUID } from "node:crypto";
import { levelRewardsSchema } from "@questify/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Doc = Record<string, unknown>;
type Given = { achievementId: string; tier: string; item: { id: string } };
type Sync = {
  achievements: { id: string; tier: string; xp: number }[];
  levelUp: { level: number; items: { id: string }[] } | null;
  items: Given[];
};

const NOTE = "Fraud ticket 4411 confirmed";
const NAME = { ar: "صائد المهام", en: "Quest Hunter" };

const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );
const because = (reason: string) => `CA409:${JSON.stringify({ reason }).replace(":", ": ")}`;

/**
 * T-404c's server rewards (migration 0164; ADR-764 to ADR-767): an achievement tier pays XP once when it is earned, an
 * achievement may unlock one item at a tier the admin picks, event ranking rows carry the level derived from XP, and the
 * player reads their level rewards. A level never buys or changes anything inside an event (ADR-760, FR-415).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("achievement rewards (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('rewards@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
  });
  afterEach(async () => {
    const drift = await f.owner(
      `SELECT x.player_id FROM player_xp x
       WHERE x.xp <> coalesce((SELECT sum(e.delta) FROM xp_entry e WHERE e.player_id = x.player_id), 0)`,
    );
    expect(drift).toEqual([]);
    await f.owner(
      `UPDATE platform_setting SET value = value - 'bronzeXp' - 'silverXp' - 'goldXp' WHERE key = 'xp'`,
    );
  });
  afterAll(async () => {
    await f.close();
  });

  const sync = async (player: string) =>
    (await f.asPlayer<{ r: Sync }>(player, "SELECT questify_sync() AS r"))[0]?.r as Sync;
  const tierXp = (player: string, id: string) =>
    f.owner<{ tier: string; delta: number }>(
      "SELECT tier, delta FROM xp_entry WHERE player_id = $1 AND achievement_id = $2 ORDER BY id",
      [player, id],
    );
  const owned = (player: string) =>
    f.owner<{ item_id: string; source: string; source_tier: string | null }>(
      "SELECT item_id, source, source_tier FROM player_item WHERE player_id = $1 AND source <> 'level' ORDER BY item_id",
      [player],
    );
  const xpOf = async (player: string) =>
    Number(
      (await f.owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]
        ?.xp,
    );
  const setAmounts = (fields: Doc) =>
    f.owner(`UPDATE platform_setting SET value = value || $1 WHERE key = 'xp'`, [fields]);
  /** The achievement's thresholds and map, put back afterwards so the suite's order does not matter. */
  const withAchievement = async (
    id: string,
    change: Readonly<{ thresholds?: [number, number, number]; tier?: string }>,
    work: () => Promise<void>,
  ) => {
    const [before] = await f.owner<{ bronze: number; silver: number; gold: number }>(
      "SELECT bronze, silver, gold FROM achievement WHERE id = $1",
      [id],
    );
    if (change.thresholds !== undefined) {
      const [bronze, silver, gold] = change.thresholds;
      await f.owner("UPDATE achievement SET bronze = $2, silver = $3, gold = $4 WHERE id = $1", [
        id,
        bronze,
        silver,
        gold,
      ]);
    }
    if (change.tier !== undefined) {
      await f.owner("UPDATE achievement_item SET tier = $2 WHERE achievement_id = $1", [
        id,
        change.tier,
      ]);
    }
    try {
      await work();
    } finally {
      await f.owner("UPDATE achievement SET bronze = $2, silver = $3, gold = $4 WHERE id = $1", [
        id,
        before?.bronze,
        before?.silver,
        before?.gold,
      ]);
      await f.owner("UPDATE achievement_item SET tier = 'gold' WHERE achievement_id = $1", [id]);
    }
  };
  const door = async (
    id: string,
    doc: unknown,
    revertOf: string | null = null,
    confirmed = false,
  ) =>
    (
      await f.run<{ r: Doc }>(admin, "SELECT admin_achievement_save($1, $2, $3, $4, $5) AS r", [
        id,
        doc,
        revertOf,
        confirmed,
        randomUUID(),
      ])
    )[0]?.r as Doc;
  const docOf = async (id: string) => {
    const [row] = await f.owner<{ bronze: number; silver: number; gold: number }>(
      "SELECT bronze, silver, gold FROM achievement WHERE id = $1",
      [id],
    );
    return { name: NAME, bronze: row?.bronze, silver: row?.silver, gold: row?.gold };
  };
  const newItem = async (id: string) => {
    await f.owner(
      `INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES ($1, 'frame', 'إطار', 'Frame', 'frame-05')`,
      [id],
    );
    return id;
  };
  const ban = (player: string) =>
    f.run(admin, "SELECT * FROM admin_ban_player($1, 'cheating', $2, $3)", [
      player,
      NOTE,
      randomUUID(),
    ]);

  const top = (reader: string, event: string) =>
    f.asPlayer<{ enrollment_id: string; username: string | null; level: number }>(
      reader,
      "SELECT enrollment_id, username, level FROM ranking_top($1, 10) ORDER BY score DESC",
      [event],
    );
  const read = async (player: string) =>
    levelRewardsSchema.parse(
      (await f.asPlayer<{ r: unknown }>(player, "SELECT own_level_rewards() AS r"))[0]?.r,
    );
  describe("a tier pays XP once when it is earned", () => {
    it("pays bronze 50 by default, once, and a replay pays nothing", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const first = await sync(player);
      expect(first.achievements).toEqual([{ id: "events-attended", tier: "bronze", xp: 50 }]);
      expect(await tierXp(player, "events-attended")).toEqual([{ tier: "bronze", delta: 50 }]);
      expect(await xpOf(player)).toBe(150);
      expect((await sync(player)).achievements).toEqual([]);
      expect(await tierXp(player, "events-attended")).toHaveLength(1);
      expect(await xpOf(player)).toBe(150);
    });

    it("pays three tiers in a jump, their amounts from the setting, and a missing field falls back", async () => {
      await setAmounts({ bronzeXp: 11, goldXp: 33 });
      await f.owner("DELETE FROM achievement_item WHERE achievement_id = 'quests-done'");
      await withAchievement("quests-done", { thresholds: [1, 2, 3] }, async () => {
        const player = await f.newPlayer();
        await f.play(await f.newEvent(), player, 3);
        const answer = await sync(player);
        expect(answer.achievements.filter((row) => row.id === "quests-done")).toEqual([
          { id: "quests-done", tier: "bronze", xp: 11 },
          { id: "quests-done", tier: "silver", xp: 150 },
          { id: "quests-done", tier: "gold", xp: 33 },
        ]);
        expect(await tierXp(player, "quests-done")).toEqual([
          { tier: "bronze", delta: 11 },
          { tier: "silver", delta: 150 },
          { tier: "gold", delta: 33 },
        ]);
      });
      await f.owner(
        "INSERT INTO achievement_item (achievement_id, tier, item_id) VALUES ('quests-done', 'gold', 'shop-falcon-ring')",
      );
    });

    it("writes no entry for an amount of 0 and still earns the tier", async () => {
      await setAmounts({ bronzeXp: 0 });
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const answer = await sync(player);
      expect(answer.achievements).toEqual([{ id: "events-attended", tier: "bronze", xp: 0 }]);
      expect(await tierXp(player, "events-attended")).toEqual([]);
      expect(await f.earned(player)).toEqual(["events-attended:bronze"]);
    });

    it("pays once when two syncs of one player cross", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const crossed = await f.crossed(call, call);
      expect(crossed.waited).toBe(true);
      expect(crossed.second).not.toBeInstanceOf(Error);
      expect(await tierXp(player, "events-attended")).toHaveLength(1);
    });

    it("pays nothing for a tier earned before migration 0164 (no back pay)", async () => {
      const player = await f.newPlayer();
      await f.owner(
        "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'events-attended', 'bronze')",
        [player],
      );
      await sync(player);
      expect(await tierXp(player, "events-attended")).toEqual([]);
      expect(await xpOf(player)).toBe(0);
    });

    it("gives a level crossed by tier XP, and its item, in the same call", async () => {
      await setAmounts({ bronzeXp: 1000 });
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const answer = await sync(player);
      expect(await xpOf(player)).toBe(1100);
      expect(answer.levelUp?.level).toBeGreaterThan(2);
      expect(answer.levelUp?.items.length).toBeGreaterThan(0);
    });

    it("never touches the points ledger, a score or a balance of any event", async () => {
      const player = await f.newPlayer();
      const event = await f.newEvent();
      const enrollment = await f.play(event, player);
      const state = () =>
        f.owner(
          `SELECT (SELECT count(*) FROM ledger_entry l WHERE l.enrollment_id = $1)::int AS entries,
                  e.score, e.balance FROM enrollment e WHERE e.id = $1`,
          [enrollment],
        );
      const before = await state();
      expect((await sync(player)).achievements).toHaveLength(1);
      expect(await state()).toEqual(before);
    });

    it("refuses a banned or erased caller (PI401), and the wall refuses tier XP to them", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      await ban(player);
      expect(await refusal(sync(player))).toBe("PI401");
      expect(await tierXp(player, "events-attended")).toEqual([]);
      expect(
        await refusal(
          f.owner(
            "INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier) VALUES ($1, 5, 'achievement', 'top-ten', 'gold')",
            [player],
          ),
        ),
      ).toBe("PB423");
    });
  });

  describe("the shape of an XP entry", () => {
    it.each([
      ["no tier", "achievement", 5, "'top-ten'", "NULL"],
      ["no achievement", "achievement", 5, "NULL", "'gold'"],
      ["a negative amount", "achievement", -5, "'top-ten'", "'gold'"],
      ["an unknown tier", "achievement", 5, "'top-ten'", "'platinum'"],
      ["another source naming a tier", "questify", 5, "'top-ten'", "'gold'"],
    ])("refuses %s", async (_name, source, delta, achievement, tier) => {
      const player = await f.newPlayer();
      expect(
        await refusal(
          f.owner(
            `INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier)
             VALUES ($1, ${delta}, '${source}', ${achievement}, ${tier})`,
            [player],
          ),
        ),
      ).toMatch(/^23514/);
    });

    it("refuses a tier the player never earned, and a second entry for one tier", async () => {
      const player = await f.newPlayer();
      const entry = `INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier)
                     VALUES ($1, 5, 'achievement', 'top-ten', 'gold')`;
      expect(await refusal(f.owner(entry, [player]))).toMatch(/^23503/);
      await f.owner(
        "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'top-ten', 'gold')",
        [player],
      );
      await f.owner(entry, [player]);
      await f.owner("UPDATE player_xp SET xp = xp + 5 WHERE player_id = $1", [player]);
      expect(await refusal(f.owner(entry, [player]))).toMatch(/^23505/);
    });

    it("has exactly its writers: the sync pays tiers, and only the removal takes XP back", async () => {
      const writers = await f.owner<{ proname: string; negative: boolean }>(
        `SELECT p.proname, p.prosrc ~ '-credit\\.delta' AS negative
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\\s+into\\s+(public\\.)?xp_entry'
         ORDER BY 1`,
      );
      expect(writers.filter((writer) => writer.negative).map((writer) => writer.proname)).toEqual([
        "xp_reverse",
      ]);
      expect(writers.map((writer) => writer.proname)).toEqual([
        "daily_finish_play",
        "questify_sync",
        "xp_credit",
        "xp_reverse",
      ]);
    });
  });

  describe("achievement items", () => {
    it("gives the item once at the mapped tier, and the locker names its achievement", async () => {
      await withAchievement("events-attended", { tier: "bronze" }, async () => {
        const player = await f.newPlayer();
        await f.play(await f.newEvent(), player);
        const first = await sync(player);
        expect(first.items).toEqual([
          {
            achievementId: "events-attended",
            tier: "bronze",
            item: expect.objectContaining({ id: "shop-compass-ring", kind: "frame" }),
          },
        ]);
        expect(await owned(player)).toEqual([
          { item_id: "shop-compass-ring", source: "achievement", source_tier: "bronze" },
        ]);
        expect((await sync(player)).items).toEqual([]);
        const [row] = await f.asPlayer<{ source: string; source_achievement: Doc | null }>(
          player,
          "SELECT source, source_achievement FROM own_locker(NULL, NULL, 5) WHERE source = 'achievement'",
        );
        expect(row?.source_achievement).toMatchObject({ id: "events-attended", tier: "bronze" });
      });
    });

    it("gives nothing at a tier the player has not reached", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      expect((await sync(player)).items).toEqual([]);
      expect(await owned(player)).toEqual([]);
    });

    it("is retroactive: a map set later reaches who already holds the tier, at their next sync", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      await sync(player);
      await withAchievement("events-attended", { tier: "bronze" }, async () => {
        expect((await sync(player)).items.map((given) => given.item.id)).toEqual([
          "shop-compass-ring",
        ]);
      });
    });

    it("skips an item the player owns already (a bought ring stays as it was)", async () => {
      await withAchievement("events-attended", { tier: "bronze" }, async () => {
        const player = await f.newPlayer();
        await f.owner(
          "INSERT INTO player_item (player_id, item_id, source, earned_at) VALUES ($1, 'shop-compass-ring', 'questify', now())",
          [player],
        );
        await f.play(await f.newEvent(), player);
        expect((await sync(player)).items).toEqual([]);
        expect(await owned(player)).toEqual([
          { item_id: "shop-compass-ring", source: "questify", source_tier: null },
        ]);
      });
    });

    it("gives one row when two syncs cross", async () => {
      await withAchievement("events-attended", { tier: "bronze" }, async () => {
        const player = await f.newPlayer();
        await f.play(await f.newEvent(), player);
        const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
        const crossed = await f.crossed(call, call);
        expect(crossed.waited).toBe(true);
        expect(crossed.second).not.toBeInstanceOf(Error);
        expect(await owned(player)).toHaveLength(1);
      });
    });

    it.each(["erase-first", "sync-first"])(
      "crosses erasure without a deadlock, and nothing stays after it commits: %s",
      async (order) => {
        await withAchievement("events-attended", { tier: "bronze" }, async () => {
          const player = await f.newPlayer();
          await f.play(await f.newEvent(), player);
          const erase = {
            context: { playerId: player },
            sql: "SELECT * FROM erase_player($1, true, $2)",
            values: [await f.deletionToken(player), randomUUID()],
          };
          const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
          const crossed =
            order === "erase-first" ? await f.crossed(erase, call) : await f.crossed(call, erase);
          expect(crossed.waited).toBe(true);
          if (order === "erase-first") expect(crossed.second).toMatchObject({ code: "PI401" });
          else expect(crossed.second).not.toBeInstanceOf(Error);
          expect(await owned(player)).toEqual([]);
        });
      },
    );

    describe("the console door", () => {
      it("keeps the item when the document leaves it out, lists it, and audits it", async () => {
        const doc = await docOf("top-ten");
        const saved = await door("top-ten", doc);
        expect(saved).toMatchObject({ item: { tier: "gold", itemId: "shop-moon-ring" } });
        const listed = (
          await f.run<{ r: { id: string; item: Doc | null }[] }>(
            admin,
            "SELECT admin_achievements() AS r",
          )
        )[0]?.r.find((row) => row.id === "top-ten");
        expect(listed?.item).toEqual({ tier: "gold", itemId: "shop-moon-ring" });
      });

      it("moves the item, removes it with null, and reverts through the audit entry", async () => {
        const doc = await docOf("community-goals");
        const moved = await door("community-goals", {
          ...doc,
          item: { tier: "silver", itemId: "shop-pearl-ring" },
        });
        expect(moved).toMatchObject({ item: { tier: "silver", itemId: "shop-pearl-ring" } });
        const removed = await door("community-goals", { ...doc, item: null });
        expect(removed).toMatchObject({ item: null });
        expect(
          await f.owner("SELECT 1 FROM achievement_item WHERE achievement_id = 'community-goals'"),
        ).toEqual([]);
        const [entry] = await f.owner<{ id: string; before: Doc; after: Doc }>(
          `SELECT id, before, after FROM audit_log
           WHERE action = 'catalog.achievement.update' AND target_id = 'community-goals'
           ORDER BY id DESC LIMIT 1`,
        );
        expect(entry?.before).toMatchObject({
          item: { tier: "silver", itemId: "shop-pearl-ring" },
        });
        expect(entry?.after).toMatchObject({ item: null });
        const reverted = await door("community-goals", null, entry?.id ?? null);
        expect(reverted).toMatchObject({ item: { tier: "silver", itemId: "shop-pearl-ring" } });
        await door("community-goals", {
          ...doc,
          item: { tier: "gold", itemId: "shop-pearl-ring" },
        });
      });

      it("reverts an entry from before migration 0164 without touching the item", async () => {
        const doc = await docOf("cities-played");
        const [entry] = await f.owner<{ id: string }>(
          `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after, request_id)
           VALUES ('admin', $1, 'catalog.achievement.update', 'achievement', 'cities-played', $2, $3, $4) RETURNING id`,
          [admin.staffUserId, { name: NAME }, { name: NAME }, randomUUID()],
        );
        const reverted = await door("cities-played", null, entry?.id ?? null);
        expect(reverted).toMatchObject({
          bronze: doc.bronze,
          item: { tier: "gold", itemId: "shop-dune-ring" },
        });
      });

      it("takes no confirmation for setting an item: nothing to take back", async () => {
        const id = await newItem("unlock-ring");
        const doc = await docOf("quests-done");
        const saved = await door("quests-done", { ...doc, item: { tier: "gold", itemId: id } });
        expect(saved).toMatchObject({ item: { tier: "gold", itemId: id } });
        await door("quests-done", { ...doc, item: { tier: "gold", itemId: "shop-falcon-ring" } });
      });

      it.each([
        ["no such item", "no-such-item", "item_unknown"],
        ["a level's item", "level-5", "item_has_source"],
        ["another achievement's item", "shop-moon-ring", "item_has_source"],
      ])("refuses %s", async (_name, itemId, reason) => {
        const doc = await docOf("quests-done");
        expect(await refusal(door("quests-done", { ...doc, item: { tier: "gold", itemId } }))).toBe(
          because(reason),
        );
      });

      it("refuses a souvenir's item as unknown", async () => {
        const id = "souvenir-0123456789abcdef0123456789abcdef";
        await f.owner(
          `INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES ($1, 'frame', 'إطار', 'Frame', 'frame-05')
           ON CONFLICT DO NOTHING`,
          [id],
        );
        const doc = await docOf("quests-done");
        expect(
          await refusal(door("quests-done", { ...doc, item: { tier: "gold", itemId: id } })),
        ).toBe(because("item_unknown"));
      });

      it.each([
        ["a text", "gold"],
        ["no tier", { itemId: "x" }],
        ["no item id", { tier: "gold" }],
        ["an unknown tier", { tier: "platinum", itemId: "x" }],
        ["an extra field", { tier: "gold", itemId: "x", extra: 1 }],
        ["an id that is not text", { tier: "gold", itemId: 5 }],
      ])("refuses a malformed item: %s", async (_name, item) => {
        const doc = await docOf("quests-done");
        expect(await refusal(door("quests-done", { ...doc, item }))).toBe("CA400:item");
      });

      it("refuses a change or a removal once a player got the item from this achievement (item_given)", async () => {
        const id = await newItem("given-ring");
        await withAchievement("events-attended", { tier: "bronze" }, async () => {
          const doc = await docOf("events-attended");
          const player = await f.newPlayer();
          await f.play(await f.newEvent(), player);
          await sync(player);
          for (const item of [
            null,
            { tier: "silver", itemId: "shop-compass-ring" },
            { tier: "bronze", itemId: id },
          ]) {
            expect(await refusal(door("events-attended", { ...doc, item }))).toBe(
              because("item_given"),
            );
          }
          expect(await door("events-attended", doc)).toMatchObject({
            item: { tier: "bronze", itemId: "shop-compass-ring" },
          });
        });
      });

      it("names the XP and the item in a lowering's confirmation", async () => {
        const doc = await docOf("cities-played");
        const asked = await refusal(door("cities-played", { ...doc, gold: (doc.gold ?? 0) - 1 }));
        expect(asked.startsWith("CA428:")).toBe(true);
        expect(JSON.parse(asked.slice("CA428:".length))).toEqual({
          gold: { xp: 300, itemId: "shop-dune-ring" },
        });
      });
    });

    describe("integrity", () => {
      it.each([
        ["a level source with a tier", "'level'", 2, "'top-ten'", "'gold'"],
        ["questify with an achievement", "'questify'", "NULL", "'top-ten'", "NULL"],
        ["questify with a tier", "'questify'", "NULL", "NULL", "'gold'"],
        ["questify with a level", "'questify'", 2, "NULL", "NULL"],
        ["achievement with no tier", "'achievement'", "NULL", "'top-ten'", "NULL"],
        ["achievement with no achievement", "'achievement'", "NULL", "NULL", "'gold'"],
        ["achievement with a level", "'achievement'", 2, "'top-ten'", "'gold'"],
        ["the old shop source", "'shop'", "NULL", "NULL", "NULL"],
      ])("refuses %s on the source CHECK", async (_name, source, level, achievement, tier) => {
        const player = await f.newPlayer();
        expect(
          await refusal(
            f.owner(
              `INSERT INTO player_item (player_id, item_id, source, source_level, source_achievement_id, source_tier, earned_at)
               VALUES ($1, 'shop-desert-ring', ${source}, ${level}, ${achievement}, ${tier}, now())`,
              [player],
            ),
          ),
        ).toMatch(/^23514/);
      });

      it("binds an achievement item to the same player's earned tier and to the map", async () => {
        const other = await f.newPlayer();
        const player = await f.newPlayer();
        await f.owner(
          "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'top-ten', 'gold')",
          [other],
        );
        const insert = (who: string, item: string) =>
          f.owner(
            `INSERT INTO player_item (player_id, item_id, source, source_achievement_id, source_tier, earned_at)
             VALUES ($1, $2, 'achievement', 'top-ten', 'gold', now())`,
            [who, item],
          );
        expect(await refusal(insert(player, "shop-moon-ring"))).toMatch(/^23503/);
        expect(await refusal(insert(other, "shop-desert-ring"))).toMatch(/^23503/);
      });

      it("freezes the new source columns, as it does the old ones", async () => {
        const player = await f.newPlayer();
        await f.owner(
          "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'top-ten', 'gold')",
          [player],
        );
        await f.owner(
          `INSERT INTO player_item (player_id, item_id, source, source_achievement_id, source_tier, earned_at)
           VALUES ($1, 'shop-moon-ring', 'achievement', 'top-ten', 'gold', now())`,
          [player],
        );
        for (const change of ["source_tier = 'silver'", "source_achievement_id = 'quests-done'"]) {
          await expect(
            f.owner(`UPDATE player_item SET ${change} WHERE player_id = $1`, [player]),
          ).rejects.toThrow(/acknowledged or erased/);
        }
        await f.owner("UPDATE player_item SET seen_at = now() WHERE player_id = $1", [player]);
      });

      it("has no door that can write the source `questify`, or take a price", async () => {
        const writers = await f.owner<{ proname: string }>(
          `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\\s+into\\s+(public\\.)?player_item'
             AND p.prosrc ~ '''questify'''`,
        );
        expect(writers).toEqual([]);
      });

      it("gives no function in the database a body that names a gem table", async () => {
        expect(
          await f.owner(
            `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prosrc ~ 'gem_'`,
          ),
        ).toEqual([]);
      });
    });

    it("waits for a door moving the map and then sees it: a sync crossing the door never fails", async () => {
      const id = await newItem("crossing-ring");
      const player = await f.newPlayer();
      await f.owner(
        "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'community-goals', 'gold')",
        [player],
      );
      const save = {
        context: admin,
        sql: "SELECT admin_achievement_save($1, $2, NULL, true, $3) AS r",
        values: [
          "community-goals",
          { ...(await docOf("community-goals")), item: { tier: "gold", itemId: id } },
          randomUUID(),
        ],
      };
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const crossed = await f.crossed(save, call);
      expect(crossed.waited).toBe(true);
      expect(crossed.second).not.toBeInstanceOf(Error);
      await sync(player);
      expect((await owned(player)).map((row) => row.item_id)).toEqual([id]);
    });
  });

  describe("the level on event rankings", () => {
    it("carries the level derived from XP on the board, the day board and ranking_rows", async () => {
      const event = await f.newEvent();
      const strong = await f.newPlayer();
      const enrollment = await f.play(event, strong, 3);
      const weak = await f.newPlayer();
      const other = await f.play(event, weak, 1);
      expect((await top(weak, event)).map((one) => one.level)).toEqual([2, 1]);
      const day = await f.asPlayer<{ level: number }>(
        weak,
        "SELECT level FROM ranking_day_top($1, 10) ORDER BY score DESC",
        [event],
      );
      expect(day.map((one) => one.level)).toEqual([2, 1]);
      const rows = await f.asPlayer<{ enrollment_id: string; level: number }>(
        weak,
        "SELECT enrollment_id, level FROM ranking_rows($1, $2)",
        [event, [enrollment, other]],
      );
      expect(new Map(rows.map((one) => [one.enrollment_id, one.level]))).toEqual(
        new Map([
          [enrollment, 2],
          [other, 1],
        ]),
      );
    });

    it("derives it after a curve lowering, before the player's next sync", async () => {
      const event = await f.newEvent();
      const player = await f.newPlayer();
      await f.play(event, player, 1);
      const [before] = await top(player, event);
      await f.owner("UPDATE xp_level SET xp_from = 50 WHERE level = 2");
      await f.owner("UPDATE xp_level SET xp_from = 90 WHERE level = 3");
      try {
        const [after] = await top(player, event);
        expect(after?.level).toBe(3);
        expect(after?.level).not.toBe(before?.level);
      } finally {
        await f.owner("UPDATE xp_level SET xp_from = 500 WHERE level = 3");
        await f.owner("UPDATE xp_level SET xp_from = 200 WHERE level = 2");
      }
    });

    it("keeps the level of a row the reader blocked, without the name", async () => {
      const event = await f.newEvent();
      const reader = await f.newPlayer();
      const other = await f.newPlayer();
      await f.play(event, reader, 1);
      await f.play(event, other, 3);
      await f.owner("INSERT INTO player_block (blocker_id, blocked_id) VALUES ($1, $2)", [
        reader,
        other,
      ]);
      const [first] = await top(reader, event);
      expect(first?.username).toBeNull();
      expect(first?.level).toBeGreaterThan(1);
    });

    it("pays the same points at level 1 and level 20: a level is never an advantage in an event", async () => {
      const event = await f.newEvent();
      const low = await f.newPlayer();
      const high = await f.newPlayer();
      await f.owner(
        `WITH made AS (
           INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'top-ten', 'bronze')
           RETURNING player_id
         ), paid AS (
           INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier)
           SELECT player_id, 30000, 'achievement', 'top-ten', 'bronze' FROM made RETURNING id
         )
         SELECT xp_apply($1, (SELECT id FROM paid), 30000)`,
        [high],
      );
      const points = async (player: string) => {
        const enrollment = await f.play(event, player);
        return (
          await f.owner<{ score: string; balance: string }>(
            "SELECT score, balance FROM enrollment WHERE id = $1",
            [enrollment],
          )
        )[0];
      };
      expect(await points(high)).toEqual(await points(low));
      const [held] = await f.owner<{ level: number }>(
        "SELECT xp_level_of(xp) AS level FROM player_xp WHERE player_id = $1",
        [high],
      );
      expect(held?.level).toBeGreaterThanOrEqual(20);
    });
  });

  describe("own_level_rewards", () => {
    it("answers the level, the curve with owned flags and the achievement items", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player, 2);
      const answer = await read(player);
      expect(answer.level).toMatchObject({ number: 2, xp: 200, levelFrom: 200, nextLevelAt: 500 });
      expect(answer.levels[0]).toEqual({ level: 1, xpFrom: 0, item: null, owned: false });
      expect(answer.levels[1]).toMatchObject({ level: 2, item: { id: "level-2" }, owned: true });
      expect(answer.levels[2]).toMatchObject({ level: 3, owned: false });
      expect(answer.achievements.map((row) => row.id)).toEqual([
        "events-attended",
        "quests-done",
        "cities-played",
        "top-ten",
        "community-goals",
      ]);
      expect(answer.achievements[0]).toMatchObject({
        tier: "gold",
        item: { id: "shop-compass-ring" },
        owned: false,
        earned: false,
      });
    });

    it("says earned and owned once the tier and the item are the player's, and not while revoked", async () => {
      await withAchievement("events-attended", { tier: "bronze" }, async () => {
        const player = await f.newPlayer();
        await f.play(await f.newEvent(), player);
        await sync(player);
        const first = (await read(player)).achievements[0];
        expect(first).toMatchObject({ tier: "bronze", owned: true, earned: true });
        await ban(player);
        await f.run(admin, "SELECT * FROM admin_revoke_tiers($1, $2, 'cheating', $3, $4)", [
          player,
          JSON.stringify([{ achievementId: "events-attended", tier: "bronze" }]),
          NOTE,
          randomUUID(),
        ]);
        await f.run(admin, "SELECT * FROM admin_lift_ban($1, 'mistake', $2, $3)", [
          player,
          NOTE,
          randomUUID(),
        ]);
        expect((await read(player)).achievements[0]).toMatchObject({ owned: true, earned: false });
      });
    });

    it("answers for the caller only", async () => {
      const mine = await f.newPlayer();
      const other = await f.newPlayer();
      await f.play(await f.newEvent(), other, 3);
      expect((await read(mine)).level.xp).toBe(0);
    });

    it("refuses a banned or erased caller, and no caller at all (PI401)", async () => {
      const banned = await f.newPlayer();
      await ban(banned);
      const call = (player: string) =>
        refusal(f.asPlayer(player, "SELECT own_level_rewards() AS r"));
      expect(await call(banned)).toBe("PI401");
      const erased = await f.newPlayer();
      await f.asPlayer(erased, "SELECT * FROM erase_player($1, true, $2)", [
        await f.deletionToken(erased),
        randomUUID(),
      ]);
      expect(await call(erased)).toBe("PI401");
      expect(await refusal(f.run({}, "SELECT own_level_rewards() AS r"))).toBe("PI401");
    });
  });
});
