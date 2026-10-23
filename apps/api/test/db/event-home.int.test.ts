import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * What an event's members read and the pinned quest (T-113, migration 0021): only an active member of the event reads
 * its visible quests, never their answers, each with that player's own completions; the pin is a quest of the same
 * event and goes with it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the event home (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let category: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    const [general] = (
      await db.owner.query<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        ids.eventA,
      ])
    ).rows;
    category = general?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const focusOf = async (event: string) =>
    (
      await owner<{ focus_quest_id: string | null }>(
        "SELECT focus_quest_id FROM event WHERE id = $1",
        [event],
      )
    )[0]?.focus_quest_id;

  const newPlayer = async (
    enrollment: string | null = "active",
    event = ids.eventA,
  ): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`home_${counter}`],
    );
    if (enrollment !== null) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, status) SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1",
        [event, player?.id, enrollment],
      );
    }
    return player?.id ?? "";
  };

  const newQuest = async (fields: { visible?: boolean; cap?: number } = {}): Promise<string> => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       VALUES ($1, $2, 'enter_code', 'Find the word', 10, $3, $4, '{"code": "SECRET"}') RETURNING id`,
      [ids.eventA, category, fields.cap ?? 1, fields.visible ?? true],
    );
    return quest?.id ?? "";
  };

  const read = (player: string, event = ids.eventA, client: Client = db.app) =>
    withRequestContext(
      client,
      { playerId: player },
      async () => (await client.query<Row>("SELECT * FROM member_event_quests($1)", [event])).rows,
    );

  const complete = (player: string, quest: string) =>
    withRequestContext(db.app, { playerId: player }, () =>
      db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'SECRET', $2, NULL)", [
        quest,
        randomUUID(),
      ]),
    );

  describe("member_event_quests", () => {
    it("gives an active member the visible quests by named columns, never the answer", async () => {
      const shown = await newQuest();
      const hidden = await newQuest({ visible: false });
      const rows = await read(await newPlayer());
      const questIds = rows.map((row) => row["quest_id"]);
      expect(questIds).toContain(shown);
      expect(questIds).not.toContain(hidden);
      expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual(
        [
          "category_id",
          "category_name_ar",
          "category_name_en",
          "category_position",
          "closes_at",
          "description_ar",
          "description_en",
          "done",
          "earned",
          "opens_at",
          "points",
          "quest_id",
          "quest_position",
          "repeat_cap",
          "verification",
          "order_mode",
          "category_opens_at",
          "unlock_after",
          "unlock_after_name_ar",
          "unlock_after_name_en",
          "completion_bonus",
          "bonus_earned",
          "lock",
          "title_ar",
          "title_en",
          "type",
        ].toSorted(),
      );
      expect(JSON.stringify(rows)).not.toContain("SECRET");
    });

    it("counts only the calling player's own completions", async () => {
      const quest = await newQuest({ cap: 3 });
      const me = await newPlayer();
      const someoneElse = await newPlayer();
      await complete(me, quest);
      await complete(someoneElse, quest);
      await complete(someoneElse, quest);
      const done = (rows: Row[]) => rows.find((row) => row["quest_id"] === quest)?.["done"];
      expect(done(await read(me))).toBe(1);
      expect(done(await read(someoneElse))).toBe(2);
      expect(done(await read(await newPlayer()))).toBe(0);
    });

    it("sums the calling player's own points from the ledger, unmoved by a later points change", async () => {
      const quest = await newQuest({ cap: 3 });
      const me = await newPlayer();
      const someoneElse = await newPlayer();
      await complete(me, quest);
      await owner("UPDATE quest SET points = 25 WHERE id = $1", [quest]);
      await complete(me, quest);
      await complete(someoneElse, quest);
      const earned = (rows: Row[]) => rows.find((row) => row["quest_id"] === quest)?.["earned"];
      expect(earned(await read(me))).toBe("35");
      expect(earned(await read(someoneElse))).toBe("25");
      expect(earned(await read(await newPlayer()))).toBe("0");
    });

    it.each(["pending", "left", "removed", "banned"])(
      "gives a %s member nothing",
      async (status) => {
        await newQuest();
        expect(await read(await newPlayer(status))).toEqual([]);
      },
    );

    it("gives nothing to a banned player, a stranger, another organizer's player, or no player", async () => {
      await newQuest();
      const banned = await newPlayer();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      expect(await read(banned)).toEqual([]);
      expect(await read(await newPlayer(null))).toEqual([]);
      expect(await read(await newPlayer("active", ids.eventB))).toEqual([]);
      expect(await read(ids.playerB)).toEqual([]);
      expect(
        (await db.app.query("SELECT * FROM member_event_quests($1)", [ids.eventA])).rows,
      ).toEqual([]);
    });

    it("is closed to the public", async () => {
      const { rows } = await db.owner.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('public', 'member_event_quests(uuid)', 'EXECUTE') AS allowed",
      );
      expect(rows[0]?.allowed).toBe(false);
    });
  });

  describe("the pinned quest", () => {
    it("cannot be set by a player", async () => {
      const quest = await newQuest();
      const player = await newPlayer();
      const changed = await withRequestContext(
        db.app,
        { playerId: player },
        async () =>
          (
            await db.app.query("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [
              ids.eventA,
              quest,
            ])
          ).rowCount,
      );
      expect(changed).toBe(0);
      expect(await focusOf(ids.eventA)).not.toBe(quest);
    });

    it("is a quest of the same event only", async () => {
      const [theirs] = await owner<{ id: string }>(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) SELECT $1, id, 'scan_qr', 'Theirs', 5 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id",
        [ids.eventB],
      );
      await expect(
        db.owner.query("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [
          ids.eventA,
          theirs?.id,
        ]),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("clears when its quest is deleted, and leaves the event's other fields", async () => {
      const quest = await newQuest();
      await owner("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [ids.eventA, quest]);
      await owner("DELETE FROM quest WHERE id = $1", [quest]);
      expect(await focusOf(ids.eventA)).toBeNull();
      expect((await owner("SELECT 1 FROM event WHERE id = $1", [ids.eventA])).length).toBe(1);
    });

    it("lets a draft event with a pin be deleted", async () => {
      const [draft] = await owner<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'PINDRAFT', 'Draft') RETURNING id",
        [ids.orgA],
      );
      const [quest] = await owner<{ id: string }>(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) SELECT $1, id, 'scan_qr', 'Q', 5 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id",
        [draft?.id],
      );
      await owner("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [draft?.id, quest?.id]);
      await owner("DELETE FROM event WHERE id = $1", [draft?.id]);
      expect(await owner("SELECT 1 FROM event WHERE id = $1", [draft?.id])).toEqual([]);
    });
  });
});
