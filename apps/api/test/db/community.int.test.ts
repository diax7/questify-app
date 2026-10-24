import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
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
type Member = Readonly<{ player: string; enrollment: string }>;
type Goal = Readonly<{
  status: string;
  progress: string;
  settled_until: Date | null;
  settled_value: string;
  final_at: Date | null;
}>;
type Community = Readonly<{
  goalId: string;
  status: string;
  progress: number;
  target: number;
  endsAt: string;
  contributed: boolean;
  steps: readonly Readonly<{
    threshold: number;
    isGoal: boolean;
    reward: Readonly<{ kind: string; points?: number; moment?: Readonly<{ en?: string }> }>;
    reachedAt: string | null;
    mine: string | null;
  }>[];
}>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string; hint?: string };
    const detail = pg.detail === undefined || pg.detail === "" ? "" : `:${pg.detail}`;
    const hint = pg.hint === undefined || pg.hint === "" ? "" : `:${pg.hint}`;
    return `${pg.code}${detail}${hint}`;
  }
};
const SYSTEM: RequestContext = {};
const as = (player: string): RequestContext => ({ playerId: player });
const hourFromNow = () => new Date(Date.now() + 3_600_000).toISOString();

const body = (over: Row = {}): Row => ({
  title: { en: "Light the tower", ar: "أضيئوا البرج" },
  measure: "points",
  target: 100,
  startsAt: new Date().toISOString(),
  endsAt: hourFromNow(),
  paidTo: "contributors",
  reward: { kind: "points", points: 20 },
  milestones: [],
  ...over,
});
const sorted = (...values: string[]) => values.toSorted();

