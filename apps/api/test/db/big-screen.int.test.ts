import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
type Pending = Readonly<{ secret: Buffer; code: Buffer }>;
type Plan = Readonly<{ scenes: string[]; offered: string[]; enabled: boolean }>;
type Ranking = Readonly<{
  shut: string | null;
  rows?: readonly Readonly<{ place: number; username: string; avatar: string; score: number }>[];
}>;
type Community = Readonly<{ shut: string | null; goal?: Row | null }>;
type PollScene = Readonly<{ shut: string | null; poll?: Row | null }>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const detail =
      pg.detail === undefined || pg.detail === "" || /^[0-9]/.test(pg.code ?? "")
        ? ""
        : `:${pg.detail}`;
    return `${pg.code}${detail}`;
  }
};
const as = (player: string): RequestContext => ({ playerId: player });
const hash = (): Buffer => randomBytes(32);
const usernames = (ranking: Ranking) => (ranking.rows ?? []).map((row) => row.username);
const text = (en: string) => ({ en });
const OPTIONS = [
  { id: "a", text: text("Robots") },
  { id: "b", text: text("Space") },
  { id: "c", text: text("Oceans") },
];
const livePoll = (results: "after_vote" | "at_close" | "never") => ({
  options: OPTIONS,
  live: { choices: "one", results, minutes: 5 },
});

