import { randomUUID } from "node:crypto";
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
 * The activity history in the database (T-115, migration 0023): a player reads only their own points record in the
 * event, newest first and page by page, with each quest's title, hidden quests included; nobody else reads anything.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the activity history (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newPlayer = async (status: string | null = "active", event = ids.eventA) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`activity_${counter}`],
    );
    if (status !== null) {
      await enroll(player?.id ?? "", event, status);
    }
    return player?.id ?? "";
  };

  const enroll = (player: string, event: string, status = "active") =>
    owner(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1",
      [event, player, status],
    );

  const newQuest = async (event = ids.eventA, title = "Find the word"): Promise<string> => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       SELECT $1, id, 'enter_code', $2, 10, 5, '{"code": "SECRET"}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [event, title],
    );
    return quest?.id ?? "";
  };

  const complete = (player: string, quest: string) =>
    withRequestContext(db.app, { playerId: player }, () =>
      db.app.query("SELECT * FROM complete_quest($1, 'code', NULL, 'SECRET', $2, NULL)", [
        quest,
        randomUUID(),
      ]),
    );

  const read = (player: string, before: string | null = null, page = 25, event = ids.eventA) =>
    withRequestContext(
      db.app,
      { playerId: player },
      async () =>
        (
          await db.app.query<Row>("SELECT * FROM member_activity($1, $2, $3)", [
            event,
            before,
            page,
          ])
        ).rows,
    );

  it("lists only the caller's own entries in this event, newest first, with the quest's title", async () => {
    const quest = await newQuest();
    const me = await newPlayer();
    const someoneElse = await newPlayer();
    await complete(me, quest);
    await complete(someoneElse, quest);
    await complete(me, quest);
    const rows = await read(me);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row["title_en"])).toEqual(["Find the word", "Find the word"]);
    expect(Number(rows[0]?.["id"])).toBeGreaterThan(Number(rows[1]?.["id"]));
    expect(rows[0]).toMatchObject({
      kind: "quest",
      score_delta: "10",
      balance_delta: "10",
      quest_id: quest,
    });
  });

  it("keeps each event's record apart for a player in two events", async () => {
    const me = await newPlayer();
    await enroll(me, ids.eventB);
    await complete(me, await newQuest(ids.eventA, "In A"));
    await complete(me, await newQuest(ids.eventB, "In B"));
    expect((await read(me)).map((row) => row["title_en"])).toEqual(["In A"]);
    expect((await read(me, null, 25, ids.eventB)).map((row) => row["title_en"])).toEqual(["In B"]);
  });

  it("pages by id and caps the page", async () => {
    const quest = await newQuest();
    const me = await newPlayer();
    for (let n = 0; n < 5; n += 1) {
      await complete(me, quest);
    }
    const first = await read(me, null, 2);
    const second = await read(me, String(first.at(-1)?.["id"]), 2);
    const third = await read(me, String(second.at(-1)?.["id"]), 2);
    expect([first.length, second.length, third.length]).toEqual([2, 2, 1]);
    expect(new Set([...first, ...second, ...third].map((row) => row["id"])).size).toBe(5);
    expect(await read(me, null, 0)).toHaveLength(1);
    expect(await read(me, null, 1000)).toHaveLength(5);
  });

  it("still names a quest that is hidden now", async () => {
    const quest = await newQuest(ids.eventA, "Now hidden");
    const me = await newPlayer();
    await complete(me, quest);
    await owner("UPDATE quest SET visible = false WHERE id = $1", [quest]);
    expect((await read(me))[0]?.["title_en"]).toBe("Now hidden");
  });

  it.each(["pending", "left", "removed", "banned"])("gives a %s member nothing", async (status) => {
    const quest = await newQuest();
    const player = await newPlayer();
    await complete(player, quest);
    await owner("UPDATE enrollment SET status = $2 WHERE player_id = $1", [player, status]);
    expect(await read(player)).toEqual([]);
  });

  it("gives nothing to a banned player, a stranger, another organizer's player or no player", async () => {
    const quest = await newQuest();
    const banned = await newPlayer();
    await complete(banned, quest);
    await owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
    expect(await read(banned)).toEqual([]);
    expect(await read(await newPlayer(null))).toEqual([]);
    expect(await read(ids.playerB)).toEqual([]);
    expect(
      (await db.app.query("SELECT * FROM member_activity($1, NULL, 25)", [ids.eventA])).rows,
    ).toEqual([]);
  });

  it("is closed to the public", async () => {
    const [row] = await owner<{ allowed: boolean }>(
      "SELECT has_function_privilege('public', 'member_activity(uuid, bigint, integer)', 'EXECUTE') AS allowed",
    );
    expect(row?.allowed).toBe(false);
  });
});
