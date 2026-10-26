import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Own = { id: string; tier: string | null; progress: number; next: unknown };

/**
 * Achievements and the sync evaluator (T-403, migration 0065, ADR-274): every metric from server facts, tiers earned
 * once and kept, the pre-check, the lock order against erasure and completions, and the closed tables and helpers.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "achievements and questify_sync (database)",
  () => {
    let f: QuestifyFixture;
    beforeAll(async () => {
      f = await questifyFixture();
    });
    afterAll(async () => {
      await f.close();
    });

    const own = async (player: string) =>
      (await f.asPlayer<{ list: Own[] | null }>(player, "SELECT own_achievements() AS list"))[0]
        ?.list;
    const progressOf = async (player: string, id: string) =>
      (await own(player))?.find((row) => row.id === id);
    /** Runs `work` with an achievement's thresholds lowered, then restores the seeded ones. */
    const withThresholds = async (
      metric: string,
      tiers: [number, number, number],
      work: () => Promise<void>,
    ) => {
      const [seeded] = await f.owner<{ bronze: number; silver: number; gold: number }>(
        "SELECT bronze, silver, gold FROM achievement WHERE metric = $1",
        [metric],
      );
      await f.owner(
        "UPDATE achievement SET bronze = $2, silver = $3, gold = $4 WHERE metric = $1",
        [metric, ...tiers],
      );
      try {
        await work();
      } finally {
        await f.owner(
          "UPDATE achievement SET bronze = $2, silver = $3, gold = $4 WHERE metric = $1",
          [metric, seeded?.bronze, seeded?.silver, seeded?.gold],
        );
      }
    };

    it("shows a new player five silhouettes with no progress and the bronze target next", async () => {
      const player = await f.newPlayer();
      expect(await own(player)).toEqual([
        {
          id: "events-attended",
          name: { ar: "رحّالة", en: "Wanderer" },
          visualKey: "ach-first-steps",
          tier: null,
          progress: 0,
          next: { tier: "bronze", target: 1 },
        },
        expect.objectContaining({
          id: "quests-done",
          tier: null,
          progress: 0,
          next: { tier: "bronze", target: 10 },
        }),
        expect.objectContaining({
          id: "cities-played",
          tier: null,
          next: { tier: "bronze", target: 2 },
        }),
        expect.objectContaining({ id: "top-ten", tier: null, next: { tier: "bronze", target: 1 } }),
        expect.objectContaining({
          id: "community-goals",
          tier: null,
          next: { tier: "bronze", target: 1 },
        }),
      ]);
      expect(await f.sync(player)).toEqual([]);
      expect(await f.earned(player)).toEqual([]);
    });

    it("earns a tier exactly at its threshold, once, and keeps it with the next tier as the goal", async () => {
      const player = await f.newPlayer();
      const event = await f.newEvent();
      const enrollment = await f.play(event, player, 9);
      expect(await f.sync(player)).toEqual([{ id: "events-attended", tier: "bronze" }]);
      expect(await progressOf(player, "quests-done")).toMatchObject({ tier: null, progress: 9 });
      await f.earn(event, enrollment);
      expect(await f.sync(player)).toEqual([{ id: "quests-done", tier: "bronze" }]);
      await f.earn(event, enrollment);
      expect(await f.sync(player)).toEqual([]);
      expect(await progressOf(player, "quests-done")).toMatchObject({
        tier: "bronze",
        progress: 11,
        next: { tier: "silver", target: 50 },
      });
      expect(await f.earned(player)).toEqual(["events-attended:bronze", "quests-done:bronze"]);
    });

    it("writes every tier a jump passes in one call, then nothing on a replay; gold has no next", async () => {
      await withThresholds("events", [1, 2, 3], async () => {
        const player = await f.newPlayer();
        for (let i = 0; i < 3; i += 1) await f.play(await f.newEvent(), player);
        expect(await f.sync(player)).toEqual([
          { id: "events-attended", tier: "bronze" },
          { id: "events-attended", tier: "silver" },
          { id: "events-attended", tier: "gold" },
        ]);
        expect(await f.sync(player)).toEqual([]);
        expect(await progressOf(player, "events-attended")).toMatchObject({
          tier: "gold",
          next: null,
        });
      });
    });

    it("keeps an earned tier when a removal drops the count below it", async () => {
      const player = await f.newPlayer();
      const event = await f.newEvent();
      const enrollment = await f.join(event, player);
      const entry = await f.earn(event, enrollment);
      expect(await f.sync(player)).toEqual([{ id: "events-attended", tier: "bronze" }]);
      await f.removeEntry(event, entry);
      expect(await progressOf(player, "events-attended")).toMatchObject({
        tier: "bronze",
        progress: 0,
      });
      expect(await f.sync(player)).toEqual([]);
      expect(await f.earned(player)).toEqual(["events-attended:bronze"]);
    });

    it("counts cities of played events only, never an event without a city or a virtual one", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent({ cityId: "sa-riyadh" }), player);
      await f.play(await f.newEvent({ cityId: "sa-riyadh" }), player);
      await f.play(await f.newEvent(), player);
      await f.play(await f.newEvent({ kind: "virtual" }), player);
      await f.join(await f.newEvent({ cityId: "sa-jeddah" }), player);
      expect(await progressOf(player, "cities-played")).toMatchObject({ progress: 1, tier: null });
      await f.sync(player);
      await f.play(await f.newEvent({ cityId: "sa-abha" }), player);
      expect(await f.sync(player)).toEqual([
        { id: "events-attended", tier: "silver" },
        { id: "cities-played", tier: "bronze" },
      ]);
    });

    it("counts a top-ten finish only once revealed, at rank 10 or better", async () => {
      const player = await f.newPlayer();
      const eleventh = await f.newEvent();
      for (let i = 0; i < 10; i += 1) {
        const other = await f.newPlayer();
        const enrollment = await f.join(eleventh, other);
        await f.earn(eleventh, enrollment, { points: 100 + i });
      }
      await f.earn(eleventh, await f.join(eleventh, player), { points: 5 });
      expect(await f.confirm(eleventh)).toBe("confirmed");
      expect(await f.reveal(eleventh)).toBe("revealed");
      await f.sync(player);
      expect(await progressOf(player, "top-ten")).toMatchObject({ progress: 0, tier: null });

      const first = await f.newEvent();
      await f.earn(first, await f.join(first, player), { points: 50 });
      expect(await f.confirm(first)).toBe("confirmed");
      expect(await f.sync(player)).toEqual([]);
      expect(await f.reveal(first)).toBe("revealed");
      expect(await f.sync(player)).toEqual([{ id: "top-ten", tier: "bronze" }]);
    });

    it("never counts a top-ten place held by welcome points alone; a member who played does", async () => {
      const event = await f.newEvent();
      await f.owner("UPDATE event SET welcome_points = 20 WHERE id = $1", [event]);
      const idle = await f.newPlayer();
      const player = await f.newPlayer();
      await f.join(event, idle);
      await f.play(event, player);
      expect(await f.confirm(event)).toBe("confirmed");
      expect(await f.reveal(event)).toBe("revealed");
      const [ranked] = await f.owner<{ n: number }>(
        "SELECT count(*)::integer AS n FROM final_rank WHERE event_id = $1",
        [event],
      );
      expect(ranked?.n).toBe(2);
      expect(await progressOf(idle, "top-ten")).toMatchObject({ progress: 0, tier: null });
      expect(await f.sync(idle)).toEqual([]);
      expect(await progressOf(player, "top-ten")).toMatchObject({ progress: 1 });
      expect(await f.sync(player)).toEqual([
        { id: "events-attended", tier: "bronze" },
        { id: "top-ten", tier: "bronze" },
      ]);
    });

    it("counts a community goal only when reached and contributed to, on a membership that counts", async () => {
      const player = await f.newPlayer();
      const event = await f.newEvent();
      const enrollment = await f.join(event, player);
      const goal = async (status: string) =>
        (
          await f.owner<{ id: string }>(
            `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status)
           VALUES ($1, $2, 'Together', 'points', 100, now() - interval '3 days', now() - interval '2 days', $3)
           RETURNING id`,
            [f.ids.orgA, event, status],
          )
        )[0]?.id;
      const contribute = (target: string | undefined, member: string) =>
        f.owner(
          "INSERT INTO community_contributor (goal_id, enrollment_id, event_id, first_at) VALUES ($1, $2, $3, now())",
          [target, member, event],
        );
      await contribute(await goal("missed"), enrollment);
      await goal("reached");
      expect(await progressOf(player, "community-goals")).toMatchObject({ progress: 0 });
      await contribute(await goal("reached"), enrollment);
      expect(await f.sync(player)).toEqual([{ id: "community-goals", tier: "bronze" }]);

      const banned = await f.newPlayer();
      const bannedEnrollment = await f.join(event, banned);
      await contribute(await goal("reached"), bannedEnrollment);
      await f.owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [bannedEnrollment]);
      expect(await progressOf(banned, "community-goals")).toMatchObject({ progress: 0 });
    });

    it("counts nothing from a banned or removed membership", async () => {
      const player = await f.newPlayer();
      for (const status of ["banned", "removed"]) {
        const event = await f.newEvent({ cityId: status === "banned" ? "sa-taif" : "sa-hail" });
        const enrollment = await f.play(event, player, 5);
        await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
      }
      expect((await own(player))?.map((row) => row.progress)).toEqual([0, 0, 0, 0, 0]);
      expect(await f.sync(player)).toEqual([]);
    });

    it("writes once and reports once when two syncs cross; the second waits on player_xp", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      const call = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const outcome = await f.crossed(call, call);
      expect(outcome.waited).toBe(true);
      expect((outcome.first as { r: unknown }).r).toEqual({
        achievements: [{ id: "events-attended", tier: "bronze" }],
        quests: [],
        levelUp: null,
      });
      expect((outcome.second as { r: unknown }).r).toEqual({
        achievements: [],
        quests: [],
        levelUp: null,
      });
      expect(await f.earned(player)).toEqual(["events-attended:bronze"]);
    });

    it.each(["erase-first", "sync-first"])(
      "crosses erasure without a deadlock and writes nothing after it commits: %s",
      async (order) => {
        const player = await f.newPlayer();
        await f.play(await f.newEvent(), player);
        const erase = {
          context: { playerId: player },
          sql: "SELECT * FROM erase_player($1, true, $2)",
          values: [await f.deletionToken(player), randomUUID()],
        };
        const sync = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
        const outcome =
          order === "erase-first" ? await f.crossed(erase, sync) : await f.crossed(sync, erase);
        expect(outcome.waited).toBe(true);
        if (order === "erase-first") {
          expect(outcome.second).toMatchObject({ code: "PI401" });
          expect(await f.earned(player)).toEqual([]);
        } else {
          expect(outcome.second).not.toBeInstanceOf(Error);
          expect(await f.earned(player)).toEqual(["events-attended:bronze"]);
        }
        await expect(f.sync(player)).rejects.toMatchObject({ code: "PI401" });
      },
    );

    it.each(["completion-first", "sync-first"])(
      "crosses a completion without a deadlock: %s",
      async (order) => {
        const player = await f.newPlayer();
        await f.play(await f.newEvent(), player);
        const live = await f.newEvent({ phase: "live" });
        await f.join(live, player);
        const [quest] = await f.owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, 'enter_code', 'Code', 10, '{"code":"ABC"}' FROM category WHERE event_id = $1 RETURNING id`,
          [live],
        );
        const complete = {
          context: { playerId: player },
          sql: "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
          values: [quest?.id, randomUUID()],
        };
        const sync = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
        const outcome =
          order === "completion-first"
            ? await f.crossed(complete, sync)
            : await f.crossed(sync, complete);
        expect(outcome.waited).toBe(true);
        expect(outcome.second).not.toBeInstanceOf(Error);
        expect(await f.earned(player)).toEqual(["events-attended:bronze"]);
        expect(await progressOf(player, "events-attended")).toMatchObject({ progress: 2 });
      },
    );

    it("refuses a caller that is not an active player", async () => {
      await expect(f.run({}, "SELECT questify_sync()")).rejects.toMatchObject({ code: "PI401" });
      await expect(f.run(f.team(), "SELECT questify_sync()")).rejects.toMatchObject({
        code: "PI401",
      });
      const banned = await f.newPlayer();
      await f.play(await f.newEvent(), banned);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      await expect(f.sync(banned)).rejects.toMatchObject({ code: "PI401" });
      expect(await own(banned)).toBeNull();
      expect(await f.earned(banned)).toEqual([]);
    });

    it("keeps the tables closed and earned rows append-only for every role", async () => {
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      await f.sync(player);
      for (const table of ["city", "achievement", "achievement_earned", "final_rank"]) {
        for (const sql of [`SELECT * FROM ${table}`, `DELETE FROM ${table}`]) {
          await expect(f.asPlayer(player, sql)).rejects.toThrow(/permission denied/);
        }
      }
      for (const sql of [
        "SELECT * FROM player_metrics(gen_random_uuid())",
        "SELECT * FROM standing_credits(gen_random_uuid())",
        "SELECT * FROM achievements_due(gen_random_uuid())",
        "SELECT earned_tier(gen_random_uuid(), 'top-ten')",
        "SELECT played_enrollment('active', NULL)",
        "SELECT public_achievements(gen_random_uuid())",
        "SELECT public_passport(gen_random_uuid())",
        "SELECT backfill_final_ranks()",
      ]) {
        await expect(f.asPlayer(player, sql), sql).rejects.toThrow(/permission denied/);
      }
      for (const sql of [
        "UPDATE achievement_earned SET earned_at = now() WHERE player_id = $1",
        "DELETE FROM achievement_earned WHERE player_id = $1",
      ]) {
        await expect(f.owner(sql, [player])).rejects.toThrow(/never be changed/);
      }
      await expect(f.owner("TRUNCATE achievement_earned")).rejects.toThrow(/never be changed/);
      expect(await f.earned(player)).toEqual(["events-attended:bronze"]);
    });
  },
);