/**
 * Community quests in the database (T-306b, migration 0053, ADR-222 to ADR-226): counting each measure inside the
 * window, the settle point and its lag, reaching, payee lists and their top-up, the payer, the builder's rules, the
 * switches, results waiting for the payer, the owner's settle, the live card, the go-live wipe and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("community quests (database)", () => {
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
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const editor = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: editorA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });

  const newEvent = async (status = "live", startedAgo = "2 hours", endsIn = "1 day") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Tower Fest', $3, now() - $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `CMQ${counter}`, status, startedAgo, endsIn],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string) =>
    (
      await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stage') RETURNING id",
        [event],
      )
    )[0]?.id ?? "";
  const newQuest = async (event: string, category?: string, points = 10) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
         VALUES ($1, $2, 'scan_qr', 'Scan', $3, 100) RETURNING id`,
        [event, category ?? (await newCategory(event)), points],
      )
    )[0]?.id ?? "";
  const member = async (event: string, via = "code", status = "active"): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`cq_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ids.orgA, event, player?.id, via, status],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };

  /** A quest completion and its entry `ago` before now (the owner writes both, as the engine would). */
  const earn = async (who: Member, quest: string, points: number, ago = "5 minutes") => {
    const [made] = await owner<{ id: string }>(
      `WITH c AS (
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, created_at)
         SELECT n.organizer_id, n.event_id, n.id, $2,
                coalesce((SELECT max(x.occurrence) FROM quest_completion x
                          WHERE x.enrollment_id = n.id AND x.quest_id = $2), 0) + 1,
                'qr', gen_random_uuid()::text, now() - $4::interval
         FROM enrollment n WHERE n.id = $1 RETURNING *)
       INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor, created_at)
       SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', $3, $3, c.id, c.quest_id, 'player', c.created_at
       FROM c RETURNING id`,
      [who.enrollment, quest, points, ago],
    );
    return made?.id ?? "";
  };
  /** Another kind of entry `ago` before now: an award, a welcome, or a category bonus. */
  const other = async (
    who: Member,
    kind: string,
    points: number,
    ago = "5 minutes",
    category?: string,
  ) => {
    const actor = kind === "award" ? "staff" : "system";
    const [made] = await owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id, category_id, bonus_period, created_at)
       SELECT n.organizer_id, n.event_id, n.id, $2, $3, $3, $4, CASE WHEN $4 = 'staff' THEN $5::uuid END, $6::uuid,
              CASE WHEN $2 = 'bonus' THEN '-infinity'::timestamptz END, now() - $7::interval
       FROM enrollment n WHERE n.id = $1 RETURNING id`,
      [who.enrollment, kind, points, actor, ownerA, category ?? null, ago],
    );
    return made?.id ?? "";
  };
  /** A staff removal of `entry`, `ago` before now, copying what the engine copies. */
  const removal = async (entry: string, ago = "4 minutes") =>
    owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, category_id, actor, staff_user_id, reverses, created_at)
       SELECT l.organizer_id, l.event_id, l.enrollment_id, 'removal', -l.score_delta, -l.balance_delta,
              l.completion_id, l.quest_id, l.category_id, 'staff', $2, l.id, now() - $3::interval
       FROM ledger_entry l WHERE l.id = $1`,
      [entry, ownerA, ago],
    );

  const save = async (event: string, made: Row, goal: string | null = null, team = teamA()) =>
    (
      await query<{ id: string }>(team, "SELECT save_community_goal($1, $2, $3, $4) AS id", [
        event,
        goal,
        JSON.stringify(made),
        randomUUID(),
      ])
    )[0]?.id ?? "";
  /** A goal whose window began `ago` before now and ends `endsIn` from now (written past the builder's start rule). */
  const goalIn = async (event: string, made: Row = {}, ago = "10 minutes", endsIn = "1 hour") => {
    const goal = await save(event, body(made));
    await owner(
      `UPDATE community_goal SET starts_at = date_trunc('milliseconds', now() - $2::interval),
                                 ends_at = date_trunc('milliseconds', now() + $3::interval) WHERE id = $1`,
      [goal, ago, endsIn],
    );
    return goal;
  };
  /** One tick's settle of the goal: at most 10 minutes past its last settle point. */
  const settleOnce = async (goal: string, mayStart = true) =>
    (await query<{ s: string }>(SYSTEM, "SELECT settle_goal($1, $2) AS s", [goal, mayStart]))[0]?.s;
  /** Ticks until the goal is final or its settle point stops moving, as a tick would after a pause. */
  const settle = async (goal: string, mayStart = true) => {
    let status = await settleOnce(goal, mayStart);
    for (let tick = 0; tick < 50; tick += 1) {
      const before = await state(goal);
      if (before === undefined || before.final_at !== null) {
        break;
      }
      const next = await settleOnce(goal, mayStart);
      const after = await state(goal);
      if (after.settled_until?.getTime() === before.settled_until?.getTime()) {
        break;
      }
      status = next;
    }
    return status;
  };
  const pay = async (event: string) =>
    query<{ step_id: string; paid: number; skipped: number }>(
      SYSTEM,
      "SELECT * FROM pay_community_batch(500, $1)",
      [event],
    );
  const state = async (goal: string) =>
    (
      await owner<Goal>(
        "SELECT status, progress, settled_until, settled_value, final_at FROM community_goal WHERE id = $1",
        [goal],
      )
    )[0] as Goal;
  const payouts = async (goal: string) =>
    owner<{ threshold: string; enrollment_id: string; status: string; skip_reason: string | null }>(
      `SELECT s.threshold, p.enrollment_id, p.status, p.skip_reason FROM community_payout p
       JOIN community_step s ON s.id = p.step_id WHERE s.goal_id = $1 ORDER BY s.threshold, p.enrollment_id`,
      [goal],
    );
  const paidTo = async (goal: string) =>
    (await payouts(goal)).map((row) => row.enrollment_id).toSorted();
  const contributors = async (goal: string) =>
    (
      await owner<{ enrollment_id: string }>(
        "SELECT enrollment_id FROM community_contributor WHERE goal_id = $1 ORDER BY enrollment_id",
        [goal],
      )
    ).map((row) => row.enrollment_id);
  const live = async (player: string, event: string) =>
    (
      await query<{ s: { community: Community | null } }>(
        as(player),
        "SELECT live_state($1) AS s",
        [event],
      )
    )[0]?.s.community ?? null;

  const completionsBy = async (filter: "quest" | "category" | "any") => {
    const event = await newEvent();
    const category = await newCategory(event);
    const [counted, sibling, elsewhere] = [
      await newQuest(event, category),
      await newQuest(event, category),
      await newQuest(event),
    ];
    const scope =
      filter === "quest"
        ? { questId: counted }
        : filter === "category"
          ? { categoryId: category }
          : {};
    const goal = await goalIn(event, { measure: "completions", target: 50, ...scope });
    const who = await member(event);
    await earn(who, counted, 0);
    const removed = await earn(who, counted, 0);
    await removal(removed);
    await earn(who, sibling, 0);
    await earn(who, elsewhere, 0);
    await earn(who, counted, 0, "20 minutes");
    await settle(goal);
    return (await state(goal)).progress;
  };
  const settlePoint = async () =>
    (await owner<{ p: string }>("SELECT community_settle_point()::text AS p"))[0]?.p;

  const reachedFor = async (paidToWhom = "contributors") => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const goal = await goalIn(event, { target: 10, paidTo: paidToWhom });
    return { event, quest, goal };
  };
  const placesOf = async (event: string) =>
    (
      await owner<{ ids: string[] }>(
        `SELECT coalesce(array_agg(c.enrollment_id ORDER BY c.rank), '{}') AS ids
         FROM current_places((SELECT e FROM event e WHERE e.id = $1)) c`,
        [event],
      )
    )[0]?.ids ?? [];
  const confirm = async (event: string) =>
    query<{ outcome: string }>(teamA(), "SELECT confirm_results($1, $2, $3) AS outcome", [
      event,
      await placesOf(event),
      randomUUID(),
    ]);
  const settleNow = (event: string, team = teamA()) =>
    query<{ n: number }>(team, "SELECT settle_community($1, true, $2) AS n", [event, randomUUID()]);

  describe("counting each measure inside the window", () => {
    it("counts quest and bonus points, never awards, welcomes or entries outside the window", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const category = await newCategory(event);
      const goal = await goalIn(event, { target: 1000 });
      const [a, b] = [await member(event), await member(event)];
      await earn(a, quest, 30);
      await other(b, "bonus", 50, "5 minutes", category);
      await other(a, "award", 70);
      await other(b, "welcome", 90);
      await earn(a, quest, 1000, "11 minutes");
      expect(await settle(goal)).toBe("running");
      expect(await state(goal)).toMatchObject({ progress: "80", settled_value: "80" });
      expect(await contributors(goal)).toEqual(sorted(a.enrollment, b.enrollment));
    });

    it("counts a row at the start and not one a millisecond before it or at the end", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 1000 }, "10 minutes", "1 hour");
      await owner(
        "UPDATE community_goal SET ends_at = starts_at + interval '5 minutes' WHERE id = $1",
        [goal],
      );
      const who = await member(event);
      const [g] = await owner<{ starts_at: Date; ends_at: Date }>(
        "SELECT starts_at, ends_at FROM community_goal WHERE id = $1",
        [goal],
      );
      const exact = async (points: number, moment: string) =>
        owner(
          `WITH c AS (
             INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                           idempotency_key, created_at)
             SELECT n.organizer_id, n.event_id, n.id, $2,
                    coalesce((SELECT max(x.occurrence) FROM quest_completion x
                              WHERE x.enrollment_id = n.id AND x.quest_id = $2), 0) + 1,
                    'qr', gen_random_uuid()::text, $4::timestamptz
             FROM enrollment n WHERE n.id = $1 RETURNING *)
           INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                     completion_id, quest_id, actor, created_at)
           SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', $3, $3, c.id, c.quest_id, 'player',
                  c.created_at
           FROM c`,
          [who.enrollment, quest, points, moment],
        );
      const start = g?.starts_at.getTime() ?? 0;
      const end = g?.ends_at.getTime() ?? 0;
      await exact(1, new Date(start - 1).toISOString());
      await exact(10, new Date(start).toISOString());
      await exact(100, new Date(end - 1).toISOString());
      await exact(1000, new Date(end).toISOString());
      await settle(goal);
      expect((await state(goal)).progress).toBe("110");
    });

    it("counts a removal of a counted entry, and not one of an entry from before the window", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 1000 });
      const who = await member(event);
      const before = await earn(who, quest, 40, "20 minutes");
      const inside = await earn(who, quest, 25);
      await earn(who, quest, 15);
      await removal(before);
      await removal(inside);
      await settle(goal);
      expect((await state(goal)).progress).toBe("15");
    });

    it("counts completions of the quest, of the category's quests, or of any quest, minus removals", async () => {
      expect(await completionsBy("quest")).toBe("1");
      expect(await completionsBy("category")).toBe("2");
      expect(await completionsBy("any")).toBe("3");
    });

    it("counts players, once each, and makes no contributor of a 0-point completion in a points goal", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const players = await goalIn(
        event,
        { measure: "players", target: 50 },
        "10 minutes",
        "10 minutes",
      );
      const [a, b] = [await member(event), await member(event)];
      await earn(a, quest, 0);
      await earn(a, quest, 0);
      await earn(b, quest, 5);
      await settle(players);
      expect((await state(players)).progress).toBe("2");
      const second = await newEvent();
      const zeroQuest = await newQuest(second);
      const points = await goalIn(second, { target: 50 });
      const c = await member(second);
      await earn(c, zeroQuest, 0);
      await settle(points);
      expect(await contributors(points)).toEqual([]);
    });
  });

  describe("the CTO code review's cases", () => {
    it("finishes a goal a stale tick started while the switch went off (CTO code review 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 1000 });
      const who = await member(event);
      await earn(who, quest, 10);
      expect(await settleOnce(goal)).toBe("running");
      // The trigger saw the goal still scheduled and skipped it: the switch is off with the goal running.
      await owner("ALTER TABLE event DISABLE TRIGGER event_community_off");
      try {
        await owner(
          `UPDATE event SET config = config || '{"features": {"community": false}}' WHERE id = $1`,
          [event],
        );
      } finally {
        await owner("ALTER TABLE event ENABLE TRIGGER event_community_off");
      }
      expect(await settleOnce(goal)).toBe("missed");
      expect((await state(goal)).final_at).not.toBeNull();
    });

    it("finishes a scheduled goal whose event ended before its start (CTO code review 2)", async () => {
      const event = await newEvent();
      const goal = await save(
        event,
        body({
          startsAt: new Date(Date.now() + 3_600_000).toISOString(),
          endsAt: new Date(Date.now() + 5_400_000).toISOString(),
        }),
      );
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 second' WHERE id = $1",
        [event],
      );
      const listed = (
        await query<{ g: string }>(SYSTEM, "SELECT g FROM community_tick_goals() g")
      ).map((row) => row.g);
      expect(listed).toContain(goal);
      expect(await settleOnce(goal)).toBe("missed");
      expect((await state(goal)).final_at).not.toBeNull();
    });

    it("reads at most 10 minutes a settle and catches a backlog up over several (CTO code review 3)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 100000 }, "35 minutes", "1 hour");
      const who = await member(event);
      for (const ago of ["34 minutes", "24 minutes", "14 minutes", "4 minutes"]) {
        await earn(who, quest, 10, ago);
      }
      await settleOnce(goal);
      const first = await state(goal);
      expect(first.settled_value).toBe("10");
      const [start] = await owner<{ starts_at: Date }>(
        "SELECT starts_at FROM community_goal WHERE id = $1",
        [goal],
      );
      expect((first.settled_until?.getTime() ?? 0) - (start?.starts_at.getTime() ?? 0)).toBe(
        600_000,
      );
      await settle(goal);
      expect(await state(goal)).toMatchObject({ settled_value: "40", progress: "40" });
    });
  });

  describe("the settle point and its lag (ADR-222, ADR-224)", () => {
    it("shows the last 30 seconds as the tail without settling them", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 1000 });
      const who = await member(event);
      await earn(who, quest, 30, "2 minutes");
      await earn(who, quest, 7, "5 seconds");
      await settle(goal);
      const after = await state(goal);
      expect(after).toMatchObject({ progress: "37", settled_value: "30" });
      expect(Date.now() - (after.settled_until?.getTime() ?? 0)).toBeGreaterThanOrEqual(29_000);
      expect(await contributors(goal)).toEqual([who.enrollment]);
    });

    it("holds the settle point at an open transaction's start until it commits", async () => {
      expect(await settlePoint()).toBe("infinity");
      const open: PoolClient = await pool.connect();
      try {
        await open.query("BEGIN");
        await open.query("SELECT 1");
        const [start] = await owner<{ xact_start: Date; p: Date }>(
          "SELECT xact_start, community_settle_point() AS p FROM pg_stat_activity WHERE pid = $1",
          [(open as unknown as { processID: number }).processID],
        );
        expect(start?.p.getTime()).toBe(start?.xact_start.getTime());
        await open.query("COMMIT");
      } finally {
        open.release();
      }
      expect(await settlePoint()).toBe("infinity");
    });

    it("refuses an unreadable writer's session (CV500 settle_blind) and takes the oldest start", async () => {
      expect(await refusal(owner("SELECT settle_point_of(now(), ARRAY[now()], 1)"))).toBe(
        "CV500:settle_blind",
      );
      const [row] = await owner<{ p: Date; a: Date }>(
        `SELECT settle_point_of('infinity', ARRAY[now() - interval '2 minutes', now() - interval '1 minute'], 0) AS p,
                now() - interval '2 minutes' AS a`,
      );
      expect(row?.p.getTime()).toBe(row?.a.getTime());
      const [none] = await owner<{ p: string }>(
        "SELECT settle_point_of('infinity', '{}', 0)::text AS p",
      );
      expect(none?.p).toBe("infinity");
    });

    it("runs only at READ COMMITTED, is VOLATILE, and only in the system context (CS403)", async () => {
      const event = await newEvent();
      const goal = await goalIn(event);
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        expect(await refusal(client.query("SELECT settle_goal($1, true)", [goal]))).toBe("CI500");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      const volatility = await owner<{ proname: string; provolatile: string }>(
        `SELECT proname, provolatile FROM pg_proc
         WHERE proname IN ('settle_goal', 'settle_goal_at', 'settle_community', 'community_settle_point')
         ORDER BY proname`,
      );
      expect(volatility.every((row) => row.provolatile === "v")).toBe(true);
      expect(volatility).toHaveLength(4);
      expect(await refusal(query(teamA(), "SELECT settle_goal($1, true)", [goal]))).toBe("CS403");
      expect(
        await refusal(query(as(ids.playerA), "SELECT * FROM pay_community_batch(5, NULL)")),
      ).toBe("CS403");
      expect(await refusal(query(teamA(), "SELECT * FROM community_tick_goals()"))).toBe("CS403");
      expect(await refusal(query(teamA(), "SELECT community_health()"))).toBe("CS403");
    });

    it("answers migrate --verify's question as the API role: the settle point's owner sees its sessions", async () => {
      const { rows } = await db.app.query<{ sees: boolean }>(
        `SELECT r.rolsuper OR pg_has_role(r.oid, 'questify_app', 'USAGE') AS sees
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.oid = 'public.community_settle_point()'::regprocedure`,
      );
      expect(rows).toEqual([{ sees: true }]);
    });

    it("lists the goals with work and reports the health in ids and counts only", async () => {
      const event = await newEvent();
      const goal = await goalIn(event);
      const later = await save(
        event,
        body({
          startsAt: new Date(Date.now() + 7_200_000).toISOString(),
          endsAt: new Date(Date.now() + 9_000_000).toISOString(),
        }),
      );
      const listed = (
        await query<{ g: string }>(SYSTEM, "SELECT g FROM community_tick_goals() g")
      ).map((row) => row.g);
      expect(listed).toContain(goal);
      expect(listed).not.toContain(later);
      await settle(goal);
      await owner(
        "UPDATE community_goal SET settled_until = now() - interval '5 minutes' WHERE id = $1",
        [goal],
      );
      const [health] = await query<{ h: { behind: string[]; stuckRows: number } }>(
        SYSTEM,
        "SELECT community_health() AS h",
      );
      expect(health?.h.behind).toContain(goal);
      expect(Object.keys(health?.h ?? {}).toSorted()).toEqual([
        "behind",
        "blocker",
        "stuckRows",
        "stuckSteps",
      ]);
    });
  });

  describe("reaching, payee lists and the top-up (FR-246, FR-248, ADR-225)", () => {
    it("reaches on the tail, pays a tail-only contributor, and finishes the goal at its goal step", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, {
        target: 100,
        milestones: [
          { threshold: 40, reward: { kind: "moment", moment: { en: "The band plays" } } },
        ],
      });
      const [a, b] = [await member(event), await member(event)];
      await earn(a, quest, 50, "3 minutes");
      expect(await settle(goal)).toBe("running");
      await earn(b, quest, 60, "3 seconds");
      expect(await settle(goal)).toBe("reached");
      expect((await state(goal)).final_at).toBeNull();
      expect(await paidTo(goal)).toEqual(sorted(a.enrollment, b.enrollment));
      expect(
        (
          await owner(
            "SELECT action FROM audit_log WHERE action = 'community.step_reached' AND after ->> 'goal' = $1",
            [goal],
          )
        ).length,
      ).toBe(2);
      expect(await pay(event)).toEqual([expect.objectContaining({ paid: 2, skipped: 0 })]);
      expect(
        await owner(
          "SELECT kind, score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'community'",
          [b.enrollment],
        ),
      ).toEqual([{ kind: "community", score_delta: "20" }]);
    });

    it("tops a reached step up with a straggler whose transaction began before the reach", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 100 });
      const [a, late] = [await member(event), await member(event)];
      const ownerUrl = new URL(TEST_DATABASE_URL ?? "");
      ownerUrl.pathname = new URL(db.appUrl).pathname;
      const writer = new Client({ connectionString: ownerUrl.toString() });
      await writer.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          `WITH c AS (
             INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                           idempotency_key)
             SELECT n.organizer_id, n.event_id, n.id, $2, 1, 'qr', gen_random_uuid()::text
             FROM enrollment n WHERE n.id = $1 RETURNING *)
           INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                     completion_id, quest_id, actor)
           SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', 5, 5, c.id, c.quest_id, 'player' FROM c`,
          [late.enrollment, quest],
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        await earn(a, quest, 120, "0 seconds");
        expect(await settle(goal)).toBe("reached");
        expect(await paidTo(goal)).toEqual([a.enrollment]);
        await writer.query("COMMIT");
      } finally {
        await writer.end();
      }
      await settle(goal);
      expect(await paidTo(goal)).toEqual(sorted(a.enrollment, late.enrollment));
      expect((await state(goal)).progress).toBe("125");
    });

    it("pays everyone active at the reach: not the left, banned, pending, rehearsal, no-play or later joiners", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 10, paidTo: "everyone" });
      const doer = await member(event);
      const idle = await member(event);
      const left = await member(event, "code", "left");
      const banned = await member(event, "code", "banned");
      const pending = await member(event, "code", "pending");
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, '{review}', false)",
        [ids.orgA, event, operator.player],
      );
      const deleted = await member(event);
      await owner("UPDATE player SET status = 'deleted', username = NULL WHERE id = $1", [
        deleted.player,
      ]);
      await earn(doer, quest, 10);
      expect(await settle(goal)).toBe("reached");
      await member(event);
      await settle(goal);
      expect(await paidTo(goal)).toEqual(sorted(doer.enrollment, idle.enrollment));
      void [left, banned, pending];
    });

    it("keeps reached milestones' rewards when the goal is missed, and a miss pays nothing (FR-246, FR-249)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(
        event,
        {
          target: 100,
          reward: { kind: "points", points: 50 },
          milestones: [
            { threshold: 10, reward: { kind: "points", points: 5 } },
            { threshold: 20, reward: { kind: "nothing" } },
          ],
        },
        "20 minutes",
        "1 hour",
      );
      await owner(
        "UPDATE community_goal SET ends_at = now() - interval '5 minutes' WHERE id = $1",
        [goal],
      );
      const who = await member(event);
      await earn(who, quest, 25, "10 minutes");
      expect(await settle(goal)).toBe("missed");
      const after = await state(goal);
      expect(after.final_at).not.toBeNull();
      expect((await payouts(goal)).map((row) => row.threshold)).toEqual(["10"]);
      await pay(event);
      expect(
        await owner(
          "SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'community'",
          [who.enrollment],
        ),
      ).toEqual([{ score_delta: "5" }]);
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM community_reach r JOIN community_step s ON s.id = r.step_id WHERE s.goal_id = $1",
          [goal],
        ),
      ).toEqual([{ n: 2 }]);
    });

    it("writes no entry for a moment or nothing step, and finishes a goal reached after its window", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(
        event,
        {
          target: 20,
          reward: { kind: "moment", moment: { en: "Fireworks" } },
          milestones: [{ threshold: 10, reward: { kind: "nothing" } }],
        },
        "20 minutes",
        "1 hour",
      );
      await owner(
        "UPDATE community_goal SET ends_at = now() - interval '5 minutes' WHERE id = $1",
        [goal],
      );
      const who = await member(event);
      await earn(who, quest, 30, "10 minutes");
      expect(await settle(goal)).toBe("reached");
      expect((await state(goal)).final_at).not.toBeNull();
      expect(await payouts(goal)).toEqual([]);
      expect(await pay(event)).toEqual([]);
    });

    it("never counts rehearsal rows or lists a rehearsal account: the go-live wipe runs first", async () => {
      const event = await newEvent("scheduled", "10 minutes");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'CMQR-WXPE')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event);
      const rehearsal = await member(event, "rehearsal");
      await earn(rehearsal, quest, 80, "5 minutes");
      const real = await member(event);
      const [goal] = await owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, paid_to)
         VALUES ($1, $2, 'Wipe first', 'points', 50, now() - interval '9 minutes', now() + interval '1 hour', 'everyone')
         RETURNING id`,
        [ids.orgA, event],
      );
      await owner(
        "INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points) VALUES ($1, $2, 50, true, 'points', 5)",
        [event, goal?.id],
      );
      await earn(real, quest, 60, "4 minutes");
      expect(await settle(goal?.id ?? "")).toBe("reached");
      expect(await owner("SELECT 1 FROM enrollment WHERE id = $1", [rehearsal.enrollment])).toEqual(
        [],
      );
      expect((await state(goal?.id ?? "")).progress).toBe("60");
      expect(await paidTo(goal?.id ?? "")).toEqual([real.enrollment]);
    });
  });

  describe("the payer (ADR-223)", () => {
    it("pays once: a second batch pays nothing and the unique index refuses a hand-written second entry", async () => {
      const { event, quest, goal } = await reachedFor();
      const who = await member(event);
      await earn(who, quest, 10);
      await settle(goal);
      await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      expect(await pay(event)).toEqual([expect.objectContaining({ paid: 1, skipped: 0 })]);
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
      expect(await pay(event)).toEqual([]);
      const [step] = await owner<{ id: string }>(
        "SELECT id FROM community_step WHERE goal_id = $1",
        [goal],
      );
      expect(
        await refusal(
          owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                       community_step_id)
             VALUES ($1, $2, $3, 'community', 20, 20, 'system', $4)`,
            [ids.orgA, event, who.enrollment, step?.id],
          ),
        ),
      ).toMatch(/^23505/);
      const [paid] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'community'",
        [who.enrollment],
      );
      expect(await owner("SELECT 1 FROM xp_entry WHERE ledger_entry_id = $1", [paid?.id])).toEqual(
        [],
      );
      expect(
        await owner("SELECT score, balance FROM enrollment WHERE id = $1", [who.enrollment]),
      ).toEqual([{ score: "30", balance: "30" }]);
    });

    it("skips the inactive, the no-play operator and everyone once results are final", async () => {
      const { event, quest, goal } = await reachedFor();
      const [stays, leaves, operator] = [
        await member(event),
        await member(event),
        await member(event),
      ];
      for (const who of [stays, leaves, operator]) {
        await earn(who, quest, 10);
      }
      await settle(goal);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [leaves.enrollment]);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, '{review}', false)",
        [ids.orgA, event, operator.player],
      );
      expect(await pay(event)).toEqual([expect.objectContaining({ paid: 1, skipped: 2 })]);
      const reasons = Object.fromEntries(
        (await payouts(goal)).map((row) => [row.enrollment_id, row.skip_reason]),
      );
      expect(reasons).toEqual({
        [stays.enrollment]: null,
        [leaves.enrollment]: "inactive",
        [operator.enrollment]: "no_play",
      });
      const second = await reachedFor();
      const late = await member(second.event);
      await earn(late, second.quest, 10);
      await settle(second.goal);
      await owner("INSERT INTO event_result (event_id, organizer_id) VALUES ($1, $2)", [
        second.event,
        ids.orgA,
      ]);
      await pay(second.event);
      expect((await payouts(second.goal))[0]?.skip_reason).toBe("results_final");
    });

    it("credits no balance once the shop has closed", async () => {
      const { event, quest, goal } = await reachedFor();
      const who = await member(event);
      await earn(who, quest, 10);
      await settle(goal);
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      await pay(event);
      expect(
        await owner(
          "SELECT score_delta, balance_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'community'",
          [who.enrollment],
        ),
      ).toEqual([{ score_delta: "20", balance_delta: "0" }]);
    });

    it("removes a community reward as an award, copying its step, and names it by the goal", async () => {
      const { event, quest, goal } = await reachedFor();
      const who = await member(event);
      await earn(who, quest, 10);
      await settle(goal);
      await pay(event);
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'community'",
        [who.enrollment],
      );
      const ledger = await query<{ kind: string; title_en: string; removable: boolean }>(
        teamA(),
        "SELECT kind, title_en, removable FROM member_ledger($1, $2, NULL, 10)",
        [event, who.enrollment],
      );
      expect(ledger[0]).toEqual({
        kind: "community",
        title_en: "Light the tower",
        removable: true,
      });
      await query(teamA(), "SELECT * FROM remove_award($1, $2, 'Duplicate', $3, $4)", [
        event,
        entry?.id,
        randomUUID(),
        randomUUID(),
      ]);
      const [removed] = await owner<{ community_step_id: string | null; score_delta: string }>(
        "SELECT community_step_id, score_delta FROM ledger_entry WHERE reverses = $1",
        [entry?.id],
      );
      expect(removed?.community_step_id).not.toBeNull();
      expect(removed?.score_delta).toBe("-20");
      const activity = await query<{ kind: string; title_en: string }>(
        as(who.player),
        "SELECT kind, title_en FROM member_activity($1, NULL, 10)",
        [event],
      );
      expect(activity.slice(0, 2)).toEqual([
        { kind: "removal", title_en: "Light the tower" },
        { kind: "community", title_en: "Light the tower" },
      ]);
    });
  });

  describe("the builder", () => {
    it("creates and replaces a goal before its start, wholesale, audited", async () => {
      const event = await newEvent();
      const starts = new Date(Date.now() + 600_000).toISOString();
      const ends = new Date(Date.now() + 1_200_000).toISOString();
      const goal = await save(
        event,
        body({
          startsAt: starts,
          endsAt: ends,
          milestones: [{ threshold: 50, reward: { kind: "nothing" } }],
        }),
        null,
        editor(),
      );
      await save(event, body({ startsAt: starts, endsAt: ends, target: 200 }), goal);
      expect(
        await owner(
          "SELECT threshold, is_goal FROM community_step WHERE goal_id = $1 ORDER BY threshold",
          [goal],
        ),
      ).toEqual([{ threshold: "200", is_goal: true }]);
      expect(
        (
          await owner<{ action: string }>(
            "SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id",
            [goal],
          )
        ).map((row) => row.action),
      ).toEqual(["community.goal_create", "community.goal_update"]);
      await query(teamA(), "SELECT delete_community_goal($1, $2, $3)", [event, goal, randomUUID()]);
      expect(await owner("SELECT 1 FROM community_goal WHERE id = $1", [goal])).toEqual([]);
    });

    it("refuses an overlap, a start long past, an end past the event, bad milestones and another organizer", async () => {
      const event = await newEvent();
      const starts = new Date(Date.now() + 600_000);
      const at = (minutes: number) => new Date(starts.getTime() + minutes * 60_000).toISOString();
      await save(event, body({ startsAt: at(0), endsAt: at(30) }));
      expect(await refusal(save(event, body({ startsAt: at(20), endsAt: at(40) })))).toBe(
        "GL409:goal_overlap",
      );
      expect(await refusal(save(event, body({ startsAt: at(30), endsAt: at(40) })))).toBe("none");
      expect(
        await refusal(
          save(
            event,
            body({ startsAt: new Date(Date.now() - 120_000).toISOString(), endsAt: at(-5) }),
          ),
        ),
      ).toBe("CG422:startsAt");
      expect(await refusal(save(event, body({ startsAt: at(60), endsAt: at(60 * 48) })))).toBe(
        "CG422:endsAt",
      );
      expect(
        await refusal(
          save(
            event,
            body({
              startsAt: at(60),
              endsAt: at(70),
              milestones: [{ threshold: 100, reward: { kind: "nothing" } }],
            }),
          ),
        ),
      ).toBe("CG422:milestones");
      expect(
        await refusal(save(event, body({ startsAt: at(80), endsAt: at(90) }), null, teamB())),
      ).toBe("AN404");
    });

    it("lists the event's goals with steps and payout counts for its team only", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, {
        target: 10,
        milestones: [{ threshold: 5, reward: { kind: "nothing" } }],
      });
      const who = await member(event);
      await earn(who, quest, 10);
      await settle(goal);
      const [listed] = await query<{ g: Row[] }>(editor(), "SELECT community_goals($1) AS g", [
        event,
      ]);
      expect(listed?.g).toEqual([
        expect.objectContaining({
          id: goal,
          status: "reached",
          progress: 10,
          started: true,
          steps: [
            expect.objectContaining({
              threshold: 5,
              reward: "nothing",
              due: 0,
              reachedAt: expect.any(String),
            }),
            expect.objectContaining({
              threshold: 10,
              isGoal: true,
              points: 20,
              due: 1,
              paid: 0,
              skipped: 0,
            }),
          ],
        }),
      ]);
      expect(await refusal(query(teamB(), "SELECT community_goals($1)", [event]))).toBe("AN404");
      expect(await refusal(query(teamB(), "SELECT * FROM community_paying($1)", [event]))).toBe(
        "AN404",
      );
      expect(await query(teamA(), "SELECT * FROM community_paying($1)", [event])).toEqual([
        { goals: "1", due: "1" },
      ]);
    });

    it("takes a start up to 60 s in the past as now", async () => {
      const event = await newEvent();
      const goal = await save(
        event,
        body({ startsAt: new Date(Date.now() - 30_000).toISOString() }),
      );
      const [row] = await owner<{ late: boolean }>(
        "SELECT starts_at >= now() - interval '5 seconds' AS late FROM community_goal WHERE id = $1",
        [goal],
      );
      expect(row?.late).toBe(true);
    });

    it("locks a started goal but its texts, and keeps it from being deleted", async () => {
      const event = await newEvent();
      const made = body({
        milestones: [{ threshold: 50, reward: { kind: "moment", moment: { en: "Drums" } } }],
      });
      const goal = await save(event, made);
      const [row] = await owner<{ starts_at: Date; ends_at: Date }>(
        "SELECT starts_at, ends_at FROM community_goal WHERE id = $1",
        [goal],
      );
      const same = {
        ...made,
        startsAt: row?.starts_at.toISOString(),
        endsAt: row?.ends_at.toISOString(),
      };
      expect(await refusal(save(event, { ...same, target: 300 }, goal))).toBe(
        "GL409:goal_locked:target",
      );
      expect(await refusal(save(event, { ...same, paidTo: "everyone" }, goal))).toBe(
        "GL409:goal_locked:paidTo",
      );
      expect(
        await refusal(
          save(
            event,
            {
              ...same,
              milestones: [{ threshold: 60, reward: { kind: "moment", moment: { en: "Drums" } } }],
            },
            goal,
          ),
        ),
      ).toBe("GL409:goal_locked:steps");
      await save(
        event,
        {
          ...same,
          title: { en: "Light it up" },
          milestones: [{ threshold: 50, reward: { kind: "moment", moment: { en: "Big drums" } } }],
        },
        goal,
      );
      expect(
        await owner(
          "SELECT g.title_en, s.moment_en FROM community_goal g JOIN community_step s ON s.goal_id = g.id WHERE g.id = $1 AND NOT s.is_goal",
          [goal],
        ),
      ).toEqual([{ title_en: "Light it up", moment_en: "Big drums" }]);
      expect(
        await refusal(
          query(teamA(), "SELECT delete_community_goal($1, $2, $3)", [event, goal, randomUUID()]),
        ),
      ).toBe("GL409:goal_started");
    });

    it("refuses a new goal once the event ended or its results exist (CTO 5)", async () => {
      const ended = await newEvent("ended", "3 hours", "-1 hour");
      expect(await refusal(save(ended, body()))).toBe("GL409:event_ended");
      const final = await newEvent();
      await owner("INSERT INTO event_result (event_id, organizer_id) VALUES ($1, $2)", [
        final,
        ids.orgA,
      ]);
      expect(await refusal(save(final, body()))).toBe("GL409:event_ended");
    });

    it("keeps a counted quest and category from being deleted, and deletes a draft event with its goals", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, category);
      await save(event, body({ measure: "completions", questId: quest, target: 10 }));
      expect(await refusal(owner("DELETE FROM quest WHERE id = $1", [quest]))).toMatch(/^23503/);
      const draft = await newEvent("draft");
      const draftCategory = await newCategory(draft);
      const draftQuest = await newQuest(draft, draftCategory);
      await save(draft, body({ measure: "players", questId: draftQuest, target: 10 }));
      await save(
        draft,
        body({
          measure: "completions",
          categoryId: draftCategory,
          target: 10,
          startsAt: new Date(Date.now() + 7_200_000).toISOString(),
          endsAt: new Date(Date.now() + 9_000_000).toISOString(),
        }),
      );
      await owner("DELETE FROM event WHERE id = $1", [draft]);
      expect(await owner("SELECT 1 FROM community_goal WHERE event_id = $1", [draft])).toEqual([]);
    });
  });

  describe("the switches (ADR-226)", () => {
    it("finishes running and scheduled goals when the event switch turns off; one saved while off never starts", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const reached = await goalIn(
        event,
        { target: 10, milestones: [] },
        "50 minutes",
        "-40 minutes",
      );
      await owner("UPDATE community_goal SET ends_at = now() + interval '1 hour' WHERE id = $1", [
        reached,
      ]);
      const who = await member(event);
      await earn(who, quest, 10, "3 seconds");
      expect(await settle(reached)).toBe("reached");
      const off = await newEvent();
      const offQuest = await newQuest(off);
      const running = await goalIn(off, { target: 1000 });
      const offWho = await member(off);
      await earn(offWho, offQuest, 10);
      await settle(running);
      const scheduled = await save(
        off,
        body({
          startsAt: new Date(Date.now() + 7_200_000).toISOString(),
          endsAt: new Date(Date.now() + 9_000_000).toISOString(),
        }),
      );
      for (const target of [event, off]) {
        await owner(
          `UPDATE event SET config = config || '{"features": {"community": false}}' WHERE id = $1`,
          [target],
        );
      }
      expect(await state(reached)).toMatchObject({ status: "reached", final_at: expect.any(Date) });
      expect(await state(running)).toMatchObject({ status: "missed", final_at: expect.any(Date) });
      // T-306c (CTO code review 3): a scheduled goal ends missed too, so its unlocks never wait on a start.
      expect(await state(scheduled)).toMatchObject({
        status: "missed",
        final_at: expect.any(Date),
      });
      const later = await save(
        off,
        body({
          startsAt: new Date(Date.now() + 10_000_000).toISOString(),
          endsAt: new Date(Date.now() + 12_000_000).toISOString(),
        }),
      );
      await owner(
        "UPDATE community_goal SET starts_at = now() - interval '1 minute' WHERE id = $1",
        [later],
      );
      expect(await settle(later)).toBe("scheduled");
      expect(await settle(later, false)).toBe("scheduled");
      await owner(
        "UPDATE community_goal SET ends_at = now() - interval '1 second', starts_at = now() - interval '2 minutes' WHERE id = $1",
        [later],
      );
      expect(await settle(later)).toBe("missed");
      expect(await paidTo(reached)).toEqual([who.enrollment]);
    });

    it("does not start a goal while the platform switch is off (may_start false)", async () => {
      const event = await newEvent();
      const goal = await goalIn(event);
      expect(await settle(goal, false)).toBe("scheduled");
      expect(await settle(goal, true)).toBe("running");
    });
  });

  describe("results wait for the payer, and the owner's settle (CTO 5)", () => {
    it("refuses results while a goal is not final or a reward is due, then confirms", async () => {
      const event = await newEvent("live", "3 hours", "2 hours");
      const quest = await newQuest(event);
      const goal = await goalIn(event, { target: 10 }, "2 hours", "30 minutes");
      const who = await member(event);
      await earn(who, quest, 15, "1 hour");
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 second' WHERE id = $1",
        [event],
      );
      expect(await refusal(confirm(event))).toBe('RF409:community_paying:{"due": 0, "goals": 1}');
      expect(await refusal(settleNow(event, editor()))).toBe("CO403");
      expect(await settleNow(event)).toEqual([{ n: 1 }]);
      expect((await state(goal)).final_at).not.toBeNull();
      expect(await refusal(confirm(event))).toBe('RF409:community_paying:{"due": 1, "goals": 0}');
      await pay(event);
      expect(await confirm(event)).toEqual([{ outcome: "confirmed" }]);
    });

    it("answers community_settling while a transaction from the window is open, and settles once it ends", async () => {
      const event = await newEvent();
      const goal = await goalIn(event, { target: 10 }, "30 minutes", "1 hour");
      const open: PoolClient = await pool.connect();
      try {
        await open.query("BEGIN");
        await open.query("SELECT 1");
        await owner("UPDATE community_goal SET ends_at = clock_timestamp() WHERE id = $1", [goal]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await refusal(settleNow(event))).toBe("CS409:community_settling");
        await open.query("COMMIT");
      } finally {
        open.release();
      }
      expect(await settleNow(event)).toEqual([{ n: 1 }]);
      expect(await state(goal)).toMatchObject({ status: "missed", final_at: expect.any(Date) });
      expect(await refusal(settleNow(await newEvent(), teamB()))).toBe("AN404");
    });
  });

  describe("the live card (FR-250)", () => {
    it("shows the running goal with the member's own steps, and nothing to a stranger or with the switch off", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await goalIn(event, {
        target: 100,
        milestones: [{ threshold: 10, reward: { kind: "points", points: 3 } }],
      });
      const [who, idle] = [await member(event), await member(event)];
      expect(await live(who.player, event)).toBeNull();
      await earn(who, quest, 15);
      await settle(goal);
      const card = await live(who.player, event);
      expect(card).toMatchObject({
        goalId: goal,
        paidTo: "contributors",
        status: "running",
        progress: 15,
        target: 100,
        contributed: true,
      });
      expect(card?.steps).toEqual([
        {
          threshold: 10,
          isGoal: false,
          reward: { kind: "points", points: 3 },
          reachedAt: expect.any(String),
          mine: "due",
        },
        {
          threshold: 100,
          isGoal: true,
          reward: { kind: "points", points: 20 },
          reachedAt: null,
          mine: null,
        },
      ]);
      expect(await live(idle.player, event)).toMatchObject({ contributed: false });
      expect(await live(ids.playerB, event)).toBeNull();
      expect(
        (await query<{ h: boolean }>(SYSTEM, "SELECT event_has_live($1) AS h", [event]))[0]?.h,
      ).toBe(true);
      await owner(
        `UPDATE event SET config = config || '{"features": {"community": false}}' WHERE id = $1`,
        [event],
      );
      expect(await live(who.player, event)).toBeNull();
    });

    it("keeps a finished goal for 30 minutes, then shows nothing", async () => {
      const event = await newEvent();
      const goal = await goalIn(event, {}, "20 minutes", "1 hour");
      await owner(
        "UPDATE community_goal SET ends_at = now() - interval '5 minutes' WHERE id = $1",
        [goal],
      );
      await settle(goal);
      const who = await member(event);
      expect((await live(who.player, event))?.status).toBe("missed");
      await owner(
        "UPDATE community_goal SET final_at = now() - interval '31 minutes' WHERE id = $1",
        [goal],
      );
      expect(await live(who.player, event)).toBeNull();
      expect(
        (await query<{ h: boolean }>(SYSTEM, "SELECT event_has_live($1) AS h", [event]))[0]?.h,
      ).toBe(false);
    });
  });
});
