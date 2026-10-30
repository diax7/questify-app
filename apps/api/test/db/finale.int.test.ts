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
type Reading = Readonly<{
  enabled: boolean;
  endsAt: string | null;
  state: string;
  finale: Readonly<{
    startsAt: string;
    started: boolean;
    goalId: string | null;
    goal: Row | null;
  }> | null;
}>;
type Scene = Readonly<{ shut: string | null; finale?: Row | null }>;

const HOUR = 3_600_000;
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
const hash = (): Buffer => randomBytes(32);
const inHours = (hours: number): Date => new Date(Date.now() + hours * HOUR);

/**
 * The live finale in the database (T-307b, migration 0084, ADR-369): who sets and clears it and every refusal, the screen's
 * running list (the finale last, alone from its time on, open after the end), the finale scene's phases (countdown with
 * nothing of the goal, push with the goal's cached progress and no reward, waiting, and the winners only once the owner's
 * reveal ran), and what a station, a revoked device or an outsider can read.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("live finale (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let editorA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    editorA = await addMember(db.owner, ids.orgA, "editor");
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
  const team = (staff = ownerA, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: staff,
  });

  /** A live event of organizer A with the big-screen add-on (unless `addon` is false), two hours in, a day to go. */
  const newEvent = async (fields: Readonly<{ addon?: boolean }> = {}) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Finale Fest', 'live', now() - interval '2 hours', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `FIN${counter}`],
    );
    if (fields.addon !== false) {
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event?.id, ids.orgA],
      );
    }
    return event?.id ?? "";
  };
  const end = (event: string) =>
    owner(
      "UPDATE event SET status = 'ended', starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE id = $1",
      [event],
    );
  const newPlayer = async (event: string, points: number) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, avatar) VALUES ($1, 'fox') RETURNING id",
      [`fin_player_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `fin${counter}@najd.sa`,
    ]);
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, event, player?.id],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id)
       VALUES ($1, $2, $3, 'award', $4, $4, 'staff', $5)`,
      [ids.orgA, event, made?.id, points, ownerA],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const goal = async (event: string, fields: Row = {}) => {
    const [made] = await owner<{ id: string }>(
      `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status,
                                   settled_until, progress, final_at)
       VALUES ($1, $2, 'Light the tower', 'points', 100, now() - interval '1 hour', $6, $3, now(), $4, $5)
       RETURNING id`,
      [
        ids.orgA,
        event,
        fields["status"] ?? "running",
        fields["progress"] ?? 40,
        fields["finalAt"] ?? null,
        fields["endsAt"] ?? inHours(2),
      ],
    );
    await owner(
      `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points)
       VALUES ($1, $2, 50, false, 'points', 10), ($1, $2, 100, true, 'points', 25)`,
      [event, made?.id],
    );
    return made?.id ?? "";
  };

  const openRequest = async (kind: string): Promise<Pending> => {
    const pending = { secret: hash(), code: hash() };
    await query({}, "SELECT * FROM open_device_request($1, $2, $3, 'Chrome on Android')", [
      pending.secret,
      pending.code,
      kind,
    ]);
    return pending;
  };
  const device = async (event: string, kind = "screen", quest: string | null = null) => {
    const pending = await openRequest(kind);
    const [claimed] = await query<{ id: string }>(
      team(),
      "SELECT team_claim_device($1, $2, $3, $4, 'Hall TV', $5) AS id",
      [pending.code, event, kind, quest, randomUUID()],
    );
    await query({}, "SELECT activate_device($1, $2)", [pending.secret, hash()]);
    return claimed?.id ?? "";
  };
  const read = async <T>(deviceId: string, fn: string): Promise<T> =>
    (await query<{ r: T }>({ deviceId }, `SELECT ${fn}() AS r`))[0]?.r as T;
  const scene = (screen: string) => read<Scene>(screen, "screen_finale");
  const finaleOf = async (screen: string) => (await scene(screen)).finale as Row | null;
  const view = (screen: string) => read<Row>(screen, "device_view");

  const reading = async (event: string, context = team()) =>
    (await query<{ r: Reading }>(context, "SELECT event_finale($1) AS r", [event]))[0]
      ?.r as Reading;
  const set = async (
    event: string,
    startsAt: Date | null,
    goalId: string | null = null,
    context = team(),
  ) =>
    (
      await query<{ r: Reading }>(context, "SELECT set_finale($1, $2, $3, $4) AS r", [
        event,
        startsAt,
        goalId,
        randomUUID(),
      ])
    )[0]?.r as Reading;
  const clear = async (event: string, context = team()) =>
    (
      await query<{ r: Reading }>(context, "SELECT clear_finale($1, $2) AS r", [
        event,
        randomUUID(),
      ])
    )[0]?.r as Reading;
  const startNow = (event: string) =>
    owner("UPDATE finale SET starts_at = now() - interval '1 minute' WHERE event_id = $1", [event]);
  const places = async (event: string) =>
    (
      await query<{ enrollment_id: string }>(team(), "SELECT * FROM results_places($1)", [event])
    ).map((place) => place.enrollment_id);
  const confirmAndReveal = async (event: string, reveal = true) => {
    await end(event);
    await query(team(), "SELECT confirm_results($1, $2, $3)", [
      event,
      await places(event),
      randomUUID(),
    ]);
    if (reveal) {
      await query(team(), "SELECT reveal_results($1, $2, $3)", [event, inHours(24), randomUUID()]);
    }
  };

  describe("setting and clearing it (FR-254)", () => {
    it("sets the time and the goal, replaces them before the time, and audits ids and the time only", async () => {
      const event = await newEvent();
      expect((await reading(event)).finale).toBeNull();
      const pushGoal = await goal(event);
      const first = inHours(1);
      const saved = await set(event, first, pushGoal);
      expect(saved).toMatchObject({ enabled: true, state: "not_ended" });
      expect(saved.finale).toMatchObject({ started: false, goalId: pushGoal });
      expect(saved.finale?.goal).toMatchObject({
        title: { en: "Light the tower" },
        status: "running",
      });
      expect(new Date(saved.finale?.startsAt ?? "").getTime()).toBe(first.getTime());
      const later = inHours(3);
      expect((await set(event, later, null)).finale).toMatchObject({ goalId: null, goal: null });
      const audit = await owner<{
        action: string;
        before: Row | null;
        after: Row;
        actor_id: string;
      }>(
        `SELECT action, before, after, actor_id FROM audit_log
         WHERE event_id = $1 AND action = 'finale.update' ORDER BY id`,
        [event],
      );
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        before: null,
        after: { goalId: pushGoal },
        actor_id: ownerA,
      });
      expect(audit[1]?.before).toMatchObject({ goalId: pushGoal });
      expect(audit[1]?.after).toMatchObject({ goalId: null });
    });

    it("clears it, audits that once, and changes nothing when there is none", async () => {
      const event = await newEvent();
      await set(event, inHours(1));
      expect((await clear(event)).finale).toBeNull();
      expect((await clear(event)).finale).toBeNull();
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
      const audit = await owner(
        "SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'finale.clear'",
        [event],
      );
      expect(audit).toHaveLength(1);
    });

    it("reads the results state beside it: open once ended, confirmed, then revealed", async () => {
      const event = await newEvent();
      await newPlayer(event, 50);
      await set(event, inHours(1));
      expect((await reading(event)).state).toBe("not_ended");
      await end(event);
      expect((await reading(event)).state).toBe("open");
      await query(team(), "SELECT confirm_results($1, $2, $3)", [
        event,
        await places(event),
        randomUUID(),
      ]);
      expect((await reading(event)).state).toBe("confirmed");
      await query(team(), "SELECT reveal_results($1, $2, $3)", [event, inHours(24), randomUUID()]);
      expect((await reading(event)).state).toBe("revealed");
    });

    it.each([
      ["no time", () => null, "LF422:startsAt"],
      ["a time that has passed", () => new Date(Date.now() - 1000), "LF422:startsAt"],
      ["a time before the event starts", () => inHours(-3), "LF422:startsAt"],
      ["a time more than a day after it ends", () => inHours(50), "LF422:startsAt"],
    ])("refuses %s", async (_name, when, expected) => {
      const event = await newEvent();
      expect(await refusal(set(event, when()))).toBe(expected);
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
    });

    it("refuses a goal of another event, one that is final, and one that closes before the finale", async () => {
      const event = await newEvent();
      const other = await newEvent();
      expect(await refusal(set(event, inHours(1), await goal(other)))).toBe("LF422:goal");
      expect(await refusal(set(event, inHours(1), randomUUID()))).toBe("LF422:goal");
      const done = await goal(event, { status: "missed", finalAt: new Date() });
      expect(await refusal(set(event, inHours(1), done))).toBe("LF422:goal_done");
      const short = await goal(event, { endsAt: inHours(1) });
      expect(await refusal(set(event, inHours(2), short))).toBe("LF422:goal_window");
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
    });

    it("keeps the goal closing at the event's end when that comes first", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET ends_at = now() + interval '1 hour' WHERE id = $1", [event]);
      const long = await goal(event, { endsAt: inHours(0.9) });
      expect(await refusal(set(event, inHours(0.95), long))).toBe("LF422:goal_window");
    });

    it("is the owner's alone, and not without the add-on", async () => {
      const event = await newEvent();
      await set(event, inHours(1));
      expect(await refusal(set(event, inHours(2), null, team(editorA)))).toBe("LF403");
      expect(await refusal(clear(event, team(editorA)))).toBe("LF403");
      expect((await reading(event, team(editorA))).finale).not.toBeNull();
      const bare = await newEvent({ addon: false });
      expect((await reading(bare)).enabled).toBe(false);
      expect(await refusal(set(bare, inHours(1)))).toBe("BS403");
    });

    it("cannot change once its time has come, but can still be cleared", async () => {
      const event = await newEvent();
      await set(event, inHours(1));
      await startNow(event);
      expect((await reading(event)).finale?.started).toBe(true);
      expect(await refusal(set(event, inHours(2)))).toBe("LF409:started");
      expect((await clear(event)).finale).toBeNull();
    });

    it("answers another organizer's event, an unknown one and no team at all as not found", async () => {
      const event = await newEvent();
      for (const context of [team(ownerB, ids.orgB), {} as RequestContext]) {
        expect(await refusal(reading(event, context))).toBe("AN404");
        expect(await refusal(set(event, inHours(1), null, context))).toBe("AN404");
        expect(await refusal(clear(event, context))).toBe("AN404");
      }
      expect(await refusal(reading(randomUUID()))).toBe("AN404");
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
    });

    it("goes with its event, and loses only the goal when the goal is deleted", async () => {
      const event = await newEvent();
      const pushGoal = await goal(event);
      await set(event, inHours(1), pushGoal);
      await owner("DELETE FROM community_step WHERE goal_id = $1", [pushGoal]);
      await owner("DELETE FROM community_goal WHERE id = $1", [pushGoal]);
      expect(await owner("SELECT goal_id FROM finale WHERE event_id = $1", [event])).toEqual([
        { goal_id: null },
      ]);
      await owner("DELETE FROM event WHERE id = $1", [event]);
      expect(await owner("SELECT 1 FROM finale WHERE event_id = $1", [event])).toEqual([]);
    });
  });

  describe("the screen's running list", () => {
    it("adds the finale last, and shows it alone from its time on", async () => {
      const event = await newEvent();
      const screen = await device(event);
      expect((await view(screen))["scenes"]).toEqual(["ranking", "community", "poll"]);
      await set(event, inHours(1));
      expect(await view(screen)).toMatchObject({
        shut: null,
        scenes: ["ranking", "community", "poll", "finale"],
      });
      await query(team(), "SELECT set_big_screen($1, $2, $3)", [event, ["poll"], randomUUID()]);
      expect((await view(screen))["scenes"]).toEqual(["poll", "finale"]);
      expect(
        (
          await query<{ r: { scenes: string[] } }>(team(), "SELECT event_big_screen($1) AS r", [
            event,
          ])
        )[0]?.r.scenes,
      ).toEqual(["poll"]);
      await startNow(event);
      expect((await view(screen))["scenes"]).toEqual(["finale"]);
      await clear(event);
      expect((await view(screen))["scenes"]).toEqual(["poll"]);
    });

    it("stays open after the end while a finale is set, and is shut without one", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await set(event, inHours(1));
      await end(event);
      expect(await view(screen)).toMatchObject({ shut: null, scenes: ["finale"] });
      expect((await read<Row>(screen, "screen_ranking"))["shut"]).toBe("event_ended");
      await clear(event);
      expect(await view(screen)).toMatchObject({ shut: "event_ended", scenes: null });
      const archived = await newEvent();
      const closed = await device(archived);
      await set(archived, inHours(1));
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [archived]);
      expect(await view(closed)).toMatchObject({ shut: "event_ended", scenes: null });
      expect(await scene(closed)).toEqual({ shut: "event_ended" });
    });

    it("is shut feature_off while the add-on is off", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await set(event, inHours(1));
      await owner("DELETE FROM event_entitlement WHERE event_id = $1", [event]);
      expect(await view(screen)).toMatchObject({ shut: "feature_off", scenes: null });
      expect(await scene(screen)).toEqual({ shut: "feature_off" });
    });
  });

  describe("the finale scene (FR-254, FR-255, FR-1621)", () => {
    it("is empty while no finale is set", async () => {
      const event = await newEvent();
      expect(await scene(await device(event))).toEqual({ shut: null, finale: null });
    });

    it("counts down with the time and nothing of the goal or the places", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const when = inHours(1);
      await set(event, when, await goal(event));
      const finale = await finaleOf(screen);
      expect(Object.keys(finale ?? {}).toSorted()).toEqual(["phase", "startsAt"]);
      expect(finale?.["phase"]).toBe("countdown");
      expect(new Date(String(finale?.["startsAt"])).getTime()).toBe(when.getTime());
    });

    it("pushes with the goal's cached progress and milestones, and no reward", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await set(event, inHours(0.5), await goal(event, { progress: 70 }));
      await startNow(event);
      const finale = await finaleOf(screen);
      expect(finale).toMatchObject({
        phase: "push",
        goal: {
          title: { en: "Light the tower" },
          measure: "points",
          target: 100,
          progress: 70,
          status: "running",
          steps: [
            { threshold: 50, isGoal: false, reached: false },
            { threshold: 100, isGoal: true, reached: false },
          ],
        },
      });
      expect(Object.keys((finale?.["goal"] as Row) ?? {}).toSorted()).toEqual([
        "endsAt",
        "measure",
        "progress",
        "status",
        "steps",
        "target",
        "title",
      ]);
      await owner(
        "UPDATE community_goal SET status = 'missed', final_at = now() WHERE id = (SELECT goal_id FROM finale WHERE event_id = $1)",
        [event],
      );
      expect((await finaleOf(screen))?.["goal"]).toMatchObject({ status: "missed", progress: 70 });
    });

    it("waits when there is no goal, when the goal was deleted and when community is switched off", async () => {
      const bare = await newEvent();
      const screenBare = await device(bare);
      await set(bare, inHours(1));
      await startNow(bare);
      expect(await finaleOf(screenBare)).toMatchObject({ phase: "waiting" });
      const off = await newEvent();
      const screenOff = await device(off);
      await set(off, inHours(1), await goal(off));
      await startNow(off);
      expect(await finaleOf(screenOff)).toMatchObject({ phase: "push" });
      await owner(
        `UPDATE event SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{features}', '{"community": false}'::jsonb)
         WHERE id = $1`,
        [off],
      );
      expect(await finaleOf(screenOff)).toMatchObject({ phase: "waiting" });
    });

    it("shows no winner before the owner reveals them, even once the results are confirmed", async () => {
      const event = await newEvent();
      const screen = await device(event);
      await newPlayer(event, 300);
      await set(event, inHours(1));
      await startNow(event);
      await confirmAndReveal(event, false);
      const finale = await finaleOf(screen);
      expect(finale).toMatchObject({ phase: "waiting" });
      expect(finale).not.toHaveProperty("winners");
    });

    it("reveals the top ten by place with a username and an avatar only, once the owner revealed them", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const players = [];
      for (let points = 1; points <= 12; points += 1) {
        players.push(await newPlayer(event, points * 10));
      }
      const pushGoal = await goal(event);
      await set(event, inHours(1), pushGoal);
      await startNow(event);
      await owner("UPDATE community_goal SET status = 'missed', final_at = now() WHERE id = $1", [
        pushGoal,
      ]);
      await confirmAndReveal(event);
      const finale = await finaleOf(screen);
      expect(finale?.["phase"]).toBe("reveal");
      const winners = finale?.["winners"] as Row[];
      expect(winners.map((winner) => winner["place"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(Object.keys(winners[0] ?? {}).toSorted()).toEqual(["avatar", "place", "username"]);
      const names = await owner<{ username: string }>(
        "SELECT username FROM player WHERE id = ANY($1) ORDER BY username",
        [players.slice(2).map((made) => made.player)],
      );
      expect(winners.map((winner) => winner["username"]).toSorted()).toEqual(
        names.map((name) => name.username),
      );
      expect(winners[0]?.["username"]).toBe(
        (
          await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [
            players[11]?.player,
          ])
        )[0]?.username,
      );
      expect(finale).not.toHaveProperty("goal");
    });

    it("keeps the frozen places when a winner later leaves, and names a deleted account without a username", async () => {
      const event = await newEvent();
      const screen = await device(event);
      const gone = await newPlayer(event, 200);
      await newPlayer(event, 100);
      await set(event, inHours(1));
      await confirmAndReveal(event);
      await owner(
        "UPDATE player SET status = 'deleted', username = NULL, avatar = 'falcon' WHERE id = $1",
        [gone.player],
      );
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [gone.enrollment]);
      const winners = (await finaleOf(screen))?.["winners"] as Row[];
      expect(winners).toHaveLength(2);
      expect(winners[0]).toEqual({ place: 1, username: null, avatar: "falcon" });
    });
  });

  describe("who may read it", () => {
    it("refuses a station, a revoked device, an unknown one, an unactivated one and every other seat", async () => {
      const event = await newEvent();
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         SELECT $1, c.id, 'scan_qr', 'Gate', 10, ARRAY['screen_qr', 'kiosk'] FROM category c
         WHERE c.event_id = $1 LIMIT 1 RETURNING id`,
        [event],
      );
      expect(
        await refusal(read(await device(event, "station", quest?.id ?? null), "screen_finale")),
      ).toBe("DV401");
      const screen = await device(event);
      await query(team(), "SELECT revoke_device($1, $2, $3)", [event, screen, randomUUID()]);
      expect(await refusal(read(screen, "screen_finale"))).toBe("DV401");
      expect(await refusal(query({}, "SELECT screen_finale()"))).toBe("DV401");
      expect(await refusal(read(randomUUID(), "screen_finale"))).toBe("DV401");
      const pending = await openRequest("screen");
      const [claimed] = await query<{ id: string }>(
        team(),
        "SELECT team_claim_device($1, $2, 'screen', NULL, 'Not yet', $3) AS id",
        [pending.code, event, randomUUID()],
      );
      expect(await refusal(read(claimed?.id ?? "", "screen_finale"))).toBe("DV401");
      expect(await refusal(query(team(), "SELECT screen_finale()"))).toBe("DV401");
      expect(await refusal(query({ playerId: ids.playerA }, "SELECT screen_finale()"))).toBe(
        "DV401",
      );
    });

    it("shows a screen its own event's finale only", async () => {
      const mine = await newEvent();
      const theirs = await newEvent();
      const screen = await device(mine);
      await set(theirs, inHours(1));
      expect(await finaleOf(screen)).toBeNull();
    });
  });
});
