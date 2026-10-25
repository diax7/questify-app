import { randomUUID } from "node:crypto";
import type { Client } from "pg";
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
 * Rankings in the database (T-106, migration 0015): the order (points, then who reached them first), who is ranked,
 * the readers' rules, and the durable repair marks that every eligibility change leaves.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("rankings (database)", () => {
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
  const as = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) => withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);

  /** A live event of organizer A of its own, so each test has a ranking to itself. */
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Rank Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `RANK${counter}`],
    );
    return event?.id ?? "";
  };

  const newPlayer = async (
    event: string,
    email?: string,
  ): Promise<{ player: string; enrollment: string }> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`ranker_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      email ?? `ranker${counter}@najd.sa`,
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
       VALUES ($1, $2, 'enter_code', 'Rank', $3, 10, '{"code":"RANK"}') RETURNING id`,
      [event, general?.id, points],
    );
    return quest?.id ?? "";
  };

  const complete = async (player: string, quest: string): Promise<string> => {
    const [done] = await as<{ completion_id: string }>(
      { playerId: player },
      "SELECT * FROM complete_quest($1, 'code', NULL, 'RANK', $2, NULL)",
      [quest, randomUUID()],
    );
    return done?.completion_id ?? "";
  };

  const top = (event: string, reader: string) =>
    as<{ enrollment_id: string; username: string; score: string }>(
      { playerId: reader },
      "SELECT * FROM ranking_top($1, 10)",
      [event],
    );
  const topIds = async (event: string, reader: string) =>
    (await top(event, reader)).map((row) => row.enrollment_id);
  const position = async (event: string, reader: string) =>
    (
      await as<{ enrollment_id: string; place: string | null; total: string }>(
        { playerId: reader },
        "SELECT * FROM ranking_position($1)",
        [event],
      )
    )[0];
  const marked = async (event: string) =>
    (await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).length === 1;
  const clearMarks = () => owner("DELETE FROM ranking_repair");

  describe("the order", () => {
    it("keeps the ledger entry that last changed the points as the version", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      const completion = await complete(a.player, await newQuest(event, 10));
      const [ledger] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE completion_id = $1",
        [completion],
      );
      const [enrollment] = await owner<{ score_version: string }>(
        "SELECT score_version FROM enrollment WHERE id = $1",
        [a.enrollment],
      );
      expect(enrollment?.score_version).toBe(ledger?.id);
      await complete(a.player, await newQuest(event, 0));
      const [after] = await owner<{ score_version: string }>(
        "SELECT score_version FROM enrollment WHERE id = $1",
        [a.enrollment],
      );
      expect(after?.score_version).toBe(ledger?.id);
    });

    it("ranks by points, and among equal points whoever reached them first (FR-606)", async () => {
      const event = await newEvent();
      const ten = await newQuest(event, 10);
      const [a, b, c] = [await newPlayer(event), await newPlayer(event), await newPlayer(event)];
      await complete(b.player, ten);
      await complete(a.player, ten);
      expect(await topIds(event, a.player)).toEqual([b.enrollment, a.enrollment]);
      await complete(c.player, ten);
      await complete(c.player, ten);
      expect(await topIds(event, a.player)).toEqual([c.enrollment, b.enrollment, a.enrollment]);
      await complete(a.player, ten);
      expect(await topIds(event, a.player)).toEqual([c.enrollment, a.enrollment, b.enrollment]);
      expect(await position(event, b.player)).toEqual({
        enrollment_id: b.enrollment,
        place: "3",
        total: "3",
      });
    });

    it("gives no place to a player with no points, and no row to someone not in the event", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      await complete(a.player, await newQuest(event, 5));
      const idle = await newPlayer(event);
      expect(await position(event, idle.player)).toEqual({
        enrollment_id: idle.enrollment,
        place: null,
        total: "1",
      });
      expect(await position(event, ids.playerB)).toBeUndefined();
      expect(await top(event, ids.playerB)).toEqual([]);
    });
  });

  describe("who is ranked (FR-609, FR-318, FR-1014)", () => {
    it("leaves out a banned or removed enrollment, a banned account and the organizer's own team", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 10);
      const reader = await newPlayer(event);
      await complete(reader.player, quest);
      const banned = await newPlayer(event);
      const removed = await newPlayer(event);
      const account = await newPlayer(event);
      const staff = await addMember(db.owner, ids.orgA, "editor");
      const [member] = await owner<{ email: string }>(
        "SELECT email FROM staff_user WHERE id = $1",
        [staff],
      );
      const team = await newPlayer(event, member?.email);
      for (const who of [banned, removed, account, team]) {
        await complete(who.player, quest);
      }
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [removed.enrollment]);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [account.player]);
      expect(await topIds(event, reader.player)).toEqual([reader.enrollment]);
      expect((await position(event, reader.player))?.total).toBe("1");
      const flags = await as<{ enrollment_id: string; ranked: boolean }>(
        {},
        "SELECT enrollment_id, ranked FROM ranking_entries($1) ORDER BY ranked",
        [event],
      );
      expect(flags).toHaveLength(5);
      expect(flags.filter((row) => row.ranked).map((row) => row.enrollment_id)).toEqual([
        reader.enrollment,
      ]);
      // The one-row rule and the whole-event rule are written twice for speed; they must agree on every row.
      const single = await owner<{ id: string; ranked: boolean }>(
        "SELECT e.id, ranking_eligible(e) AS ranked FROM enrollment e WHERE e.event_id = $1 AND e.score > 0 ORDER BY ranked",
        [event],
      );
      expect(single.map((row) => [row.id, row.ranked]).toSorted()).toEqual(
        flags.map((row) => [row.enrollment_id, row.ranked]).toSorted(),
      );
    });

    it("ranks a team member of another organizer", async () => {
      const event = await newEvent();
      const staff = await addMember(db.owner, ids.orgB, "editor");
      const [member] = await owner<{ email: string }>(
        "SELECT email FROM staff_user WHERE id = $1",
        [staff],
      );
      const guest = await newPlayer(event, member?.email);
      await complete(guest.player, await newQuest(event, 3));
      expect(await topIds(event, guest.player)).toEqual([guest.enrollment]);
    });
  });

  describe("who may read", () => {
    it("flags the requested rows of this event, names only ranked ones, and refuses anyone not playing it", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 4);
      const a = await newPlayer(event);
      const b = await newPlayer(event);
      await complete(a.player, quest);
      const other = await newEvent();
      const c = await newPlayer(other);
      await complete(c.player, await newQuest(other, 4));
      const rows = await as<{ enrollment_id: string; username: string | null; ranked: boolean }>(
        { playerId: b.player },
        "SELECT * FROM ranking_rows($1, $2) ORDER BY ranked DESC",
        [event, [a.enrollment, b.enrollment, c.enrollment]],
      );
      expect(rows).toEqual([
        {
          enrollment_id: a.enrollment,
          username: expect.stringMatching(/^ranker_/),
          avatar: "falcon",
          equipment: { character: null, frame: null, title: null },
          ranked: true,
        },
        {
          enrollment_id: b.enrollment,
          username: null,
          avatar: null,
          equipment: null,
          ranked: false,
        },
      ]);
      await expect(
        as({ playerId: c.player }, "SELECT * FROM ranking_rows($1, $2)", [event, [a.enrollment]]),
      ).rejects.toMatchObject({ code: "QR403" });
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [b.enrollment]);
      expect(await top(event, b.player)).toEqual([]);
      await expect(
        as({ playerId: b.player }, "SELECT * FROM ranking_rows($1, $2)", [event, [a.enrollment]]),
      ).rejects.toMatchObject({ code: "QR403" });
    });

    it("tells only the owner of a completion where it left them", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      const b = await newPlayer(event);
      const completion = await complete(a.player, await newQuest(event, 6));
      expect(
        await as({ playerId: a.player }, "SELECT * FROM ranking_entry_of($1)", [completion]),
      ).toEqual([
        {
          event_id: event,
          enrollment_id: a.enrollment,
          score: "6",
          score_version: expect.any(String),
          ranked: true,
        },
      ]);
      expect(
        await as({ playerId: b.player }, "SELECT * FROM ranking_entry_of($1)", [completion]),
      ).toEqual([]);
      expect(await as({}, "SELECT * FROM ranking_entry_of($1)", [completion])).toEqual([]);
    });

    it("lists entries and claims repairs only in the system's own context", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      await complete(a.player, await newQuest(event, 2));
      await as({}, "SELECT mark_ranking_repair($1)", [event]);
      for (const context of [
        { playerId: a.player },
        { organizerId: ids.orgA, staffUserId: await addMember(db.owner, ids.orgA) },
        { isAdmin: true },
      ] satisfies RequestContext[]) {
        expect(await as(context, "SELECT * FROM ranking_entries($1)", [event])).toEqual([]);
        expect(await as(context, "SELECT * FROM claim_ranking_repairs(100)")).toEqual([]);
        expect(await as(context, "SELECT * FROM live_ranking_events()")).toEqual([]);
      }
      expect(await marked(event)).toBe(true);
    });

    it("lets only the system or a player of the event mark it for repair", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      const stranger = await newPlayer(await newEvent());
      await clearMarks();
      await as({ playerId: stranger.player }, "SELECT mark_ranking_repair($1)", [event]);
      expect(await marked(event)).toBe(false);
      await as({ playerId: a.player }, "SELECT mark_ranking_repair($1)", [event]);
      expect(await marked(event)).toBe(true);
    });
  });

  describe("repair marks", () => {
    it("are claimed once, oldest first, and removed as they are claimed", async () => {
      await clearMarks();
      const [first, second] = [await newEvent(), await newEvent()];
      await as({}, "SELECT mark_ranking_repair($1)", [first]);
      await as({}, "SELECT mark_ranking_repair($1)", [second]);
      await as({}, "SELECT mark_ranking_repair($1)", [randomUUID()]);
      const claimed = await as<{ claim_ranking_repairs: string }>(
        {},
        "SELECT * FROM claim_ranking_repairs(1)",
      );
      expect(claimed).toEqual([{ claim_ranking_repairs: first }]);
      expect(await marked(first)).toBe(false);
      expect(await marked(second)).toBe(true);
      expect(await as({}, "SELECT * FROM claim_ranking_repairs(10)")).toHaveLength(1);
    });

    it("follow every change that can move someone with points in or out", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      await complete(a.player, await newQuest(event, 8));
      const changes = [
        () => owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [a.enrollment]),
        () => owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [a.enrollment]),
        () => owner("UPDATE player SET status = 'banned' WHERE id = $1", [a.player]),
        () => owner("UPDATE player SET status = 'active' WHERE id = $1", [a.player]),
        () =>
          owner("UPDATE player_contact SET email = $2 WHERE player_id = $1", [
            a.player,
            `moved${counter}@najd.sa`,
          ]),
        () => addMember(db.owner, ids.orgA, "editor"),
        () =>
          owner("DELETE FROM organizer_member WHERE role = 'editor' AND organizer_id = $1", [
            ids.orgA,
          ]),
      ];
      for (const change of changes) {
        await clearMarks();
        await change();
        expect(await marked(event)).toBe(true);
      }
    });

    it("leave nothing for changes that cannot move a rank", async () => {
      const event = await newEvent();
      const idle = await newPlayer(event);
      await clearMarks();
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [idle.enrollment]);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [idle.player]);
      await owner("UPDATE player_contact SET email = $2 WHERE player_id = $1", [
        idle.player,
        `idle${counter}@najd.sa`,
      ]);
      expect(await marked(event)).toBe(false);
      const a = await newPlayer(event);
      await complete(a.player, await newQuest(event, 1));
      await clearMarks();
      await owner("UPDATE player_contact SET email = email WHERE player_id = $1", [a.player]);
      expect(await marked(event)).toBe(false);
    });

    it("list live events for the backstop rebuild", async () => {
      const event = await newEvent();
      const live = await as<{ live_ranking_events: string }>(
        {},
        "SELECT * FROM live_ranking_events()",
      );
      expect(live.map((row) => row.live_ranking_events)).toContain(event);
      await owner("UPDATE event SET status = 'ended' WHERE id = $1", [event]);
      const after = await as<{ live_ranking_events: string }>(
        {},
        "SELECT * FROM live_ranking_events()",
      );
      expect(after.map((row) => row.live_ranking_events)).not.toContain(event);
    });
  });

  describe("closed by default", () => {
    it("closes the repair table and the helpers to the API's role and everything to outsiders", async () => {
      await expect(db.app.query("SELECT * FROM ranking_repair")).rejects.toThrow(
        /permission denied/,
      );
      for (const fn of [
        "ranking_system()",
        "ranking_reader_enrollment(gen_random_uuid())",
        "ranking_eligible(NULL::enrollment)",
      ]) {
        await expect(db.app.query(`SELECT public.${fn}`)).rejects.toThrow(/permission denied/);
      }
      for (const fn of [
        "ranking_entries(gen_random_uuid())",
        "ranking_entry_of(1)",
        "ranking_rows(gen_random_uuid(), '{}')",
        "ranking_top(gen_random_uuid(), 10)",
        "ranking_position(gen_random_uuid())",
        "mark_ranking_repair(gen_random_uuid())",
        "claim_ranking_repairs(1)",
        "live_ranking_events()",
      ]) {
        await expect(db.outsider.query(`SELECT public.${fn}`)).rejects.toThrow(/permission denied/);
      }
    });
  });
});
