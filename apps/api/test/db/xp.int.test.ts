import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Level = {
  xp: string;
  level: number;
  level_from: string;
  next_level_at: string | null;
  title_ar: string;
  title_en: string;
  level_up: number | null;
  up_title_ar: string | null;
  up_title_en: string | null;
};

/**
 * Questify XP in the database (T-401, migration 0039, ADR-179 to ADR-182): one credit per (player, quest) from any
 * writer of a quest entry, nothing from repeats, awards or rehearsals, one reversal per removed credit, levels reached
 * once and kept, the server-only amount and its guard, append-only rows, the backfill, and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("Questify XP (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });
  afterEach(async () => {
    await setQuestXp(100);
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const team: RequestContext = { organizerId: "", staffUserId: "" };
  const teamA = (): RequestContext => ({ ...team, organizerId: ids.orgA, staffUserId: ownerA });
  const setQuestXp = (amount: number) =>
    owner(
      "UPDATE platform_setting SET value = jsonb_build_object('questXp', $1::int) WHERE key = 'xp'",
      [amount],
    );

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, award_cap_each, award_cap_day)
       VALUES ($1, $2, 'XP Fest', 'live', now() - interval '1 hour', now() + interval '1 day', 500, 5000) RETURNING id`,
      [ids.orgA, `XPF${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, repeatCap = 1): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, 'enter_code', 'Booth', 10, $3, '{"code": "ABC"}') RETURNING id`,
      [event, category?.id, repeatCap],
    );
    return quest?.id ?? "";
  };
  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`xp_player_${counter}`],
    );
    return player?.id ?? "";
  };
  const enroll = async (player: string, event: string, via = "code"): Promise<string> => {
    const [enrolled] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.orgA, event, player, via],
    );
    return enrolled?.id ?? "";
  };

  /** The team's quest award: a manual completion, a `quest` entry. Answers the ledger entry's id. */
  const award = async (
    event: string,
    enrollment: string,
    quest: string | null,
    amount: number | null = null,
  ) =>
    (
      await query<{ entry_id: string }>(
        teamA(),
        "SELECT * FROM staff_award($1, $2, $3, $4, 'Helped', $5, $6)",
        [event, enrollment, quest, amount, randomUUID(), randomUUID()],
      )
    )[0]?.entry_id ?? "";
  const remove = (event: string, entry: string) =>
    query(teamA(), "SELECT * FROM remove_award($1, $2, 'Cheating', $3, $4)", [
      event,
      entry,
      randomUUID(),
      randomUUID(),
    ]);
  const complete = async (player: string, quest: string, key = randomUUID(), client?: Client) => {
    const sql = "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)";
    if (client === undefined) {
      return (
        (await query<{ completion_id: string }>({ playerId: player }, sql, [quest, key]))[0]
          ?.completion_id ?? ""
      );
    }
    return withRequestContext(
      client,
      { playerId: player },
      async () =>
        (await client.query<{ completion_id: string }>(sql, [quest, key])).rows[0]?.completion_id ??
        "",
    );
  };
  const xpOf = async (player: string) =>
    (
      await owner<{ xp: string; level: number }>(
        "SELECT xp, level FROM player_xp WHERE player_id = $1",
        [player],
      )
    )[0];
  const reached = async (player: string) =>
    (
      await owner<{ level: number }>(
        "SELECT level FROM level_reached WHERE player_id = $1 ORDER BY level",
        [player],
      )
    ).map((row) => row.level);
  const levelOf = async (player: string, completion: string | null = null) =>
    (await query<Level>({ playerId: player }, "SELECT * FROM own_level($1)", [completion]))[0];
  const completionOf = async (entry: string) =>
    (
      await owner<{ completion_id: string }>(
        "SELECT completion_id FROM ledger_entry WHERE id = $1",
        [entry],
      )
    )[0]?.completion_id ?? "";

  describe("paying", () => {
    it("pays the amount once per quest: a repeat and a replay with the same key pay nothing", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 3);
      const player = await newPlayer();
      await enroll(player, event);
      const key = randomUUID();
      await complete(player, quest, key);
      await complete(player, quest, key);
      await complete(player, quest);
      expect(await xpOf(player)).toEqual({ xp: "100", level: 1 });
      expect(
        await owner("SELECT count(*)::int AS n FROM xp_entry WHERE player_id = $1", [player]),
      ).toEqual([{ n: 1 }]);
    });

    it("pays a quest awarded by the team, never an amount award", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer();
      const enrollment = await enroll(player, event);
      await award(event, enrollment, null, 40);
      expect(await xpOf(player)).toEqual({ xp: "0", level: 1 });
      await award(event, enrollment, quest);
      expect(await xpOf(player)).toEqual({ xp: "100", level: 1 });
    });

    it("pays nothing for a rehearsal account's quest entry", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer();
      const enrollment = await enroll(player, event, "rehearsal");
      const [made] = await owner<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'code', $5) RETURNING id`,
        [ids.orgA, event, enrollment, quest, randomUUID()],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                                   quest_id, actor)
         VALUES ($1, $2, $3, 'quest', 10, 10, $4, $5, 'player')`,
        [ids.orgA, event, enrollment, made?.id, quest],
      );
      expect(await xpOf(player)).toEqual({ xp: "0", level: 1 });
    });

    it("sums two events into one level, and two simultaneous scans of one quest pay once", async () => {
      const [first, second] = [await newEvent(), await newEvent()];
      const [questOne, questTwo] = [await newQuest(first, 2), await newQuest(second)];
      const player = await newPlayer();
      await enroll(player, first);
      await enroll(player, second);
      const clients = [
        new Client({ connectionString: db.appUrl }),
        new Client({ connectionString: db.appUrl }),
      ];
      await Promise.all(clients.map((client) => client.connect()));
      try {
        await Promise.all(
          clients.map((client) => complete(player, questOne, randomUUID(), client)),
        );
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      expect(await xpOf(player)).toEqual({ xp: "100", level: 1 });
      const done = await complete(player, questTwo);
      expect(await xpOf(player)).toEqual({ xp: "200", level: 2 });
      expect(await levelOf(player, done)).toMatchObject({
        level: 2,
        level_up: 2,
        next_level_at: "500",
      });
    });

    it("writes one row per level on a jump, and the amount set by an admin applies to the next credit", async () => {
      await setQuestXp(500);
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer();
      await enroll(player, event);
      const done = await complete(player, quest);
      expect(await xpOf(player)).toEqual({ xp: "500", level: 3 });
      expect(await reached(player)).toEqual([2, 3]);
      expect(await levelOf(player, done)).toEqual({
        xp: "500",
        level: 3,
        level_from: "500",
        next_level_at: "900",
        title_ar: "مستكشف",
        title_en: "Explorer",
        level_up: 3,
        up_title_ar: "مستكشف",
        up_title_en: "Explorer",
      });
    });
    it("names the level's title by its range, and shows no next level at the top", async () => {
      await setQuestXp(2000);
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer();
      await enroll(player, event);
      const done = await complete(player, quest);
      expect(await levelOf(player, done)).toMatchObject({
        level: 6,
        title_en: "Pathfinder",
        up_title_ar: "مقتفي الأثر",
      });
      expect(await reached(player)).toEqual([2, 3, 4, 5, 6]);
      await setQuestXp(50000);
      await complete(player, await newQuest(event));
      expect(await levelOf(player)).toMatchObject({
        level: 30,
        level_from: "46400",
        next_level_at: null,
        title_en: "Legend",
        level_up: null,
      });
    });
  });

  describe("removing", () => {
    it("takes back a removed credit once; the quest never pays again", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 3);
      const player = await newPlayer();
      const enrollment = await enroll(player, event);
      const first = await award(event, enrollment, quest);
      const second = await award(event, enrollment, quest);
      await remove(event, second);
      expect(await xpOf(player)).toEqual({ xp: "100", level: 1 });
      await remove(event, first);
      expect(await xpOf(player)).toEqual({ xp: "0", level: 1 });
      await award(event, enrollment, quest);
      expect(await xpOf(player)).toEqual({ xp: "0", level: 1 });
      expect(
        await owner("SELECT source, delta FROM xp_entry WHERE player_id = $1 ORDER BY id", [
          player,
        ]),
      ).toEqual([
        { source: "quest", delta: 100 },
        { source: "removal", delta: -100 },
      ]);
    });

    it("changes nothing when an amount award is removed", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer();
      const enrollment = await enroll(player, event);
      await award(event, enrollment, quest);
      await remove(event, await award(event, enrollment, null, 30));
      expect(await xpOf(player)).toEqual({ xp: "100", level: 1 });
    });

    it("keeps a level reached after a drop; climbing back writes no new row and no level-up", async () => {
      await setQuestXp(200);
      const event = await newEvent();
      const [questOne, questTwo] = [await newQuest(event), await newQuest(event)];
      const player = await newPlayer();
      const enrollment = await enroll(player, event);
      const first = await award(event, enrollment, questOne);
      expect(await levelOf(player, await completionOf(first))).toMatchObject({
        level: 2,
        level_up: 2,
      });
      await remove(event, first);
      expect(await xpOf(player)).toEqual({ xp: "0", level: 1 });
      expect(await reached(player)).toEqual([2]);
      const again = await award(event, enrollment, questTwo);
      expect(await xpOf(player)).toEqual({ xp: "200", level: 2 });
      expect(await reached(player)).toEqual([2]);
      expect(await levelOf(player, await completionOf(again))).toMatchObject({
        level: 2,
        level_up: null,
      });
    });
  });

  describe("the amount", () => {
    it.each([{ questXp: 0 }, { questXp: "abc" }, { questXp: 100_000 }, { questXp: -5 }, {}])(
      "refuses a bad value on write: %j",
      async (value) => {
        await expect(
          owner("UPDATE platform_setting SET value = $1 WHERE key = 'xp'", [JSON.stringify(value)]),
        ).rejects.toMatchObject({ code: "23514" });
      },
    );

    it("pays 100 when the setting is missing", async () => {
      await db.owner.query("BEGIN");
      try {
        await db.owner.query("DELETE FROM platform_setting WHERE key = 'xp'");
        expect((await db.owner.query("SELECT quest_xp() AS amount")).rows).toEqual([
          { amount: 100 },
        ]);
      } finally {
        await db.owner.query("ROLLBACK");
      }
    });
  });

  describe("records", () => {
    it("never waits on the player's row, so a deletion holding it cannot deadlock a completion", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const player = await newPlayer();
      await enroll(player, event);
      // As erase_player: the player's row held FOR UPDATE while the completion runs to its end.
      await db.owner.query("BEGIN");
      try {
        await db.owner.query("SELECT 1 FROM player WHERE id = $1 FOR UPDATE", [player]);
        await complete(player, quest);
      } finally {
        await db.owner.query("ROLLBACK");
      }
      expect(await xpOf(player)).toEqual({ xp: "100", level: 1 });
    });

    it("keeps XP rows and levels reached append-only for every role", async () => {
      for (const sql of [
        "UPDATE xp_entry SET delta = 5",
        "DELETE FROM xp_entry",
        "TRUNCATE xp_entry CASCADE",
        "UPDATE level_reached SET level = 9",
        "DELETE FROM level_reached",
        "TRUNCATE level_reached",
      ]) {
        await expect(owner(sql), sql).rejects.toThrow(/can never be changed/);
      }
    });

    it("counts nothing twice when the backfill runs again", async () => {
      const before = await owner("SELECT player_id, xp, level FROM player_xp ORDER BY player_id");
      const entries = await owner("SELECT count(*)::int AS n FROM xp_entry");
      const levels = await owner("SELECT count(*)::int AS n FROM level_reached");
      await owner("SELECT xp_backfill()");
      await owner("SELECT xp_backfill()");
      expect(await owner("SELECT player_id, xp, level FROM player_xp ORDER BY player_id")).toEqual(
        before,
      );
      expect(await owner("SELECT count(*)::int AS n FROM xp_entry")).toEqual(entries);
      expect(await owner("SELECT count(*)::int AS n FROM level_reached")).toEqual(levels);
    });

    it("gives a deleted or unknown caller no level", async () => {
      expect(await query({ playerId: randomUUID() }, "SELECT * FROM own_level(NULL)")).toEqual([]);
    });
  });

  describe("closed doors", () => {
    it("keeps the XP tables and helpers away from the API role; own_level is its only door", async () => {
      for (const sql of [
        "SELECT * FROM player_xp",
        "SELECT * FROM xp_entry",
        "SELECT * FROM level_reached",
        "SELECT * FROM xp_level",
        "SELECT * FROM level_title",
        "SELECT quest_xp()",
        "SELECT xp_level_of(5)",
        "SELECT xp_backfill()",
        "SELECT xp_credit(NULL::ledger_entry)",
        "SELECT xp_reverse(NULL::ledger_entry)",
        "SELECT xp_apply(gen_random_uuid(), 1, 1)",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
