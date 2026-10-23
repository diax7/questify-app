import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Today's ranking in the database (T-216, migration 0035): today's points from today's ledger entries only, the day's
 * start hour, the overall tie rule and exclusions, multi-day events only, and who may read.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("today's ranking (database)", () => {
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
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);

  /**
   * A live event of organizer A whose day starts 12 hours from the current hour, so "now ± a few hours" never crosses
   * a day start. Multi-day by default (started 2 days ago); `single` spans an hour each side of now.
   */
  const newEvent = async (single = false): Promise<string> => {
    counter += 1;
    const span = single
      ? "now() - interval '1 hour', now() + interval '1 hour'"
      : "now() - interval '2 days', now() + interval '1 day'";
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, day_start_hour)
       VALUES ($1, $2, 'Day Fest', 'live', ${span},
               (extract(hour FROM now() AT TIME ZONE 'Asia/Riyadh')::int + 12) % 24) RETURNING id`,
      [ids.orgA, `DAY${counter}`],
    );
    return event?.id ?? "";
  };

  const newPlayer = async (event: string): Promise<{ player: string; enrollment: string }> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`dayer_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `dayer${counter}@najd.sa`,
    ]);
    const [enrollment] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, event, player?.id],
    );
    return { player: player?.id ?? "", enrollment: enrollment?.id ?? "" };
  };

  const newQuest = async (event: string, points: number): Promise<string> => {
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      event,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, 'enter_code', 'Day', $3, 10, '{"code":"DAY"}') RETURNING id`,
      [event, general?.id, points],
    );
    return quest?.id ?? "";
  };

  const complete = async (player: string, quest: string): Promise<string> => {
    const [done] = await as<{ completion_id: string }>(
      { playerId: player },
      "SELECT * FROM complete_quest($1, 'code', NULL, 'DAY', $2, NULL)",
      [quest, randomUUID()],
    );
    return done?.completion_id ?? "";
  };

  /** Points written at a past moment, as the system's welcome gift (the ledger takes a stated time from the owner). */
  const earnedAgo = (event: string, enrollment: string, points: number, ago: string) =>
    owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 created_at)
       VALUES ($1, $2, $3, 'welcome', $4, $4, 'system', now() - $5::interval)`,
      [ids.orgA, event, enrollment, points, ago],
    );

  const top = async (event: string, reader: string) =>
    (
      await as<{ enrollment_id: string; score: string }>(
        { playerId: reader },
        "SELECT enrollment_id, score FROM ranking_day_top($1, 10)",
        [event],
      )
    ).map((row) => [row.enrollment_id, Number(row.score)]);
  const position = async (event: string, reader: string) =>
    (
      await as<{ place: string | null; total: string }>(
        { playerId: reader },
        "SELECT place, total FROM ranking_day_position($1)",
        [event],
      )
    )[0];
  const today = async (event: string, context: RequestContext) =>
    (
      await as<{ multi_day: boolean; live: boolean; my_score: string | null }>(
        context,
        "SELECT multi_day, live, my_score FROM ranking_today($1)",
        [event],
      )
    )[0];

  it("counts only points earned since the event day started", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, 50);
    const a = await newPlayer(event);
    const b = await newPlayer(event);
    await earnedAgo(event, a.enrollment, 200, "1 day");
    await complete(a.player, quest);
    await earnedAgo(event, b.enrollment, 500, "1 day");
    expect(await top(event, a.player)).toEqual([[a.enrollment, 50]]);
    expect(await position(event, a.player)).toEqual({ place: "1", total: "1" });
    expect(await position(event, b.player)).toEqual({ place: null, total: "1" });
    expect(await today(event, { playerId: a.player })).toEqual({
      multi_day: true,
      live: true,
      my_score: "50",
    });
    expect(await today(event, { playerId: b.player })).toMatchObject({ my_score: "0" });
  });

  it("moves an entry into the day before when the day starts after it", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    await earnedAgo(event, a.enrollment, 30, "2 hours");
    expect(await top(event, a.player)).toEqual([[a.enrollment, 30]]);
    await owner(
      `UPDATE event SET day_start_hour = (extract(hour FROM now() AT TIME ZONE 'Asia/Riyadh')::int + 23) % 24
       WHERE id = $1`,
      [event],
    );
    expect(await top(event, a.player)).toEqual([]);
    expect(await today(event, { playerId: a.player })).toMatchObject({ my_score: "0" });
  });

  it("orders by today's points, then whoever reached them first today, and leaves out the excluded", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, 10);
    const [a, b, c, banned] = [
      await newPlayer(event),
      await newPlayer(event),
      await newPlayer(event),
      await newPlayer(event),
    ];
    // a led yesterday by far; today b reaches 10 first, then a.
    await earnedAgo(event, a.enrollment, 900, "1 day");
    await complete(b?.player ?? "", quest);
    await complete(a?.player ?? "", quest);
    await complete(c?.player ?? "", quest);
    await complete(c?.player ?? "", quest);
    await complete(banned?.player ?? "", quest);
    await complete(banned?.player ?? "", quest);
    await complete(banned?.player ?? "", quest);
    await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned?.enrollment]);
    expect(await top(event, a?.player ?? "")).toEqual([
      [c?.enrollment, 20],
      [b?.enrollment, 10],
      [a?.enrollment, 10],
    ]);
    expect(await position(event, a?.player ?? "")).toEqual({ place: "3", total: "3" });
    const entries = await as<{ enrollment_id: string; score: string; ranked: boolean }>(
      {},
      "SELECT enrollment_id, score, ranked FROM ranking_day_entries($1, (SELECT day FROM ranking_today($1)))",
      [event],
    );
    expect(entries.filter((row) => !row.ranked).map((row) => row.enrollment_id)).toEqual([
      banned?.enrollment,
    ]);
  });

  it("takes a player whose points today were removed off today's board", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    const staff = await addMember(db.owner, ids.orgA, "editor");
    await earnedAgo(event, a.enrollment, 100, "1 day");
    await complete(a.player, await newQuest(event, 20));
    expect(await top(event, a.player)).toEqual([[a.enrollment, 20]]);
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id, reverses)
       SELECT $1, $2, $3, 'removal', -100, -100, 'staff', $4, min(id) FROM ledger_entry WHERE enrollment_id = $3`,
      [ids.orgA, event, a.enrollment, staff],
    );
    expect(await top(event, a.player)).toEqual([]);
    expect(await today(event, { playerId: a.player })).toMatchObject({ my_score: "-80" });
  });

  it("gives the after-scan entry for a multi-day event only, and only to the scanner", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    const b = await newPlayer(event);
    await earnedAgo(event, a.enrollment, 70, "1 day");
    const done = await complete(a.player, await newQuest(event, 15));
    const [entry] = await as<{ enrollment_id: string; score: string; ranked: boolean }>(
      { playerId: a.player },
      "SELECT enrollment_id, score, ranked FROM ranking_day_entry_of($1)",
      [done],
    );
    expect(entry).toEqual({ enrollment_id: a.enrollment, score: "15", ranked: true });
    expect(
      await as({ playerId: b.player }, "SELECT * FROM ranking_day_entry_of($1)", [done]),
    ).toEqual([]);
    const single = await newEvent(true);
    const c = await newPlayer(single);
    const once = await complete(c.player, await newQuest(single, 5));
    expect(
      await as({ playerId: c.player }, "SELECT * FROM ranking_day_entry_of($1)", [once]),
    ).toEqual([]);
    expect(await today(single, { playerId: c.player })).toMatchObject({ multi_day: false });
  });

  it("answers only the system and the event's active players", async () => {
    const event = await newEvent();
    const a = await newPlayer(event);
    await complete(a.player, await newQuest(event, 5));
    expect(await today(event, {})).toEqual({ multi_day: true, live: true, my_score: null });
    expect(await today(event, { playerId: ids.playerB })).toBeUndefined();
    const staff = await addMember(db.owner, ids.orgA, "owner");
    expect(await today(event, { organizerId: ids.orgA, staffUserId: staff })).toBeUndefined();
    expect(await top(event, ids.playerB)).toEqual([]);
    expect(await position(event, ids.playerB)).toBeUndefined();
    expect(
      await as({ playerId: a.player }, "SELECT * FROM ranking_day_entries($1, current_date)", [
        event,
      ]),
    ).toEqual([]);
    await expect(
      as({}, "SELECT * FROM ranked_day($1, current_date)", [event]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
