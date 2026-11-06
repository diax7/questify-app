import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { achievementDocSchema, amountsDocSchema } from "@questify/shared";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;
type Achievement = {
  id: string;
  bronze: number;
  silver: number;
  gold: number;
  name: Doc;
  item: Doc | null;
};
type Amounts = { xp: Doc; stored: { xp: boolean } };

/** A call's SQLSTATE and detail ("CA400:thresholds"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const NAME = { ar: "صائد المهام", en: "Quest Hunter" };
const NOTE = "Fraud ticket 4411 confirmed";
const thresholds = (bronze: number, silver: number, gold: number) => ({
  name: NAME,
  bronze,
  silver,
  gold,
});
const DEFAULT_AMOUNTS = {
  xp: {
    questXp: 100,
    dailyFinishXp: 20,
    dailyRightXp: 10,
    dailyWordXp: 50,
    bronzeXp: 50,
    silverXp: 150,
    goldXp: 300,
  },
};

/**
 * T-709c part 1 in the database (migration 0122): the achievement thresholds (a lowering pays once at the next sync and
 * needs a confirmation; a revert never claws back), the XP amounts (CHECKed, one audited door, the generic writer
 * narrowed), and the revoke and restore of a banned player's tiers (an append-only mark; paid XP stays).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "console thresholds, amounts and tiers (database)",
  () => {
    let f: QuestifyFixture;
    let adminId = "";
    let admin: RequestContext = {};

    beforeAll(async () => {
      f = await questifyFixture();
      const [row] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('xp@questify.test', 'h', 'admin', 'active') RETURNING id",
      );
      adminId = row?.id ?? "";
      admin = { isAdmin: true, staffUserId: adminId };
    });
    afterEach(async () => {
      const drift = await f.owner(
        `SELECT x.player_id FROM player_xp x
       WHERE x.xp <> coalesce((SELECT sum(e.delta) FROM xp_entry e WHERE e.player_id = x.player_id), 0)`,
      );
      expect(drift).toEqual([]);
    });
    afterAll(async () => {
      await f.close();
    });

    const one = async <T>(sql: string, values: unknown[] = [], seat = admin): Promise<T> =>
      (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
    const achievement = async (id: string) =>
      (await one<Achievement[]>("SELECT admin_achievements() AS r")).find(
        (row) => row.id === id,
      ) as Achievement;
    const saveAchievement = (
      id: string,
      doc: unknown,
      confirmed = false,
      revertOf: string | null = null,
    ) =>
      one<Achievement>("SELECT admin_achievement_save($1, $2, $3, $4, $5) AS r", [
        id,
        doc,
        revertOf,
        confirmed,
        randomUUID(),
      ]);
    const audits = (action: string) =>
      f.owner<{ id: string; target_id: string; before: Doc | null; after: Doc }>(
        "SELECT id, target_id, before, after FROM audit_log WHERE action = $1 ORDER BY id",
        [action],
      );
    const latestEntry = async (targetType: string, target: string): Promise<string> =>
      (
        await f.owner<{ id: string }>(
          `SELECT id FROM audit_log WHERE target_type = $1 AND target_id = $2 AND action LIKE 'catalog.%'
         ORDER BY id DESC LIMIT 1`,
          [targetType, target],
        )
      )[0]?.id ?? "";
    const sync = async (player: string) =>
      (
        await f.asPlayer<{ r: { achievements: Doc[]; items: { item: { id: string } }[] } }>(
          player,
          "SELECT questify_sync() AS r",
        )
      )[0]?.r;
    const tierXp = (player: string, id: string) =>
      f.owner<{ tier: string; delta: number }>(
        `SELECT tier, delta FROM xp_entry WHERE player_id = $1 AND achievement_id = $2 ORDER BY id`,
        [player, id],
      );
    const balance = async (player: string): Promise<number> =>
      Number(
        (
          await f.owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player])
        )[0]?.xp,
      );
    const amounts = () => one<Amounts>("SELECT admin_amounts() AS r");
    const saveAmounts = (doc: unknown, revertOf: string | null = null) =>
      one<Amounts>("SELECT admin_amounts_save($1, $2, $3) AS r", [doc, revertOf, randomUUID()]);
    const ban = (player: string) =>
      f.run(admin, "SELECT * FROM admin_ban_player($1, 'cheating', $2, $3)", [
        player,
        NOTE,
        randomUUID(),
      ]);
    const lift = (player: string) =>
      f.run(admin, "SELECT * FROM admin_lift_ban($1, 'mistake', $2, $3)", [
        player,
        NOTE,
        randomUUID(),
      ]);
    const tierDoor = async (
      door: "revoke" | "restore",
      player: string,
      tiers: unknown,
      code = door === "revoke" ? "cheating" : "mistake",
    ) =>
      (
        await f.run<{ outcome: string; action_id: string | null }>(
          admin,
          `SELECT * FROM admin_${door}_tiers($1, $2, $3, $4, $5)`,
          [player, JSON.stringify(tiers), code, NOTE, randomUUID()],
        )
      )[0];
    /** A player with `quests` quest credits, synced once unless `synced` is false. */
    const player = async (quests: number, synced = true) => {
      const id = await f.newPlayer();
      await f.play(await f.newEvent(), id, quests);
      if (synced) await sync(id);
      return id;
    };

    /** A synced player with `quests` credits, under a quests-done bronze of 20 they do not reach yet. */
    const belowBronze = async (quests: number) => {
      await saveAchievement("quests-done", thresholds(20, 50, 200));
      return player(quests);
    };

    /** A player with the events-attended bronze earned as before migration 0164: an earned row and no XP entry. */
    const earnedUnpaid = async (quests = 1) => {
      const someone = await player(quests, false);
      await f.owner(
        "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'events-attended', 'bronze')",
        [someone],
      );
      return someone;
    };

    describe("who may ask", () => {
      it("refuses every seat that is not an active platform admin with QE403, on every new or changed door", async () => {
        const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
        const [off] = await f.owner<{ id: string }>(
          "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('off-xp@questify.test', 'h', 'admin', 'disabled') RETURNING id",
        );
        const target = await f.newPlayer();
        const seats: RequestContext[] = [
          f.team(),
          f.team(editor),
          { playerId: target },
          { isAdmin: true },
          { isAdmin: true, staffUserId: editor },
          { isAdmin: true, staffUserId: off?.id ?? "" },
          { staffUserId: adminId },
          {},
        ];
        const request = randomUUID();
        const tiers = JSON.stringify([{ achievementId: "quests-done", tier: "bronze" }]);
        const calls = [
          `SELECT admin_achievement_save('quests-done', '{}', NULL, true, '${request}')`,
          "SELECT admin_amounts()",
          `SELECT admin_amounts_save('{}', NULL, '${request}')`,
          `SELECT * FROM admin_revoke_tiers('${target}', '${tiers}', 'cheating', '${NOTE}', '${request}')`,
          `SELECT * FROM admin_restore_tiers('${target}', '${tiers}', 'mistake', '${NOTE}', '${request}')`,
        ];
        for (const seat of seats) {
          for (const call of calls) {
            expect(await refusal(f.run(seat, call)), `${call} ${JSON.stringify(seat)}`).toBe(
              "QE403",
            );
          }
        }
      });
    });

    describe("achievement thresholds", () => {
      it("lists thresholds that pass the edit document, with the name", async () => {
        const row = await achievement("quests-done");
        expect(
          achievementDocSchema.safeParse({
            name: row.name,
            bronze: row.bronze,
            silver: row.silver,
            gold: row.gold,
          }).success,
        ).toBe(true);
      });

      it("refuses a lowering without the confirmation, naming the XP and the item, and writes nothing (T3)", async () => {
        const before = await achievement("top-ten");
        const entries = (await audits("catalog.achievement.update")).length;
        const asked = await refusal(
          saveAchievement("top-ten", {
            name: before.name,
            bronze: 1,
            silver: before.silver - 1,
            gold: before.gold - 1,
          }),
        );
        expect(asked.startsWith("CA428:")).toBe(true);
        expect(JSON.parse(asked.slice("CA428:".length))).toEqual({
          silver: { xp: 150, itemId: null },
          gold: { xp: 300, itemId: "shop-moon-ring" },
        });
        expect(await achievement("top-ten")).toEqual(before);
        expect((await audits("catalog.achievement.update")).length).toBe(entries);
      });

      it("saves a raise or a rename without a confirmation, and audits the thresholds before and after", async () => {
        const before = await achievement("community-goals");
        const raised = await saveAchievement("community-goals", {
          name: { ar: "يد واحدة", en: "One Hand" },
          bronze: before.bronze,
          silver: before.silver + 1,
          gold: before.gold + 1,
        });
        expect(raised).toMatchObject({ silver: before.silver + 1, name: { en: "One Hand" } });
        const entry = (await audits("catalog.achievement.update")).at(-1);
        expect(entry?.before).toEqual({
          name: before.name,
          bronze: before.bronze,
          silver: before.silver,
          gold: before.gold,
          item: before.item,
        });
        expect(entry?.after).toMatchObject({ silver: before.silver + 1, gold: before.gold + 1 });
      });

      it.each([
        [{ bronze: 5, silver: 5, gold: 10 }, "CA400:thresholds"],
        [{ bronze: 9, silver: 5, gold: 10 }, "CA400:thresholds"],
        [{ bronze: 0, silver: 5, gold: 10 }, "CA400:thresholds"],
        [{ bronze: 1, silver: 5, gold: 100_001 }, "CA400:thresholds"],
        [{ bronze: 1.5, silver: 5, gold: 10 }, "CA400:thresholds"],
        [{ bronze: "1", silver: 5, gold: 10 }, "CA400:thresholds"],
        [{ bronze: 1, silver: 5 }, "CA400:thresholds"],
        [{ bronze: 1, silver: 5, gold: 10, threshold: 5 }, "CA400:doc"],
      ])("refuses %j", async (extra, code) => {
        const before = await achievement("cities-played");
        expect(
          await refusal(saveAchievement("cities-played", { name: NAME, ...extra }, true)),
        ).toBe(code);
        expect(await achievement("cities-played")).toEqual(before);
      });

      it("refuses an unknown id and a stale revert", async () => {
        expect(await refusal(saveAchievement("nothing", thresholds(1, 2, 3), true))).toBe("CA404");
        expect(await refusal(saveAchievement("quests-done", null, true, "999999999"))).toBe(
          "CA409",
        );
      });

      it("pays a lowered tier once at the next sync, and a second sync pays nothing (T1)", async () => {
        const someone = await belowBronze(2);
        expect(await tierXp(someone, "quests-done")).toEqual([]);
        await saveAchievement("quests-done", thresholds(2, 50, 200), true);
        expect(await tierXp(someone, "quests-done")).toEqual([]);
        const first = await sync(someone);
        expect(first?.achievements).toEqual([{ id: "quests-done", tier: "bronze", xp: 50 }]);
        expect(await tierXp(someone, "quests-done")).toEqual([{ tier: "bronze", delta: 50 }]);
        expect((await sync(someone))?.achievements).toEqual([]);
        expect(await tierXp(someone, "quests-done")).toHaveLength(1);
      });

      it("pays once when two syncs of one player cross", async () => {
        const someone = await belowBronze(3);
        await saveAchievement("quests-done", thresholds(3, 50, 200), true);
        const call = { context: { playerId: someone }, sql: "SELECT questify_sync() AS r" };
        const crossed = await f.crossed(call, call);
        expect(crossed.waited).toBe(true);
        expect(await tierXp(someone, "quests-done")).toEqual([{ tier: "bronze", delta: 50 }]);
      });

      it("a revert that raises back keeps the earned tier and its XP (T2)", async () => {
        const someone = await belowBronze(4);
        await saveAchievement("quests-done", thresholds(4, 50, 200), true);
        await sync(someone);
        const held = await balance(someone);
        const reverted = await saveAchievement(
          "quests-done",
          null,
          false,
          await latestEntry("achievement", "quests-done"),
        );
        expect(reverted.bronze).toBe(20);
        expect((await sync(someone))?.achievements).toEqual([]);
        expect(await f.earned(someone)).toContain("quests-done:bronze");
        expect(await tierXp(someone, "quests-done")).toEqual([{ tier: "bronze", delta: 50 }]);
        expect(await balance(someone)).toBe(held);
        expect((await audits("catalog.achievement.revert")).at(-1)?.after).toMatchObject({
          bronze: 20,
        });
      });

      it("asks for the confirmation on a revert that lowers", async () => {
        const before = await achievement("events-attended");
        await saveAchievement("events-attended", {
          name: before.name,
          bronze: before.bronze,
          silver: before.silver + 5,
          gold: before.gold,
        });
        const entry = await latestEntry("achievement", "events-attended");
        expect(await refusal(saveAchievement("events-attended", null, false, entry))).toBe(
          'CA428:{"silver": {"xp": 150, "itemId": null}}',
        );
        expect((await saveAchievement("events-attended", null, true, entry)).silver).toBe(
          before.silver,
        );
      });

      it("reverts a name-only entry from 0119 by its name, keeping the thresholds in force", async () => {
        const before = await achievement("top-ten");
        await f.owner(
          `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after)
         VALUES ('admin', $1, 'catalog.achievement.update', 'achievement', 'top-ten', $2, $3)`,
          [adminId, { name: { ar: "القمة", en: "Summit" } }, { name: before.name }],
        );
        const reverted = await saveAchievement(
          "top-ten",
          null,
          false,
          await latestEntry("achievement", "top-ten"),
        );
        expect(reverted).toMatchObject({
          name: { en: "Summit" },
          bronze: before.bronze,
          silver: before.silver,
          gold: before.gold,
        });
      });

      it.each(["door-first", "sync-first"])(
        "a threshold edit and a sync never wait on each other (T4): %s",
        async (order) => {
          const someone = await player(1, false);
          const current = await achievement("events-attended");
          const edit = {
            context: admin,
            sql: "SELECT admin_achievement_save($1, $2, NULL, false, $3) AS r",
            values: [
              "events-attended",
              {
                name: current.name,
                bronze: current.bronze,
                silver: current.silver,
                gold: current.gold + 1,
              },
              randomUUID(),
            ],
          };
          const syncCall = { context: { playerId: someone }, sql: "SELECT questify_sync() AS r" };
          const crossed =
            order === "door-first"
              ? await f.crossed(edit, syncCall)
              : await f.crossed(syncCall, edit);
          expect(crossed.waited).toBe(false);
          expect(crossed.second).not.toBeInstanceOf(Error);
          expect(await f.earned(someone)).toContain("events-attended:bronze");
        },
      );
    });

    describe("the amounts", () => {
      it("answers the amounts in force, fallbacks filled in, and whether the row is stored", async () => {
        expect(await amounts()).toEqual({ ...DEFAULT_AMOUNTS, stored: { xp: true } });
        expect(amountsDocSchema.safeParse(DEFAULT_AMOUNTS).success).toBe(true);
      });

      it.each([
        ["xp", "bronzeXp", -1],
        ["xp", "bronzeXp", 1001],
        ["xp", "goldXp", 2.5],
        ["xp", "silverXp", "25"],
        ["xp", "questXp", 0],
        ["xp", "questXp", 100_000],
        ["xp", "dailyFinishXp", 401],
        ["xp", "dailyRightXp", 201],
        ["xp", "dailyWordXp", 1001],
        ["xp", "dailyWordXp", -1],
      ] as const)("refuses %s.%s = %j", async (group, field, value) => {
        const doc = { ...DEFAULT_AMOUNTS, [group]: { ...DEFAULT_AMOUNTS[group], [field]: value } };
        expect(await refusal(saveAmounts(doc))).toBe(`CA400:${group}.${field}`);
        expect((await amounts()).xp).toEqual(DEFAULT_AMOUNTS.xp);
      });

      it("refuses a missing or an extra field", async () => {
        const { goldXp: _gold, ...six } = DEFAULT_AMOUNTS.xp;
        expect(await refusal(saveAmounts({ xp: six }))).toBe("CA400:xp.goldXp");
        expect(await refusal(saveAmounts({ xp: { ...DEFAULT_AMOUNTS.xp, ruby: 1 } }))).toBe(
          "CA400:xp",
        );
        expect(await refusal(saveAmounts({ ...DEFAULT_AMOUNTS, gems: {} }))).toBe("CA400:amounts");
        expect(await refusal(saveAmounts({ ...DEFAULT_AMOUNTS, moderation: {} }))).toBe(
          "CA400:amounts",
        );
        expect(await refusal(saveAmounts({}))).toBe("CA400:xp");
      });

      it("takes every boundary, writes the row and one audit entry, and nothing for no change", async () => {
        const low = {
          xp: {
            questXp: 1,
            dailyFinishXp: 0,
            dailyRightXp: 0,
            dailyWordXp: 0,
            bronzeXp: 0,
            silverXp: 0,
            goldXp: 0,
          },
        };
        const high = {
          xp: {
            questXp: 99_999,
            dailyFinishXp: 400,
            dailyRightXp: 200,
            dailyWordXp: 1000,
            bronzeXp: 1000,
            silverXp: 1000,
            goldXp: 1000,
          },
        };
        expect(await saveAmounts(low)).toEqual({ ...low, stored: { xp: true } });
        expect(await saveAmounts(high)).toMatchObject(high);
        const entries = (await audits("catalog.amounts.update")).length;
        await saveAmounts(high);
        expect((await audits("catalog.amounts.update")).length).toBe(entries);
        const rows = await f.owner<{ key: string; updated_by: string }>(
          "SELECT key, updated_by FROM platform_setting WHERE key = 'xp' ORDER BY key",
        );
        expect(rows).toEqual([{ key: "xp", updated_by: adminId }]);
        const reverted = await saveAmounts(null, await latestEntry("platform_setting", "amounts"));
        expect(reverted).toMatchObject(low);
        expect((await audits("catalog.amounts.revert")).at(-1)?.before).toEqual(high);
        await saveAmounts(DEFAULT_AMOUNTS);
      });

      it("pays the new tier amount for a tier earned after the save, and leaves credited XP alone", async () => {
        const someone = await player(2, false);
        const credited = () =>
          f.owner<{ delta: number }>(
            "SELECT delta FROM xp_entry WHERE player_id = $1 AND source = 'quest' ORDER BY id",
            [someone],
          );
        const before = await credited();
        await saveAmounts({ xp: { ...DEFAULT_AMOUNTS.xp, questXp: 7, bronzeXp: 77 } });
        try {
          await sync(someone);
          expect(await tierXp(someone, "events-attended")).toEqual([{ tier: "bronze", delta: 77 }]);
          expect(await credited()).toEqual(before);
        } finally {
          await saveAmounts(DEFAULT_AMOUNTS);
        }
      });

      it("reverts an entry from before migration 0164: drops its gems group, keeps the tier amounts in force", async () => {
        await saveAmounts({ xp: { ...DEFAULT_AMOUNTS.xp, goldXp: 400 } });
        const [entry] = await f.owner<{ id: string }>(
          `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after, request_id)
           VALUES ('admin', $1, 'catalog.amounts.update', 'platform_setting', 'amounts', $2, $3, $4) RETURNING id`,
          [
            adminId,
            {
              xp: { questXp: 90, dailyFinishXp: 20, dailyRightXp: 10, dailyWordXp: 50 },
              gems: { levelUp: 20, bronze: 10, silver: 25, gold: 50 },
            },
            { xp: DEFAULT_AMOUNTS.xp },
            randomUUID(),
          ],
        );
        const reverted = await saveAmounts(null, entry?.id ?? null);
        expect(reverted.xp).toEqual({ ...DEFAULT_AMOUNTS.xp, questXp: 90, goldXp: 400 });
        expect(reverted).not.toHaveProperty("gems");
        await saveAmounts(DEFAULT_AMOUNTS);
      });

      it("lets two first saves cross with no table lock: the second waits on the rows and lands after", async () => {
        await f.owner("DELETE FROM platform_setting WHERE key = 'xp'");
        const doc = (bronzeXp: number) => ({ xp: { ...DEFAULT_AMOUNTS.xp, bronzeXp } });
        const save = (bronzeXp: number) => ({
          context: admin,
          sql: "SELECT admin_amounts_save($1, NULL, $2) AS r",
          values: [doc(bronzeXp), randomUUID()],
        });
        const crossed = await f.crossed(save(21), save(22));
        expect(crossed.waited).toBe(true);
        expect(crossed.second).not.toBeInstanceOf(Error);
        expect((await amounts()).xp).toMatchObject({ bronzeXp: 22 });
        await saveAmounts(DEFAULT_AMOUNTS);
      });

      it("keeps the API's role from writing xp or moderation directly, and still lets it write features", async () => {
        const before = await f.owner("SELECT key, value FROM platform_setting ORDER BY key");
        for (const sql of [
          "INSERT INTO platform_setting (key, value) VALUES ('xp', '{\"questXp\": 1}')",
          "INSERT INTO platform_setting (key, value) VALUES ('moderation', '{\"appealEmail\": \"x@y.z\"}')",
          "INSERT INTO platform_setting (key, value) VALUES ('anything', '{}')",
        ]) {
          expect(await refusal(f.run(admin, sql)), sql).toBe("42501");
        }
        const updated = await f.run(
          admin,
          "UPDATE platform_setting SET value = value || '{\"questXp\": 5}' WHERE key = 'xp' RETURNING key",
        );
        expect(updated).toEqual([]);
        expect(await f.owner("SELECT key, value FROM platform_setting ORDER BY key")).toEqual(
          before,
        );
        const features = await f.run(
          admin,
          `INSERT INTO platform_setting (key, value, updated_by) VALUES ('features', '{}', $1)
         ON CONFLICT (key) DO UPDATE SET value = platform_setting.value RETURNING key`,
          [adminId],
        );
        expect(features).toEqual([{ key: "features" }]);
      });

      it("lets no function but admin_amounts_save write the xp row of platform_setting", async () => {
        const writers = await f.owner<{ proname: string; amounts: boolean }>(
          `SELECT p.proname, p.prosrc ~* '''xp''' AS amounts
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?platform_setting\\M'
           ORDER BY 1`,
        );
        expect(writers.filter((writer) => writer.amounts).map((writer) => writer.proname)).toEqual([
          "admin_amounts_save",
        ]);
        // Each other writer names one key of its own; a new writer of this table is reviewed against the amounts first.
        expect(writers.map((writer) => writer.proname)).toEqual([
          "admin_amounts_save",
          "admin_home_layout_save",
          "admin_player_intro_save",
          "admin_set_moderation_addresses",
        ]);
      });
    });

    describe("revoking a banned player's tiers", () => {
      const bronze = [{ achievementId: "events-attended", tier: "bronze" }];

      it("revokes only a banned player's earned tiers, once, and restores only a revoked one", async () => {
        const someone = await player(1);
        expect(await tierDoor("revoke", someone, bronze)).toEqual({
          outcome: "not_banned",
          action_id: null,
        });
        await ban(someone);
        expect(
          await tierDoor("revoke", someone, [{ achievementId: "quests-done", tier: "gold" }]),
        ).toEqual({ outcome: "not_earned", action_id: null });
        expect(await tierDoor("restore", someone, bronze)).toEqual({
          outcome: "not_revoked",
          action_id: null,
        });
        const done = await tierDoor("revoke", someone, bronze);
        expect(done?.outcome).toBe("changed");
        expect(await tierDoor("revoke", someone, bronze)).toEqual({
          outcome: "already_revoked",
          action_id: null,
        });
        const [entry] = await f.owner<{ after: Doc }>(
          "SELECT after FROM audit_log WHERE action = 'player.revoke_tiers' AND target_id = $1",
          [someone],
        );
        expect(entry?.after).toEqual({
          actionId: done?.action_id,
          reasonCode: "cheating",
          tiers: bronze,
        });
        await lift(someone);
        expect((await tierDoor("restore", someone, bronze))?.outcome).toBe("changed");
      });

      it("refuses a bad reason, a bad tier list and an unknown player", async () => {
        const someone = await player(1);
        await ban(someone);
        const call = (tiers: unknown, code = "cheating", target = someone) =>
          refusal(
            f.run(admin, "SELECT * FROM admin_revoke_tiers($1, $2, $3, $4, $5)", [
              target,
              JSON.stringify(tiers),
              code,
              NOTE,
              randomUUID(),
            ]),
          );
        expect(await call(bronze, "terms")).toBe("PA400");
        expect(await call([])).toBe("PA400");
        expect(await call([...bronze, ...bronze])).toBe("PA400");
        expect(await call([{ achievementId: "events-attended", tier: "platinum" }])).toBe("PA400");
        expect(await call([{ ...bronze[0], extra: 1 }])).toBe("PA400");
        expect(
          await call(
            Array.from({ length: 16 }, (_, i) => ({ achievementId: `a${i}`, tier: "gold" })),
          ),
        ).toBe("PA400");
        expect(await call(bronze, "cheating", randomUUID())).toBe("PA404");
      });

      it("hides a revoked tier, never earns it again, gives no item while revoked, and one after a restore", async () => {
        await f.owner(
          "UPDATE achievement_item SET tier = 'bronze' WHERE achievement_id = 'events-attended'",
        );
        const someone = await earnedUnpaid();
        await ban(someone);
        await tierDoor("revoke", someone, bronze);
        await lift(someone);
        const profile = await f.owner<{ r: { id: string; tier: string | null }[] }>(
          "SELECT public_achievements($1) AS r",
          [someone],
        );
        expect(profile[0]?.r.find((row) => row.id === "events-attended")?.tier).toBeNull();
        const own = (
          await f.asPlayer<{ r: { id: string; tier: string | null; next: unknown }[] }>(
            someone,
            "SELECT own_achievements() AS r",
          )
        )[0]?.r.find((row) => row.id === "events-attended");
        expect(own).toMatchObject({ tier: null, next: null });
        expect((await sync(someone))?.items).toEqual([]);
        expect((await sync(someone))?.items).toEqual([]);
        expect(await f.earned(someone)).toEqual(["events-attended:bronze"]);
        await tierDoor("restore", someone, bronze);
        expect((await sync(someone))?.items.map((given) => given.item.id)).toEqual([
          "shop-compass-ring",
        ]);
        expect((await sync(someone))?.items).toEqual([]);
        expect(await tierXp(someone, "events-attended")).toEqual([]);
        await f.owner(
          "UPDATE achievement_item SET tier = 'gold' WHERE achievement_id = 'events-attended'",
        );
      });

      it("keeps the XP already paid for a revoked tier", async () => {
        const someone = await player(1);
        const held = await balance(someone);
        expect(await tierXp(someone, "events-attended")).toHaveLength(1);
        await ban(someone);
        await tierDoor("revoke", someone, bronze);
        expect(await balance(someone)).toBe(held);
        expect(await tierXp(someone, "events-attended")).toHaveLength(1);
      });

      it("shows the tiers and the actions on the player's record", async () => {
        const someone = await player(1);
        await ban(someone);
        await tierDoor("revoke", someone, bronze);
        const record = await one<{ achievements: Doc[]; actions: { kind: string }[] }>(
          "SELECT console_player_record($1, $2) AS r",
          [someone, randomUUID()],
        );
        expect(record.achievements).toEqual([
          { id: "events-attended", name: expect.any(Object), tier: "bronze", revoked: true },
        ]);
        expect(record.actions.map((action) => action.kind)).toEqual(["revoke_tiers", "ban"]);
      });

      it.each(["restore-first", "sync-first"])(
        "a restore and a sync of the player run one after the other: %s",
        async (order) => {
          const someone = await earnedUnpaid(2);
          await ban(someone);
          await tierDoor("revoke", someone, bronze);
          await lift(someone);
          // A tier due, so the sync takes its locks whichever goes first.
          await saveAchievement("quests-done", thresholds(2, 50, 200), true);
          const restore = {
            context: admin,
            sql: "SELECT * FROM admin_restore_tiers($1, $2, 'mistake', $3, $4)",
            values: [someone, JSON.stringify(bronze), NOTE, randomUUID()],
          };
          const syncCall = { context: { playerId: someone }, sql: "SELECT questify_sync() AS r" };
          const crossed =
            order === "restore-first"
              ? await f.crossed(restore, syncCall)
              : await f.crossed(syncCall, restore);
          expect(crossed.waited).toBe(true);
          expect(crossed.second).not.toBeInstanceOf(Error);
          await sync(someone);
          expect(await tierXp(someone, "quests-done")).toEqual([{ tier: "bronze", delta: 50 }]);
          expect(await tierXp(someone, "events-attended")).toEqual([]);
        },
      );

      it("keeps the marks append-only for every role, and through an erasure without their action", async () => {
        const someone = await earnedUnpaid();
        await ban(someone);
        await tierDoor("revoke", someone, bronze);
        for (const sql of [
          "UPDATE achievement_revocation SET change = 'restore'",
          "DELETE FROM achievement_revocation",
          "TRUNCATE achievement_revocation",
          "UPDATE achievement_revocation SET action_id = NULL",
        ]) {
          await expect(f.owner(sql), sql).rejects.toMatchObject({ code: "42501" });
        }
        await lift(someone);
        await f.asPlayer(someone, "SELECT * FROM erase_player($1, true, $2)", [
          await f.deletionToken(someone),
          randomUUID(),
        ]);
        expect(
          await f.owner<{ change: string; action_id: string | null }>(
            "SELECT change, action_id FROM achievement_revocation WHERE player_id = $1",
            [someone],
          ),
        ).toEqual([{ change: "revoke", action_id: null }]);
      });
    });
  },
);