/**
 * The big screen's scenes in the database (T-504, migration 0083, ADR-365): the picked list and its refusals, the
 * screen's own view, the ranking scene (the board's rule, the ten), the community scene (the cached progress, no reward),
 * the poll scene (the results policy as a table, who may be shown) and what a device of another kind, a revoked one or an
 * outsider can read.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("big screen (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
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
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });

  /** A live event of organizer A with the big-screen add-on unlocked (unless `addon` is false). */
  const newEvent = async (fields: Readonly<{ status?: string; addon?: boolean }> = {}) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Screen Fest', $3, now() - interval '2 hours', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `BSC${counter}`, fields.status ?? "live"],
    );
    if (fields.addon !== false) {
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event?.id, ids.orgA],
      );
    }
    return event?.id ?? "";
  };
  const setFeature = (event: string, feature: string, enabled: boolean) =>
    owner(
      `UPDATE event SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{features}',
                                           coalesce(config -> 'features', '{}'::jsonb) || $2::jsonb) WHERE id = $1`,
      [event, JSON.stringify({ [feature]: enabled })],
    );
  const newPlayer = async (event: string, points = 0, email?: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, avatar) VALUES ($1, 'fox') RETURNING id",
      [`bs_player_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      email ?? `bs${counter}@najd.sa`,
    ]);
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id`,
      [ids.orgA, event, player?.id],
    );
    if (points > 0) {
      await award(event, made?.id ?? "", points);
    }
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const award = (event: string, enrollment: string, points: number) =>
    owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id)
       VALUES ($1, $2, $3, 'award', $4, $4, 'staff', $5)`,
      [ids.orgA, event, enrollment, points, ownerA],
    );
  const openRequest = async (kind: string): Promise<Pending> => {
    const pending = { secret: hash(), code: hash() };
    await query({}, "SELECT * FROM open_device_request($1, $2, $3, 'Chrome on Android')", [
      pending.secret,
      pending.code,
      kind,
    ]);
    return pending;
  };
  /** A device of `kind` paired by the team for the event and activated: its id. */
  const device = async (event: string, kind = "screen", quest: string | null = null) => {
    const pending = await openRequest(kind);
    const [claimed] = await query<{ id: string }>(
      teamA(),
      "SELECT team_claim_device($1, $2, $3, $4, 'Hall TV', $5) AS id",
      [pending.code, event, kind, quest, randomUUID()],
    );
    await query({}, "SELECT activate_device($1, $2)", [pending.secret, hash()]);
    return claimed?.id ?? "";
  };
  const read = async <T>(deviceId: string, fn: string): Promise<T> =>
    (await query<{ r: T }>({ deviceId }, `SELECT ${fn}() AS r`))[0]?.r as T;
  const plan = async (event: string, team = teamA()) =>
    (await query<{ r: Plan }>(team, "SELECT event_big_screen($1) AS r", [event]))[0]?.r as Plan;
  const save = async (event: string, scenes: string[] | null, team = teamA()) =>
    (
      await query<{ r: Plan }>(team, "SELECT set_big_screen($1, $2, $3) AS r", [
        event,
        scenes,
        randomUUID(),
      ])
    )[0]?.r as Plan;
  const goal = async (event: string, fields: Row = {}) => {
    const [made] = await owner<{ id: string }>(
      `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status,
                                   settled_until, progress, final_at)
       VALUES ($1, $2, 'Light the tower', 'points', 100, now() - interval '1 hour', now() + interval '1 hour', $3,
               now(), $4, $5) RETURNING id`,
      [
        ids.orgA,
        event,
        fields["status"] ?? "running",
        fields["progress"] ?? 40,
        fields["finalAt"] ?? null,
      ],
    );
    return made?.id ?? "";
  };
  const step = async (event: string, goalId: string, threshold: number, isGoal: boolean) => {
    const [made] = await owner<{ id: string }>(
      `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points)
       VALUES ($1, $2, $3, $4, 'points', 25) RETURNING id`,
      [event, goalId, threshold, isGoal],
    );
    return made?.id ?? "";
  };

  const category = async (event: string, rules: Row = {}) => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Polls') RETURNING id",
      [event],
    );
    for (const [column, value] of Object.entries(rules)) {
      await owner(`UPDATE category SET ${column} = $2 WHERE id = $1`, [made?.id, value]);
    }
    return made?.id ?? "";
  };
  /** A sent poll opened a minute ago, closing in `closesIn` minutes (negative: closed that long ago). */
  const poll = async (
    event: string,
    results: "after_vote" | "at_close" | "never",
    fields: Readonly<{
      category?: string;
      closesIn?: number;
      sent?: boolean;
      live?: boolean;
    }> = {},
  ) => {
    const config = fields.live === false ? { options: OPTIONS } : livePoll(results);
    const sent = fields.sent !== false && fields.live !== false;
    const [made] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, visible)
       VALUES ($1, $2, 'vote', 'Pick one', 10, $3, $4) RETURNING id`,
      [
        event,
        fields.category ?? (await category(event)),
        JSON.stringify(config),
        fields.live === false,
      ],
    );
    if (sent) {
      await query(teamA(), "SELECT * FROM send_poll($1, $2, $3)", [event, made?.id, randomUUID()]);
    }
    return made?.id ?? "";
  };
  const vote = async (event: string, quest: string, option: string) => {
    const who = await newPlayer(event);
    await query(as(who.player), "SELECT * FROM vote_quest($1, $2, $3)", [
      quest,
      [option],
      randomUUID(),
    ]);
  };
  const move = (quest: string, openedAgo: number, closesIn: number) =>
    owner(
      `UPDATE quest SET opens_at = now() - $2::int * interval '1 minute',
                        closes_at = now() + $3::int * interval '1 minute' WHERE id = $1`,
      [quest, openedAgo, closesIn],
    );
  const pollOf = async (screen: string) =>
    (await read<PollScene>(screen, "screen_poll")).poll as Row | null;

  describe("the picked scenes (FR-631, FR-1612)", () => {
    it("starts as every scene in order, and saves a pick in the order given", async () => {
      const event = await newEvent();
      expect(await plan(event)).toEqual({
        scenes: ["ranking", "community", "poll"],
        offered: ["ranking", "community", "poll"],
        enabled: true,
      });
      expect((await save(event, ["poll", "ranking"])).scenes).toEqual(["poll", "ranking"]);
      expect((await save(event, ["community"])).scenes).toEqual(["community"]);
      expect((await plan(event)).scenes).toEqual(["community"]);
      expect(await owner("SELECT scenes FROM big_screen WHERE event_id = $1", [event])).toEqual([
        { scenes: ["community"] },
      ]);
    });

    it("may be empty, and audits the scene names only", async () => {
      const event = await newEvent();
      await save(event, ["ranking", "poll"]);
      expect((await save(event, [])).scenes).toEqual([]);
      const audit = await owner<{ before: Row; after: Row; actor_id: string }>(
        `SELECT before, after, actor_id FROM audit_log WHERE action = 'big_screen.update' AND event_id = $1
         ORDER BY id DESC LIMIT 1`,
        [event],
      );
      expect(audit[0]).toEqual({
        before: { scenes: ["ranking", "poll"] },
        after: { scenes: [] },
        actor_id: ownerA,
      });
    });

    it.each([
      ["an unknown scene", ["photos"], "BS422:scenes"],
      ["a repeated scene", ["poll", "poll"], "BS422:scenes"],
      ["four scenes", ["ranking", "community", "poll", "ranking"], "BS422:scenes"],
      ["no list", null, "BS422:scenes"],
    ])("refuses %s", async (_name, scenes, expected) => {
      const event = await newEvent();
      expect(await refusal(save(event, scenes as string[] | null))).toBe(expected);
      expect(await owner("SELECT 1 FROM big_screen WHERE event_id = $1", [event])).toEqual([]);
    });

    it("does not offer the ranking while the event's ranking is off, and refuses to save it", async () => {
      const event = await newEvent();
      await save(event, ["ranking", "poll"]);
      await setFeature(event, "ranking", false);
      expect(await plan(event)).toEqual({
        scenes: ["poll"],
        offered: ["community", "poll"],
        enabled: true,
      });
      expect(await refusal(save(event, ["ranking"]))).toBe("BS422:ranking_off");
      expect((await save(event, ["poll", "community"])).scenes).toEqual(["poll", "community"]);
      await setFeature(event, "ranking", true);
      expect((await plan(event)).offered).toEqual(["ranking", "community", "poll"]);
    });

    it("does not offer the ranking while the platform's ranking switch is off", async () => {
      const event = await newEvent();
      await owner(
        `INSERT INTO platform_setting (key, value) VALUES ('features', '{"ranking":{"enabled":false}}')
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      );
      try {
        expect((await plan(event)).offered).toEqual(["community", "poll"]);
        expect(await refusal(save(event, ["ranking"]))).toBe("BS422:ranking_off");
      } finally {
        await owner("DELETE FROM platform_setting WHERE key = 'features'");
      }
    });

    it("refuses a save while the add-on is not active, and says so on the page", async () => {
      const event = await newEvent({ addon: false });
      expect((await plan(event)).enabled).toBe(false);
      expect(await refusal(save(event, ["poll"]))).toBe("BS403");
    });

    it("answers another organizer's event, an unknown one and no team at all as not found", async () => {
      const event = await newEvent();
      for (const context of [teamB(), {} as RequestContext]) {
        expect(await refusal(plan(event, context))).toBe("AN404");
        expect(await refusal(save(event, ["poll"], context))).toBe("AN404");
      }
      expect(await refusal(plan(randomUUID()))).toBe("AN404");
      expect(await owner("SELECT 1 FROM big_screen WHERE event_id = $1", [event])).toEqual([]);
    });

    it("is kept with its event's setup and goes with the event", async () => {
      const event = await newEvent();
      await save(event, ["poll"]);
      await owner("DELETE FROM event WHERE id = $1", [event]);
      expect(await owner("SELECT 1 FROM big_screen WHERE event_id = $1", [event])).toEqual([]);
    });
  });

  describe("the screen's own view", () => {
    it("carries the running scenes, and shuts with feature_off or event_ended", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await save(event, ["poll", "ranking"]);
      expect(await read<Row>(screen, "device_view")).toMatchObject({
        kind: "screen",
        shut: null,
        scenes: ["poll", "ranking"],
      });
      await setFeature(event, "ranking", false);
      expect((await read<Row>(screen, "device_view"))["scenes"]).toEqual(["poll"]);
      await owner(
        "UPDATE event SET status = 'ended', starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE id = $1",
        [event],
      );
      expect(await read<Row>(screen, "device_view")).toMatchObject({
        shut: "event_ended",
        scenes: null,
      });
      const bare = await device(await newEvent({ addon: false }));
      expect(await read<Row>(bare, "device_view")).toMatchObject({
        shut: "feature_off",
        scenes: null,
      });
    });

    it("carries the event's own words to a big screen only (FR-942)", async () => {
      const event = await newEvent();
      const screen = await device(event);
      expect((await read<Row>(screen, "device_view"))["terms"]).toBeNull();
      const terms = {
        currency: {
          icon: "gem",
          ar: { one: "جوهرة", many: "جواهر" },
          en: { one: "gem", many: "gems" },
        },
      };
      await owner(
        `UPDATE event SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{terms}', $2::jsonb) WHERE id = $1`,
        [event, JSON.stringify(terms)],
      );
      expect((await read<Row>(screen, "device_view"))["terms"]).toEqual(terms);
    });

    it("gives a station no scenes and no words", async () => {
      const event = await newEvent();
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         SELECT $1, c.id, 'scan_qr', 'Gate', 10, ARRAY['screen_qr'] FROM category c WHERE c.event_id = $1 LIMIT 1
         RETURNING id`,
        [event],
      );
      const station = await device(event, "station", quest?.id ?? null);
      expect(await read<Row>(station, "device_view")).toMatchObject({ scenes: null, terms: null });
    });
  });

  describe("the ranking scene (FR-632)", () => {
    it("shows the ten best in the board's order, with a username, an avatar and points only", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const players = [];
      for (let points = 1; points <= 12; points += 1) {
        players.push(await newPlayer(event, points * 10));
      }
      await newPlayer(event, 120);
      const ranking = await read<Ranking>(screen, "screen_ranking");
      expect(ranking.rows).toHaveLength(10);
      expect(ranking.rows?.map((row) => row.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(ranking.rows?.map((row) => row.score)).toEqual([
        120, 120, 110, 100, 90, 80, 70, 60, 50, 40,
      ]);
      // The tie goes to who reached the points first (the board's rule), not to the later player.
      expect(ranking.rows?.[0]?.username).toBe(
        (
          await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [
            players[11]?.player,
          ])
        )[0]?.username,
      );
      expect(ranking.rows?.[1]?.username).not.toBe(ranking.rows?.[0]?.username);
      expect(Object.keys(ranking.rows?.[0] ?? {}).toSorted()).toEqual([
        "avatar",
        "place",
        "score",
        "username",
      ]);
      expect(ranking.rows?.[0]?.avatar).toBe("fox");
    });

    it("follows a score at once and never shows a banned, removed, excluded or unscored player", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const a = await newPlayer(event, 50);
      const b = await newPlayer(event, 40);
      const banned = await newPlayer(event, 90);
      const removed = await newPlayer(event, 80);
      const account = await newPlayer(event, 70);
      const [member] = await owner<{ email: string }>(
        "SELECT email FROM staff_user WHERE id = $1",
        [await addMember(db.owner, ids.orgA, "editor")],
      );
      await newPlayer(event, 60, member?.email);
      await newPlayer(event, 0);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [removed.enrollment]);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [account.player]);
      const names = async () => usernames(await read<Ranking>(screen, "screen_ranking"));
      const nameOf = async (player: string) =>
        (
          await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [player])
        )[0]?.username;
      expect(await names()).toEqual([await nameOf(a.player), await nameOf(b.player)]);
      await award(event, b.enrollment, 100);
      expect(await names()).toEqual([await nameOf(b.player), await nameOf(a.player)]);
    });

    it("reads its own event only", async () => {
      const first = await newEvent();
      const second = await newEvent();
      await newPlayer(first, 10);
      await newPlayer(second, 500);
      const ranking = await read<Ranking>(await device(first), "screen_ranking");
      expect(ranking.rows).toHaveLength(1);
      expect((await read<Ranking>(await device(second), "screen_ranking")).rows?.[0]?.score).toBe(
        500,
      );
    });

    it("answers shut when the ranking or the add-on is off or the event is over, and is empty before any score", async () => {
      const event = await newEvent();
      const screen = await device(event);
      expect(await read<Ranking>(screen, "screen_ranking")).toEqual({ shut: null, rows: [] });
      await newPlayer(event, 10);
      await setFeature(event, "ranking", false);
      expect(await read<Ranking>(screen, "screen_ranking")).toEqual({ shut: "ranking_off" });
      await setFeature(event, "ranking", true);
      await owner("DELETE FROM event_entitlement WHERE event_id = $1", [event]);
      expect(await read<Ranking>(screen, "screen_ranking")).toEqual({ shut: "feature_off" });
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event, ids.orgA],
      );
      await owner(
        "UPDATE event SET status = 'ended', starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE id = $1",
        [event],
      );
      expect(await read<Ranking>(screen, "screen_ranking")).toEqual({ shut: "event_ended" });
    });
  });

  describe("the community scene (FR-633)", () => {
    it("shows the running goal's progress and milestones, and no reward or player", async () => {
      const event = await newEvent();
      const screen = await device(event);
      expect(await read<Community>(screen, "screen_community")).toEqual({ shut: null, goal: null });
      const running = await goal(event);
      const first = await step(event, running, 25, false);
      await step(event, running, 100, true);
      await owner(
        "INSERT INTO community_reach (step_id, event_id, reached_at, progress) VALUES ($1, $2, now(), 30)",
        [first, event],
      );
      const scene = await read<Community>(screen, "screen_community");
      expect(scene.goal).toEqual({
        title: { ar: null, en: "Light the tower" },
        measure: "points",
        target: 100,
        progress: 40,
        status: "running",
        endsAt: expect.any(String),
        steps: [
          { threshold: 25, isGoal: false, reached: true },
          { threshold: 100, isGoal: true, reached: false },
        ],
      });
      await owner("UPDATE community_goal SET progress = 100, status = 'reached' WHERE id = $1", [
        running,
      ]);
      expect((await read<Community>(screen, "screen_community")).goal).toMatchObject({
        status: "reached",
        progress: 100,
      });
    });

    it("keeps a finished goal for 30 minutes, hides one not yet settled, and obeys the switches", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const finished = await goal(event, {
        status: "reached",
        progress: 100,
        finalAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      });
      expect((await read<Community>(screen, "screen_community")).goal).toBeNull();
      await owner(
        "UPDATE community_goal SET final_at = now() - interval '5 minutes' WHERE id = $1",
        [finished],
      );
      expect((await read<Community>(screen, "screen_community")).goal).not.toBeNull();
      await owner("UPDATE community_goal SET settled_until = NULL WHERE id = $1", [finished]);
      expect((await read<Community>(screen, "screen_community")).goal).toBeNull();
      await owner("UPDATE community_goal SET settled_until = now() WHERE id = $1", [finished]);
      await setFeature(event, "community", false);
      expect((await read<Community>(screen, "screen_community")).goal).toBeNull();
    });

    it("never shows another event's goal", async () => {
      const mine = await newEvent();
      await goal(await newEvent());
      expect(await read<Community>(await device(mine), "screen_community")).toEqual({
        shut: null,
        goal: null,
      });
    });
  });

  describe("the poll scene (FR-634, FR-1613)", () => {
    it("applies the results policy: live, at close, never", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const live = await poll(event, "after_vote");
      await vote(event, live, "a");
      await vote(event, live, "a");
      await vote(event, live, "c");
      expect(await pollOf(screen)).toEqual({
        title: { ar: null, en: "Pick one" },
        closesAt: expect.any(String),
        closed: false,
        voters: 3,
        options: [
          { text: text("Robots"), votes: 2 },
          { text: text("Space"), votes: 0 },
          { text: text("Oceans"), votes: 1 },
        ],
      });

      const later = await newEvent();
      const laterScreen = await device(later);
      const atClose = await poll(later, "at_close");
      await vote(later, atClose, "b");
      expect(await pollOf(laterScreen)).toMatchObject({ closed: false, voters: 1, options: null });
      await query(teamA(), "SELECT * FROM close_poll($1, $2, $3)", [later, atClose, randomUUID()]);
      expect(await pollOf(laterScreen)).toMatchObject({
        closed: true,
        voters: 1,
        options: [
          { text: text("Robots"), votes: 0 },
          { text: text("Space"), votes: 1 },
          { text: text("Oceans"), votes: 0 },
        ],
      });

      const never = await newEvent();
      const neverScreen = await device(never);
      const hidden = await poll(never, "never");
      await vote(never, hidden, "a");
      await vote(never, hidden, "b");
      expect(await pollOf(neverScreen)).toMatchObject({ voters: 2, options: null });
      await query(teamA(), "SELECT * FROM close_poll($1, $2, $3)", [never, hidden, randomUUID()]);
      expect(await pollOf(neverScreen)).toMatchObject({ closed: true, voters: 2, options: null });
    });

    it("keeps a closed poll for 15 minutes, prefers an open one, and then the newest", async () => {
      const event = await newEvent();
      const screen = await device(event);
      expect(await pollOf(screen)).toBeNull();
      const old = await poll(event, "after_vote");
      await move(old, 40, -20);
      expect(await pollOf(screen)).toBeNull();
      await move(old, 40, -10);
      expect(await pollOf(screen)).toMatchObject({ closed: true });
      const open = await poll(event, "after_vote");
      await owner("UPDATE quest SET title_en = 'Open one' WHERE id = $1", [open]);
      expect(await pollOf(screen)).toMatchObject({ title: { en: "Open one" }, closed: false });
      const newest = await poll(event, "after_vote");
      await owner("UPDATE quest SET title_en = 'Newest' WHERE id = $1", [newest]);
      await move(open, 3, 5);
      await move(newest, 1, 5);
      expect(await pollOf(screen)).toMatchObject({ title: { en: "Newest" } });
    });

    it("shows no poll that was not sent, that is not a live poll, or that not everyone may see", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await poll(event, "after_vote", { sent: false });
      await poll(event, "after_vote", { live: false });
      await poll(event, "after_vote", { category: await category(event, { hidden: true }) });
      await poll(event, "after_vote", {
        category: await category(event, { audience_kind: "tag", audience_values: ["vip"] }),
      });
      expect(await pollOf(screen)).toBeNull();
      const visible = await poll(event, "after_vote");
      expect(visible).not.toBe("");
      expect(await pollOf(screen)).not.toBeNull();
    });

    it("shows no poll that a community goal still holds shut", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const held = await poll(event, "after_vote");
      const [goalRow] = await owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status)
         VALUES ($1, $2, 'Unlock', 'points', 100, now() + interval '1 hour', now() + interval '2 hours', 'scheduled')
         RETURNING id`,
        [ids.orgA, event],
      );
      await owner(
        `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, unlock_quest_id)
         VALUES ($1, $2, 100, true, 'unlock', $3)`,
        [event, goalRow?.id, held],
      );
      expect(await pollOf(screen)).toBeNull();
    });

    it("answers empty while polls are off, and shut without the add-on", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await poll(event, "after_vote");
      expect(await pollOf(screen)).not.toBeNull();
      await setFeature(event, "polls", false);
      expect(await read<PollScene>(screen, "screen_poll")).toEqual({ shut: null, poll: null });
      const bare = await newEvent({ addon: false });
      expect(await read<PollScene>(await device(bare), "screen_poll")).toEqual({
        shut: "feature_off",
      });
    });
  });

  describe("who may read a scene", () => {
    it.each(["screen_ranking", "screen_community", "screen_poll"])(
      "%s refuses a station, a revoked device, an unknown one and a request with no device",
      async (fn) => {
        const event = await newEvent();
        const [quest] = await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
           SELECT $1, c.id, 'scan_qr', 'Gate', 10, ARRAY['screen_qr', 'kiosk'] FROM category c
           WHERE c.event_id = $1 LIMIT 1 RETURNING id`,
          [event],
        );
        const station = await device(event, "station", quest?.id ?? null);
        expect(await refusal(read(station, fn))).toBe("DV401");
        const screen = await device(event);
        await query(teamA(), "SELECT revoke_device($1, $2, $3)", [event, screen, randomUUID()]);
        expect(await refusal(read(screen, fn))).toBe("DV401");
        expect(await refusal(query({}, `SELECT ${fn}()`))).toBe("DV401");
        expect(await refusal(read(randomUUID(), fn))).toBe("DV401");
      },
    );

    it("lets a team member, a player or an unactivated device read nothing through the screen doors", async () => {
      const event = await newEvent();
      const pending = await openRequest("screen");
      const [claimed] = await query<{ id: string }>(
        teamA(),
        "SELECT team_claim_device($1, $2, 'screen', NULL, 'Not yet', $3) AS id",
        [pending.code, event, randomUUID()],
      );
      for (const fn of ["screen_ranking", "screen_community", "screen_poll"]) {
        expect(await refusal(read(claimed?.id ?? "", fn))).toBe("DV401");
        expect(await refusal(query(teamA(), `SELECT ${fn}()`))).toBe("DV401");
        expect(await refusal(query(as(ids.playerA), `SELECT ${fn}()`))).toBe("DV401");
      }
    });
  });
});
