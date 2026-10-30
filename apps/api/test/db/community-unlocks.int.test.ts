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
type Member = Readonly<{ player: string; enrollment: string }>;
type Target = Readonly<{ kind: "quest" | "category" | "reward"; id: string }>;
type Note = Readonly<{ goalId: string; measure: string; threshold: number; state: string }>;
type Listed = Readonly<{
  quest_id: string;
  lock: string | null;
  community_lock: Note | null;
  category_community_lock: Note | null;
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
const text = (en: string) => ({ en });
const OPTIONS = [
  { id: "a", text: text("Robots") },
  { id: "b", text: text("Space") },
];
const QUIZ = {
  questions: [
    {
      id: "q1",
      text: text("Question"),
      choices: [
        { id: "r", text: text("Right") },
        { id: "w", text: text("Wrong") },
      ],
      right: "r",
    },
  ],
  timerSeconds: null,
};
const SURVEY = {
  questions: [{ id: "stars", text: text("How was it?"), kind: "rating", required: true }],
};
const SHARE = { message: { en: "I am at Tower Fest!" }, link: "https://example.com/fest" };
const GAME = { game: "memory_match", level: "easy", attempts: 3, cooldownMinutes: null };
const PASS = { pairs: 6, moves: 9, ms: 30_000, lucky: 0 };
const SPOT = { lat: 24.7136, lng: 46.6753 };
const READING = { lat: SPOT.lat, lng: SPOT.lng, accuracyM: 10, ageS: 5 };
const GUIDELINES = "1.0";
/** The repeat cap each type takes; the played-once types take 1. */
const REPEATS: Readonly<Record<string, number>> = {
  scan_qr: 100,
  enter_code: 100,
  location: 100,
  meet: 10,
};

const body = (over: Row = {}): Row => ({
  title: { en: "Light the tower", ar: "أضيئوا البرج" },
  measure: "points",
  target: 5,
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 3_600_000).toISOString(),
  paidTo: "contributors",
  reward: { kind: "nothing" },
  milestones: [],
  ...over,
});
const unlock = (target: Target) => ({ kind: "unlock", target });
const noop = (): void => undefined;
/** A window starting `hours` from now, 10 minutes long. */
const windowIn = (hours: number) => ({
  startsAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
  endsAt: new Date(Date.now() + hours * 3_600_000 + 600_000).toISOString(),
});

/**
 * Unlock rewards in the database (T-306c, migration 0054, ADR-227 to ADR-229): every door refuses a community-locked
 * quest or reward until its step is reached, every reader shows it locked or serves nothing, the builder's target
 * rules, missed and switched-off goals, the category rules around a missed lock, the rehearsal, the bar's marker, the
 * gate's index use and the completeness check over every function the API may run.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("community unlocks (database)", () => {
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

  const newEvent = async (
    status = "live",
    organizer = ids.orgA,
    startsIn = "-2 hours",
    endsIn = "1 day",
  ) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Tower Fest', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [organizer, `CUL${counter}`, status, startsIn, endsIn],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string, fields: Row = {}) => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stage') RETURNING id",
      [event],
    );
    for (const [column, value] of Object.entries(fields)) {
      await owner(`UPDATE category SET ${column} = $2 WHERE id = $1`, [category?.id, value]);
    }
    return category?.id ?? "";
  };
  type QuestFields = Readonly<{
    category?: string;
    type?: string;
    config?: object;
    points?: number;
    position?: number;
    verification?: string[];
    visible?: boolean;
  }>;
  /** A quest; a passport comes with its one step, written in the same statement as the builder's transaction. */
  const newQuest = async (event: string, fields: QuestFields = {}) => {
    const type = fields.type ?? "scan_qr";
    const [quest] = await owner<{ id: string }>(
      `WITH q AS (
         INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position,
                            verification, visible, place_lat, place_lng, place_radius_m)
         VALUES ($1, $2, $3, 'Tower', $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, type
       ), s AS (
         INSERT INTO passport_step (event_id, quest_id, name_en, position)
         SELECT $1, q.id, 'Booth', 0 FROM q WHERE q.type = 'passport' RETURNING id
       )
       SELECT id FROM q`,
      [
        event,
        fields.category ?? (await newCategory(event)),
        type,
        fields.points ?? 10,
        REPEATS[type] ?? 1,
        JSON.stringify(fields.config ?? {}),
        fields.position ?? 0,
        fields.verification ?? null,
        fields.visible ?? true,
        type === "location" ? SPOT.lat : null,
        type === "location" ? SPOT.lng : null,
        type === "location" ? 50 : null,
      ],
    );
    return quest?.id ?? "";
  };
  const newReward = async (event: string, fields: Row = {}) => {
    counter += 1;
    const [reward] = await owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', $2, 1, 5) RETURNING id",
      [event, `Lantern ${counter}`],
    );
    for (const [column, value] of Object.entries(fields)) {
      await owner(`UPDATE reward SET ${column} = $2 WHERE id = $1`, [reward?.id, value]);
    }
    return reward?.id ?? "";
  };
  const member = async (event: string, via = "code", organizer = ids.orgA): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`cu_player_${counter}`],
    );
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
      [player?.id, GUIDELINES],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizer, event, player?.id, via],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id)
       VALUES ($1, $2, $3, 'welcome', 10, 10, 'system', NULL)`,
      [organizer, event, made?.id],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const operator = async (event: string, abilities: string[]) => {
    const who = await member(event);
    await owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
       VALUES ($1, $2, $3, $4, true)`,
      [ids.orgA, event, who.player, abilities],
    );
    return who;
  };

  const save = async (event: string, made: Row, goal: string | null = null, team = teamA()) =>
    (
      await query<{ id: string }>(team, "SELECT save_community_goal($1, $2, $3, $4) AS id", [
        event,
        goal,
        JSON.stringify(made),
        randomUUID(),
      ])
    )[0]?.id ?? "";
  /** A goal whose goal step unlocks `target`, started now (or at `startsAt`). */
  const lockWith = (event: string, target: Target, over: Row = {}) =>
    save(event, body({ reward: unlock(target), ...over }));
  const settleOnce = async (goal: string, mayStart = true) =>
    (await query<{ s: string }>(SYSTEM, "SELECT settle_goal($1, $2) AS s", [goal, mayStart]))[0]?.s;
  const goalOf = async (goal: string) =>
    (
      await owner<{ status: string; final_at: Date | null; settled_until: Date | null }>(
        "SELECT status, final_at, settled_until FROM community_goal WHERE id = $1",
        [goal],
      )
    )[0];
  /**
   * Backdates a goal not yet settled so a settle can read its window, and gives the community `points` inside what
   * the next settle reads (5 minutes ago, or just after the last settle point).
   */
  const backdate = async (event: string, goal: string, points: number) => {
    await owner(
      `UPDATE community_goal SET starts_at = date_trunc('milliseconds', now() - interval '10 minutes')
       WHERE id = $1 AND settled_until IS NULL`,
      [goal],
    );
    if (points > 0) {
      const giver = await member(event);
      const category = await newCategory(event);
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   category_id, bonus_period, created_at)
         SELECT n.organizer_id, n.event_id, n.id, 'bonus', $2, $2, 'system', $3, '-infinity',
                coalesce(g.settled_until + interval '1 millisecond', now() - interval '5 minutes')
         FROM enrollment n, community_goal g WHERE n.id = $1 AND g.id = $4`,
        [giver.enrollment, points, category, goal],
      );
    }
  };
  /** The community reaches every step of the goal (its target is 5): a real settle, as the tick runs it. */
  const reach = async (event: string, goal: string, mayStart = true) => {
    await backdate(event, goal, 10);
    expect(await settleOnce(goal, mayStart)).toBe("reached");
  };
  /** The goal's window ends with nothing earned: it is missed. */
  const miss = async (event: string, goal: string) => {
    await backdate(event, goal, 0);
    await owner(
      `UPDATE community_goal SET ends_at = date_trunc('milliseconds', now() - interval '1 minute') WHERE id = $1`,
      [goal],
    );
    for (let tick = 0; tick < 3 && (await goalOf(goal))?.final_at === null; tick += 1) {
      await settleOnce(goal);
    }
    expect((await goalOf(goal))?.status).toBe("missed");
  };
  const stepOf = async (goal: string) =>
    (
      await owner<{ id: string }>(
        "SELECT id FROM community_step WHERE goal_id = $1 AND reward = 'unlock' ORDER BY threshold LIMIT 1",
        [goal],
      )
    )[0]?.id ?? "";
  const listed = async (player: string, event: string) =>
    query<Listed>(
      as(player),
      "SELECT quest_id, lock, community_lock, category_community_lock FROM member_event_quests($1)",
      [event],
    );
  const lockOf = async (player: string, event: string, quest: string) =>
    (await listed(player, event)).find((row) => row.quest_id === quest);
  const complete = (player: string, quest: string, key = randomUUID()) =>
    query(as(player), "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [quest, key]);
  const staffAward = (event: string, who: Member, quest: string) =>
    query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
      event,
      who.enrollment,
      quest,
      randomUUID(),
      randomUUID(),
    ]);
  const reserve = (player: string, reward: string, key = randomUUID()) =>
    query<{ redemption_id: string; replayed: boolean }>(
      as(player),
      "SELECT * FROM reserve_reward($1, $2)",
      [reward, key],
    );
  const live = async (player: string, event: string) =>
    (
      await query<{ s: { closed: { questId: string }[]; community: Row | null } }>(
        as(player),
        "SELECT live_state($1) AS s",
        [event],
      )
    )[0]?.s;

  const markerOf = async (player: string, event: string) => {
    const community = (await live(player, event))?.community as
      | { steps: { reward: { kind: string; target?: Row } }[] }
      | null
      | undefined;
    return community?.steps.find((step) => step.reward.kind === "unlock")?.reward;
  };
  const running = async (event: string, target: Target) => {
    const goal = await lockWith(event, target);
    await backdate(event, goal, 0);
    await settleOnce(goal);
    return goal;
  };
  /** Runs `sql` in its own transaction and holds it open until released. */
  const hold = async (context: RequestContext, sql: string, values: unknown[]) => {
    const client = await pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const done = withRequestContext(client, context, async () => {
      const rows = (await client.query(sql, values)).rows;
      ran();
      await gate;
      return rows;
    }).finally(() => client.release());
    await Promise.race([started, done]);
    return { release, done };
  };
  /** Waits until a backend running `fragment` is waiting on a lock. */
  const waitsOnLock = async (fragment: string) => {
    for (let tries = 0; tries < 100; tries += 1) {
      const rows = await owner(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (rows.length > 0) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  // ============================================================ the door table
  type DoorContext = {
    event: string;
    category: string;
    quest: string;
    who: Member;
    extra: Record<string, string | Buffer>;
  };
  type Door = Readonly<{
    name: string;
    type: string;
    config?: object;
    verification?: string[];
    visible?: boolean;
    /** Work done before the lock appears (a quiz or game started, a poll sent, a code shown). */
    before?: (context: DoorContext) => Promise<void>;
    run: (context: DoorContext) => Promise<unknown>;
    /** What the door answers while locked ("none" when it passes the lock). */
    locked?: string;
    /** Which locks to try: the quest's own, its category's (a live poll can only be locked by its category). */
    by?: readonly ("quest" | "category")[];
  }>;
  const vote = (player: string, quest: string) =>
    query(as(player), "SELECT * FROM vote_quest($1, $2, $3)", [quest, ["a"], randomUUID()]);
  const DOORS: readonly Door[] = [
    { name: "scan", type: "scan_qr", run: (c) => complete(c.who.player, c.quest) },
    {
      name: "typed code",
      type: "enter_code",
      config: { code: "TOWER" },
      run: (c) =>
        query(
          as(c.who.player),
          "SELECT * FROM complete_quest($1, 'code', NULL, 'TOWER', $2, NULL)",
          [c.quest, randomUUID()],
        ),
    },
    {
      name: "location",
      type: "location",
      run: (c) =>
        query(
          as(c.who.player),
          "SELECT * FROM complete_quest($1, 'location', NULL, NULL, $2, NULL, $3)",
          [c.quest, randomUUID(), JSON.stringify(READING)],
        ),
    },
    {
      name: "operator scan",
      type: "scan_qr",
      verification: ["my_qr"],
      before: async (c) => {
        c.extra["operator"] = (await operator(c.event, ["scan_quests"])).player;
      },
      run: (c) =>
        query(
          as(String(c.extra["operator"])),
          "SELECT * FROM operator_complete_quest($1, $2, 1, $3)",
          [c.quest, c.who.player, randomUUID()],
        ),
    },
    {
      name: "owner's manual award",
      type: "scan_qr",
      run: (c) => staffAward(c.event, c.who, c.quest),
      locked: "none",
    },
    {
      name: "operator's award",
      type: "scan_qr",
      before: async (c) => {
        c.extra["operator"] = (await operator(c.event, ["award"])).player;
      },
      run: (c) =>
        query(
          as(String(c.extra["operator"])),
          "SELECT * FROM operator_award($1, $2, $3, NULL, 'Code failed', $4)",
          [c.event, c.who.enrollment, c.quest, randomUUID()],
        ),
    },
    {
      name: "vote",
      type: "vote",
      config: { options: OPTIONS },
      run: (c) => vote(c.who.player, c.quest),
    },
    {
      name: "live poll vote",
      type: "vote",
      config: { options: OPTIONS, live: { choices: "one", results: "after_vote", minutes: 30 } },
      visible: false,
      before: async (c) => {
        await query(teamA(), "SELECT * FROM send_poll($1, $2, $3)", [
          c.event,
          c.quest,
          randomUUID(),
        ]);
      },
      run: (c) => vote(c.who.player, c.quest),
      by: ["category"],
    },
    {
      name: "quiz start",
      type: "quiz",
      config: QUIZ,
      run: (c) => query(as(c.who.player), "SELECT quiz_start($1)", [c.quest]),
    },
    {
      name: "quiz answer",
      type: "quiz",
      config: QUIZ,
      before: async (c) => {
        await query(as(c.who.player), "SELECT quiz_start($1)", [c.quest]);
        await query(as(c.who.player), "SELECT quiz_next($1)", [c.quest]);
      },
      run: (c) => query(as(c.who.player), "SELECT quiz_answer($1, 'q1', 'r')", [c.quest]),
    },
    {
      name: "survey",
      type: "survey",
      config: SURVEY,
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM submit_survey($1, $2, $3)", [
          c.quest,
          JSON.stringify({ stars: 4 }),
          randomUUID(),
        ]),
    },
    {
      name: "share",
      type: "share",
      config: SHARE,
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM share_quest($1, $2)", [c.quest, randomUUID()]),
    },
    {
      name: "passport stamp",
      type: "passport",
      config: { needed: 1 },
      verification: [],
      before: async (c) => {
        const [step] = await owner<{ id: string }>(
          "SELECT id FROM passport_step WHERE quest_id = $1",
          [c.quest],
        );
        c.extra["step"] = step?.id ?? "";
      },
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM stamp_step($1, 1, $2, NULL)", [
          c.extra["step"],
          randomUUID(),
        ]),
    },
    {
      name: "submission",
      type: "submission",
      config: { accepts: ["text"], autoApprove: false, resubmit: false },
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM submit_quest($1, 'My answer', $2, $3)", [
          c.quest,
          GUIDELINES,
          randomUUID(),
        ]),
    },
    {
      name: "game start",
      type: "game",
      config: GAME,
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM start_game_round($1, $2, NULL, 1)", [
          c.quest,
          randomUUID(),
        ]),
    },
    {
      name: "game finish",
      type: "game",
      config: GAME,
      before: async (c) => {
        const [round] = await query<{ round_id: string }>(
          as(c.who.player),
          "SELECT * FROM start_game_round($1, $2, NULL, 1)",
          [c.quest, randomUUID()],
        );
        c.extra["round"] = round?.round_id ?? "";
      },
      run: (c) =>
        query(
          as(c.who.player),
          "SELECT * FROM finish_game_round($1, $2, 'passed', $3, NULL, false, 0)",
          [c.extra["round"], randomUUID(), JSON.stringify(PASS)],
        ),
    },
    {
      name: "meet code",
      type: "meet",
      config: { dailyCap: 5 },
      before: async (c) => {
        const shown = await member(c.event);
        const hash = randomBytes(32);
        await query(as(shown.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [
          c.quest,
          hash,
        ]);
        c.extra["hash"] = hash;
      },
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
          c.extra["hash"],
          randomUUID(),
        ]),
    },
    {
      name: "meet pass",
      type: "meet",
      config: { dailyCap: 5 },
      run: (c) =>
        query(as(c.who.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [
          c.quest,
          randomBytes(32),
        ]),
    },
  ];

  describe("the door table: every door refuses a locked quest until the step is reached", () => {
    for (const door of DOORS) {
      for (const by of door.by ?? (["quest", "category"] as const)) {
        it(`${door.name}, locked by its ${by}`, async () => {
          const event = await newEvent();
          const category = await newCategory(event);
          const quest = await newQuest(event, {
            category,
            type: door.type,
            config: door.config ?? {},
            visible: door.visible ?? true,
            ...(door.verification === undefined ? {} : { verification: door.verification }),
          });
          const context: DoorContext = {
            event,
            category,
            quest,
            who: await member(event),
            extra: {},
          };
          await door.before?.(context);
          const goal = await lockWith(
            event,
            by === "quest" ? { kind: "quest", id: quest } : { kind: "category", id: category },
          );
          expect(await refusal(door.run(context))).toBe(door.locked ?? "QN403:community_locked");
          await reach(event, goal);
          expect(await refusal(door.run(context))).toBe("none");
        });
      }
    }

    it("reserve: a locked reward is not open (RW403), in rehearsal too, and reserves after the reach", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "reward", id: reward });
      expect(await refusal(reserve(who.player, reward))).toBe("RW403:community_locked");
      await reach(event, goal);
      expect(await refusal(reserve(who.player, reward))).toBe("none");
    });

    it("a replayed reserve answers its first result, and an earlier redemption is handed over, while locked", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await member(event);
      const key = randomUUID();
      const [made] = await reserve(who.player, reward, key);
      await lockWith(event, { kind: "reward", id: reward });
      expect(await reserve(who.player, reward, key)).toMatchObject([{ replayed: true }]);
      const desk = await operator(event, ["hand_over"]);
      await owner(
        "UPDATE redemption SET collect_until = now() + interval '1 minute' WHERE id = $1",
        [made?.redemption_id],
      );
      expect(
        await refusal(
          query(as(desk.player), "SELECT * FROM desk_hand_over($1)", [made?.redemption_id]),
        ),
      ).toBe("none");
    });

    it("a replayed completion answers its first result while locked", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const key = randomUUID();
      await complete(who.player, quest, key);
      await lockWith(event, { kind: "quest", id: quest });
      expect(await complete(who.player, quest, key)).toMatchObject([{ replayed: true }]);
      expect(await refusal(complete(who.player, quest))).toBe("QN403:community_locked");
    });
  });

  describe("what the player reads while locked (ADR-228)", () => {
    it("lists the quest locked with its note: scheduled, then waiting, gone after the reach", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const later = new Date(Date.now() + 600_000).toISOString();
      const goal = await lockWith(event, { kind: "quest", id: quest }, { startsAt: later });
      expect(await lockOf(who.player, event, quest)).toMatchObject({
        lock: "community_locked",
        community_lock: { goalId: goal, measure: "points", threshold: 5, state: "scheduled" },
        category_community_lock: null,
      });
      expect((await lockOf(who.player, event, quest))?.community_lock).not.toHaveProperty("target");
      await backdate(event, goal, 0);
      await settleOnce(goal);
      expect((await lockOf(who.player, event, quest))?.community_lock?.state).toBe("waiting");
      await reach(event, goal);
      expect(await lockOf(who.player, event, quest)).toMatchObject({
        lock: null,
        community_lock: null,
      });
    });

    it("a category locked as a whole carries its note on each of its quests and as the category's", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const who = await member(event);
      const goal = await lockWith(event, { kind: "category", id: category });
      expect(await lockOf(who.player, event, quest)).toMatchObject({
        lock: "community_locked",
        community_lock: { goalId: goal },
        category_community_lock: { goalId: goal },
      });
    });

    it("the community lock comes before every category rule", async () => {
      const event = await newEvent();
      const first = await newCategory(event);
      await newQuest(event, { category: first });
      const category = await newCategory(event, {
        opens_at: new Date(Date.now() + 3_600_000),
        unlock_after: first,
        order_mode: "in_order",
      });
      await newQuest(event, { category, position: 0 });
      const second = await newQuest(event, { category, position: 1 });
      const who = await member(event);
      expect((await lockOf(who.player, event, second))?.lock).toBe("category_not_started");
      const goal = await lockWith(event, { kind: "quest", id: second });
      expect((await lockOf(who.player, event, second))?.lock).toBe("community_locked");
      await reach(event, goal);
      expect((await lockOf(who.player, event, second))?.lock).toBe("category_not_started");
    });

    it("each quest sheet serves nothing while locked and its content after the reach", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const make = (type: string, config: object, verification?: string[]) =>
        newQuest(event, {
          category,
          type,
          config,
          ...(verification === undefined ? {} : { verification }),
        });
      const sheets = {
        member_vote: await make("vote", { options: OPTIONS }),
        member_quiz: await make("quiz", QUIZ),
        member_survey: await make("survey", SURVEY),
        member_share: await make("share", SHARE),
        member_passport: await make("passport", { needed: 1 }, []),
      };
      const game = await make("game", GAME);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "category", id: category });
      for (const [reader, quest] of Object.entries(sheets)) {
        const rows = await query<{ v: unknown }>(as(who.player), `SELECT ${reader}($1) AS v`, [
          quest,
        ]);
        expect(
          rows.filter((row) => row.v !== null),
          reader,
        ).toEqual([]);
      }
      expect(await refusal(query(as(who.player), "SELECT * FROM member_game($1)", [game]))).toBe(
        "QN403:community_locked",
      );
      await reach(event, goal);
      for (const [reader, quest] of Object.entries(sheets)) {
        const rows = await query<{ v: unknown }>(as(who.player), `SELECT ${reader}($1) AS v`, [
          quest,
        ]);
        expect(rows.filter((row) => row.v !== null).length, reader).toBeGreaterThan(0);
      }
      expect(await query(as(who.player), "SELECT * FROM member_game($1)", [game])).toHaveLength(1);
    });

    it("a live poll in a locked category is neither offered, its results shown nor sent (CTO 7)", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const config = {
        options: OPTIONS,
        live: { choices: "one", results: "at_close", minutes: 5 },
      };
      const open = await newQuest(event, { category, type: "vote", config, visible: false });
      const closed = await newQuest(event, { category, type: "vote", config, visible: false });
      const draft = await newQuest(event, { category, type: "vote", config, visible: false });
      const send = (quest: string) =>
        query(teamA(), "SELECT * FROM send_poll($1, $2, $3)", [event, quest, randomUUID()]);
      await send(open);
      await send(closed);
      await owner(
        "UPDATE quest SET opens_at = now() - interval '5 minutes', closes_at = now() - interval '1 minute' WHERE id = $1",
        [closed],
      );
      const who = await member(event);
      expect((await live(who.player, event))?.closed).toEqual([{ questId: closed }]);
      const goal = await lockWith(event, { kind: "category", id: category });
      const locked = await live(who.player, event);
      expect(locked).toMatchObject({ polls: [], closed: [] });
      expect(await query(as(who.player), "SELECT * FROM member_poll($1)", [open])).toEqual([]);
      expect(await refusal(send(draft))).toBe("PL409:community_locked");
      await reach(event, goal);
      expect((await live(who.player, event))?.closed).toEqual([{ questId: closed }]);
      expect(await refusal(send(draft))).toBe("none");
    });

    it("the public page leaves a locked quest out and lists it after the reach", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET access = 'public' WHERE id = $1", [event]);
      const quest = await newQuest(event);
      const [{ join_code: code } = { join_code: "" }] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      const listedPublic = async () =>
        (
          await query<{ quest_id: string }>(
            SYSTEM,
            "SELECT quest_id FROM public_event_quests($1)",
            [code],
          )
        ).map((row) => row.quest_id);
      expect(await listedPublic()).toEqual([quest]);
      const goal = await lockWith(event, { kind: "quest", id: quest });
      expect(await listedPublic()).toEqual([]);
      await reach(event, goal);
      expect(await listedPublic()).toEqual([quest]);
    });

    it("the shop lists a locked reward with its note, may pin it, and drops the note after the reach (CTO 8)", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "reward", id: reward });
      const shop = async () =>
        (
          await query<{ id: string; community_lock: Note | null }>(
            as(who.player),
            "SELECT id, community_lock FROM shop_rewards($1)",
            [event],
          )
        )[0];
      expect(await shop()).toMatchObject({
        id: reward,
        community_lock: { goalId: goal, state: "scheduled" },
      });
      expect(await query(as(who.player), "SELECT set_goal($1, $2) AS v", [event, reward])).toEqual([
        { v: reward },
      ]);
      await reach(event, goal);
      expect(await shop()).toMatchObject({ id: reward, community_lock: null });
    });

    it("operators are not offered a locked quest to award (CTO 1)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const op = await operator(event, ["award"]);
      const offered = async () =>
        (
          await query<{ quest_id: string }>(
            as(op.player),
            "SELECT quest_id FROM operator_award_quests($1)",
            [event],
          )
        ).map((row) => row.quest_id);
      const goal = await lockWith(event, { kind: "quest", id: quest });
      expect(await offered()).toEqual([]);
      await reach(event, goal);
      expect(await offered()).toEqual([quest]);
    });

    it("revealing a hidden locked category shows it, locked", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { hidden: true });
      const quest = await newQuest(event, { category });
      const who = await member(event);
      await lockWith(event, { kind: "category", id: category });
      expect(await lockOf(who.player, event, quest)).toBeUndefined();
      await query(as(who.player), "SELECT * FROM reveal_category($1, 1)", [category]);
      expect((await lockOf(who.player, event, quest))?.lock).toBe("community_locked");
    });
  });

  describe("the bar's marker names only what the player sees (ADR-228)", () => {
    it("names a seen quest, category or reward, and keeps a hidden category, another audience and a removed reward a surprise", async () => {
      const event = await newEvent();
      const who = await member(event);
      const seen = await newCategory(event);
      await running(event, { kind: "category", id: seen });
      expect(await markerOf(who.player, event)).toEqual({
        kind: "unlock",
        target: { kind: "category", id: seen, name: { en: "Stage" } },
      });

      const hiddenEvent = await newEvent();
      const hiddenWho = await member(hiddenEvent);
      const hidden = await newCategory(hiddenEvent, { hidden: true });
      await running(hiddenEvent, { kind: "category", id: hidden });
      expect(await markerOf(hiddenWho.player, hiddenEvent)).toEqual({ kind: "unlock" });
      await query(as(hiddenWho.player), "SELECT * FROM reveal_category($1, 1)", [hidden]);
      expect((await markerOf(hiddenWho.player, hiddenEvent))?.target).toMatchObject({ id: hidden });

      const rewardEvent = await newEvent();
      const rewardWho = await member(rewardEvent);
      const reward = await newReward(rewardEvent, {
        audience_kind: "tag",
        audience_values: ["vip"],
      });
      await running(rewardEvent, { kind: "reward", id: reward });
      expect(await markerOf(rewardWho.player, rewardEvent)).toEqual({ kind: "unlock" });

      const removedEvent = await newEvent();
      const removedWho = await member(removedEvent);
      const removed = await newReward(removedEvent);
      await running(removedEvent, { kind: "reward", id: removed });
      expect((await markerOf(removedWho.player, removedEvent))?.target).toMatchObject({
        kind: "reward",
      });
      await owner("UPDATE reward SET status = 'removed' WHERE id = $1", [removed]);
      expect(await markerOf(removedWho.player, removedEvent)).toEqual({ kind: "unlock" });

      const questEvent = await newEvent();
      const questWho = await member(questEvent);
      const quest = await newQuest(questEvent);
      await running(questEvent, { kind: "quest", id: quest });
      expect((await markerOf(questWho.player, questEvent))?.target).toMatchObject({
        kind: "quest",
        id: quest,
      });
    });
  });

  describe("the builder's target rules (ADR-227)", () => {
    it("refuses another event's or organizer's item, a live poll and a removed reward (unlock_target)", async () => {
      const event = await newEvent();
      const elsewhere = await newEvent();
      const foreign = await newEvent("live", ids.orgB);
      const poll = await newQuest(event, {
        type: "vote",
        config: { options: OPTIONS, live: { choices: "one", results: "after_vote", minutes: 5 } },
        visible: false,
      });
      const removed = await newReward(event, { status: "removed" });
      for (const target of [
        { kind: "quest", id: await newQuest(elsewhere) },
        { kind: "quest", id: await newQuest(foreign) },
        { kind: "category", id: await newCategory(foreign) },
        { kind: "reward", id: await newReward(foreign) },
        { kind: "quest", id: poll },
        { kind: "reward", id: removed },
        { kind: "quest", id: randomUUID() },
      ] as const) {
        expect(await refusal(lockWith(event, target)), target.kind).toBe(
          "CG422:unlock:unlock_target",
        );
      }
      expect(
        await refusal(
          save(
            event,
            body({ reward: { kind: "unlock", target: { kind: "x", id: randomUUID() } } }),
          ),
        ),
      ).toBe("CG422:unlock:unlock_target");
    });

    it("refuses what the goal counts: its quest, its category, or its quest's category (unlock_counted, CTO 4)", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const sibling = await newQuest(event, { category });
      const counted = { measure: "completions" };
      expect(
        await refusal(
          lockWith(event, { kind: "quest", id: quest }, { ...counted, questId: quest }),
        ),
      ).toBe("CG422:unlock:unlock_counted");
      expect(
        await refusal(
          lockWith(event, { kind: "category", id: category }, { ...counted, questId: quest }),
        ),
      ).toBe("CG422:unlock:unlock_counted");
      expect(
        await refusal(
          lockWith(event, { kind: "category", id: category }, { ...counted, categoryId: category }),
        ),
      ).toBe("CG422:unlock:unlock_counted");
      expect(
        await refusal(
          lockWith(event, { kind: "quest", id: sibling }, { ...counted, categoryId: category }),
        ),
      ).toBe("none");
    });

    it("locks a target once: twice in one goal, across goals and after a reach (unlock_taken)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const target = { kind: "quest", id: quest } as const;
      expect(
        await refusal(
          save(
            event,
            body({
              target: 10,
              reward: unlock(target),
              milestones: [{ threshold: 5, reward: unlock(target) }],
            }),
          ),
        ),
      ).toBe("GL409:unlock_taken");
      const later = Date.now() + 7_200_000;
      const goal = await lockWith(event, target, {
        startsAt: new Date(later).toISOString(),
        endsAt: new Date(later + 600_000).toISOString(),
      });
      expect(await refusal(lockWith(event, target))).toBe("GL409:unlock_taken");
      expect(
        await refusal(
          save(
            event,
            body({
              reward: unlock(target),
              startsAt: new Date(later).toISOString(),
              endsAt: new Date(later + 600_000).toISOString(),
            }),
            goal,
          ),
        ),
      ).toBe("none");
      await query(teamA(), "SELECT delete_community_goal($1, $2, $3)", [event, goal, randomUUID()]);
      const again = await lockWith(event, target);
      await reach(event, again);
      const after = new Date(Date.now() + 7_200_000);
      expect(
        await refusal(
          lockWith(event, target, {
            startsAt: after.toISOString(),
            endsAt: new Date(after.getTime() + 600_000).toISOString(),
          }),
        ),
      ).toBe("GL409:unlock_taken");
    });

    it("keeps a started goal's unlock (goal_locked steps) and frees the target when a goal is deleted before its start", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "quest", id: quest });
      const [stored] = await owner<{ starts_at: Date; ends_at: Date }>(
        "SELECT starts_at, ends_at FROM community_goal WHERE id = $1",
        [goal],
      );
      const kept = {
        startsAt: stored?.starts_at.toISOString(),
        endsAt: stored?.ends_at.toISOString(),
      };
      expect(
        await refusal(
          save(event, body({ reward: unlock({ kind: "quest", id: other }), ...kept }), goal),
        ),
      ).toBe("GL409:goal_locked:steps");

      const later = Date.now() + 7_200_000;
      const window = {
        startsAt: new Date(later).toISOString(),
        endsAt: new Date(later + 600_000).toISOString(),
      };
      const scheduled = await lockWith(event, { kind: "quest", id: other }, window);
      expect((await lockOf(who.player, event, other))?.lock).toBe("community_locked");
      await query(teamA(), "SELECT delete_community_goal($1, $2, $3)", [
        event,
        scheduled,
        randomUUID(),
      ]);
      expect((await lockOf(who.player, event, other))?.lock).toBeNull();
    });

    it("lists each step's target for the team, and a target named by a step cannot be deleted", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const reward = await newReward(event);
      await save(
        event,
        body({
          target: 30,
          reward: unlock({ kind: "reward", id: reward }),
          milestones: [
            { threshold: 10, reward: unlock({ kind: "quest", id: quest }) },
            { threshold: 20, reward: unlock({ kind: "category", id: category }) },
          ],
        }),
      );
      const [{ goals } = { goals: [] }] = await query<{ goals: { steps: Row[] }[] }>(
        teamA(),
        "SELECT community_goals($1) AS goals",
        [event],
      );
      expect(goals[0]?.steps.map((step) => step["unlock"])).toEqual([
        { kind: "quest", id: quest, name: { en: "Tower", ar: null } },
        { kind: "category", id: category, name: { en: "Stage", ar: null } },
        { kind: "reward", id: reward, name: { en: expect.stringMatching(/^Lantern/), ar: null } },
      ]);
      expect(await refusal(owner("DELETE FROM quest WHERE id = $1", [quest]))).toMatch(/^23503/);
      expect(await refusal(owner("DELETE FROM category WHERE id = $1", [category]))).toMatch(
        /^23503/,
      );
      expect(await refusal(owner("DELETE FROM reward WHERE id = $1", [reward]))).toMatch(/^23503/);
    });

    it("deletes a draft event holding an unlock goal and a counted quest (its goals go first)", async () => {
      const event = await newEvent("draft", ids.orgA, "1 day", "2 days");
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const counted = await newQuest(event, { category: await newCategory(event) });
      const start = new Date(Date.now() + 90_000_000);
      await save(
        event,
        body({
          measure: "completions",
          questId: counted,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 600_000).toISOString(),
          reward: unlock({ kind: "quest", id: quest }),
        }),
      );
      expect(
        await query(teamA(), "DELETE FROM event WHERE organizer_id = $1 AND id = $2 RETURNING id", [
          ids.orgA,
          event,
        ]),
      ).toEqual([{ id: event }]);
      expect(await owner("SELECT 1 FROM community_goal WHERE event_id = $1", [event])).toEqual([]);
    });

    it("keeps organizer B's ids out of organizer A's goal (cross-tenant: unlock_target, never a key error)", async () => {
      const event = await newEvent();
      const foreignEvent = await newEvent("live", ids.orgB);
      const foreign = await newQuest(foreignEvent);
      expect(await refusal(lockWith(event, { kind: "quest", id: foreign }))).toBe(
        "CG422:unlock:unlock_target",
      );
      expect(
        await refusal(
          save(
            foreignEvent,
            body({ reward: unlock({ kind: "quest", id: foreign }) }),
            null,
            teamA(),
          ),
        ),
      ).toBe("AN404");
      expect(
        await refusal(
          save(
            foreignEvent,
            body({ reward: unlock({ kind: "quest", id: foreign }) }),
            null,
            teamB(),
          ),
        ),
      ).toBe("none");
    });
  });

  describe("goals never hold each other back (CTO code review 1)", () => {
    it("refuses an unlock of what another goal not yet final counts, by quest, category or its quest's category", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await save(event, body({ measure: "completions", questId: quest, ...windowIn(2) }));
      expect(await refusal(lockWith(event, { kind: "quest", id: quest }))).toBe(
        "CG422:unlock:unlock_counted",
      );
      expect(await refusal(lockWith(event, { kind: "category", id: category }))).toBe(
        "CG422:unlock:unlock_counted",
      );
      const other = await newCategory(event);
      await save(event, body({ measure: "players", categoryId: other, ...windowIn(4) }));
      expect(await refusal(lockWith(event, { kind: "category", id: other }))).toBe(
        "CG422:unlock:unlock_counted",
      );
    });

    it("refuses a goal counting what another goal's step still locks, and allows it once that step is reached", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const goal = await lockWith(event, { kind: "category", id: category });
      for (const counted of [{ questId: quest }, { categoryId: category }]) {
        expect(
          await refusal(save(event, body({ measure: "completions", ...counted, ...windowIn(2) }))),
        ).toBe("CG422:unlock:unlock_counted");
      }
      await reach(event, goal);
      expect(
        await refusal(
          save(event, body({ measure: "completions", questId: quest, ...windowIn(2) })),
        ),
      ).toBe("none");
    });

    it("lets a goal unlock what a final goal counted", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const counting = await save(event, body({ measure: "completions", questId: quest }));
      await miss(event, counting);
      expect(await refusal(lockWith(event, { kind: "quest", id: quest }, windowIn(2)))).toBe(
        "none",
      );
    });
  });

  describe("missed, switched off and reached for good (ADR-229)", () => {
    it("a missed step stays locked with state missed", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "quest", id: quest });
      await miss(event, goal);
      expect(await lockOf(who.player, event, quest)).toMatchObject({
        lock: "community_locked",
        community_lock: { state: "missed" },
      });
      expect(await refusal(complete(who.player, quest))).toBe("QN403:community_locked");
    });

    it("counts a milestone left unreached on a goal that ended reached as missed (CTO note 2)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const goal = await save(
        event,
        body({
          target: 10,
          milestones: [{ threshold: 5, reward: unlock({ kind: "quest", id: quest }) }],
        }),
      );
      const step = await stepOf(goal);
      const [goalStep] = await owner<{ id: string }>(
        "SELECT id FROM community_step WHERE goal_id = $1 AND is_goal",
        [goal],
      );
      const missed = async () =>
        (await owner<{ m: boolean }>("SELECT community_lock_missed($1) AS m", [step]))[0]?.m;
      expect(await missed()).toBe(false);
      // The builder's rules make this unreachable (milestones sit below the target); the rule holds anyway.
      await owner(
        "INSERT INTO community_reach (step_id, event_id, reached_at, progress) VALUES ($1, $2, now(), 10)",
        [goalStep?.id, event],
      );
      await owner(
        "UPDATE community_goal SET status = 'reached', settled_until = starts_at, final_at = now() WHERE id = $1",
        [goal],
      );
      expect(await missed()).toBe(true);
      expect(await owner<{ m: boolean }>("SELECT community_lock_missed(NULL) AS m")).toEqual([
        { m: false },
      ]);
    });

    it("the event switch off ends the running goal missed and its unlock stays locked", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "quest", id: quest });
      await backdate(event, goal, 0);
      await settleOnce(goal);
      await owner(
        `UPDATE event SET config = config || '{"features": {"community": false}}' WHERE id = $1`,
        [event],
      );
      expect(await goalOf(goal)).toMatchObject({ status: "missed" });
      expect((await lockOf(who.player, event, quest))?.community_lock?.state).toBe("missed");
    });

    it("the event switch off ends a scheduled goal missed too: its lock reads missed and holds nothing back (CTO code review 3)", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { order_mode: "in_order" });
      const first = await newQuest(event, { category, position: 0 });
      const second = await newQuest(event, { category, position: 1 });
      const who = await member(event);
      const start = new Date(Date.now() + 7_200_000);
      const goal = await lockWith(
        event,
        { kind: "quest", id: first },
        {
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + 600_000).toISOString(),
        },
      );
      expect((await lockOf(who.player, event, first))?.community_lock?.state).toBe("scheduled");
      expect((await lockOf(who.player, event, second))?.lock).toBe("order_locked");
      await owner(
        `UPDATE event SET config = config || '{"features": {"community": false}}' WHERE id = $1`,
        [event],
      );
      expect(await goalOf(goal)).toMatchObject({ status: "missed", final_at: expect.any(Date) });
      expect((await lockOf(who.player, event, first))?.community_lock?.state).toBe("missed");
      expect((await lockOf(who.player, event, second))?.lock).toBeNull();
    });

    it("with the platform switch off a running goal still settles, and its reach unlocks", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const goal = await lockWith(event, { kind: "quest", id: quest });
      await backdate(event, goal, 0);
      await settleOnce(goal);
      await reach(event, goal, false);
      expect(await refusal(complete(who.player, quest))).toBe("none");
    });

    it("reached stays reached after a removal lowers the progress", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      const goal = await lockWith(
        event,
        { kind: "quest", id: quest },
        { target: 5, milestones: [] },
      );
      await backdate(event, goal, 0);
      const giver = await member(event);
      const earned = await newQuest(event);
      const [entry] = await owner<{ id: string }>(
        `WITH c AS (
           INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key, created_at)
           SELECT n.organizer_id, n.event_id, n.id, $2, 1, 'qr', gen_random_uuid()::text, now() - interval '5 minutes'
           FROM enrollment n WHERE n.id = $1 RETURNING *)
         INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, created_at)
         SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', 10, 10, c.id, c.quest_id, 'player', c.created_at
         FROM c RETURNING id`,
        [giver.enrollment, earned],
      );
      expect(await settleOnce(goal)).toBe("reached");
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, staff_user_id, reverses, created_at)
         SELECT l.organizer_id, l.event_id, l.enrollment_id, 'removal', -10, -10, l.completion_id, l.quest_id,
                'staff', $2, l.id, now() - interval '4 minutes'
         FROM ledger_entry l WHERE l.id = $1`,
        [entry?.id, ownerA],
      );
      await settleOnce(goal);
      expect(await refusal(complete(who.player, quest))).toBe("none");
    });
  });

  describe("a missed lock never blocks anything else (CTO 2)", () => {
    it("opens the in-order successor of a missed quest; a waiting lock holds it", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { order_mode: "in_order" });
      const first = await newQuest(event, { category, position: 0 });
      const second = await newQuest(event, { category, position: 1 });
      const who = await member(event);
      const goal = await lockWith(event, { kind: "quest", id: first });
      expect((await lockOf(who.player, event, second))?.lock).toBe("order_locked");
      await miss(event, goal);
      expect((await lockOf(who.player, event, second))?.lock).toBeNull();
      expect(await refusal(complete(who.player, second))).toBe("none");
    });

    it("opens the category that unlocks after a missed whole-category lock; a waiting lock holds it", async () => {
      const event = await newEvent();
      const first = await newCategory(event);
      await newQuest(event, { category: first });
      const next = await newCategory(event, { unlock_after: first });
      const quest = await newQuest(event, { category: next });
      const who = await member(event);
      const goal = await lockWith(event, { kind: "category", id: first });
      expect((await lockOf(who.player, event, quest))?.lock).toBe("category_locked");
      await miss(event, goal);
      expect((await lockOf(who.player, event, quest))?.lock).toBeNull();
    });

    it("pays the bonus of a missed quest's category once the rest is done; never while the lock waits", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { completion_bonus: 50 });
      const locked = await newQuest(event, { category });
      const rest = [await newQuest(event, { category }), await newQuest(event, { category })];
      const who = await member(event);
      const bonuses = async () =>
        owner("SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'", [
          who.enrollment,
        ]);
      const goal = await lockWith(event, { kind: "quest", id: locked });
      await complete(who.player, rest[0] ?? "");
      expect(await bonuses()).toEqual([]);
      await miss(event, goal);
      await complete(who.player, rest[1] ?? "");
      expect(await bonuses()).toEqual([{ score_delta: "50" }]);
    });

    it("does not pay the bonus at the moment the lock is missed: the next completion in the category would (CTO note 1, ADR-227)", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { completion_bonus: 50 });
      const locked = await newQuest(event, { category });
      const rest = await newQuest(event, { category });
      const who = await member(event);
      const bonuses = async () =>
        owner("SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'", [
          who.enrollment,
        ]);
      const goal = await lockWith(event, { kind: "quest", id: locked });
      await complete(who.player, rest);
      await miss(event, goal);
      expect(await bonuses()).toEqual([]);
      await complete(who.player, rest);
      expect(await bonuses()).toEqual([{ score_delta: "50" }]);
    });
  });

  describe("rehearsal and the go-live wipe (ADR-229)", () => {
    it("a rehearsal account sees the lock; after go-live and the wipe it holds until the step is reached", async () => {
      const event = await newEvent("scheduled", ids.orgA, "10 minutes");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'CULR-WXPE')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event);
      const reward = await newReward(event);
      const rehearsal = await member(event, "rehearsal");
      const [{ starts_at: starts } = { starts_at: new Date() }] = await owner<{ starts_at: Date }>(
        "SELECT starts_at FROM event WHERE id = $1",
        [event],
      );
      const window = {
        startsAt: new Date(starts.getTime() + 1000).toISOString(),
        endsAt: new Date(starts.getTime() + 3_600_000).toISOString(),
      };
      const goal = await save(
        event,
        body({
          ...window,
          target: 10,
          reward: unlock({ kind: "reward", id: reward }),
          milestones: [{ threshold: 5, reward: unlock({ kind: "quest", id: quest }) }],
        }),
      );
      expect((await lockOf(rehearsal.player, event, quest))?.lock).toBe("community_locked");
      expect(await refusal(complete(rehearsal.player, quest))).toBe("QN403:community_locked");
      expect(await refusal(reserve(rehearsal.player, reward))).toBe("RW403:community_locked");

      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour' WHERE id = $1",
        [event],
      );
      const real = await member(event);
      // A refused door rolls its own wipe back; the first door that commits runs it.
      expect(await refusal(complete(real.player, await newQuest(event, { points: 1 })))).toBe(
        "none",
      );
      expect(await owner("SELECT 1 FROM enrollment WHERE id = $1", [rehearsal.enrollment])).toEqual(
        [],
      );
      expect(await refusal(complete(real.player, quest))).toBe("QN403:community_locked");
      await owner("UPDATE community_goal SET ends_at = now() + interval '1 hour' WHERE id = $1", [
        goal,
      ]);
      await backdate(event, goal, 4);
      expect(await settleOnce(goal)).toBe("running");
      expect(await refusal(complete(real.player, quest))).toBe("none");
      expect(await refusal(reserve(real.player, reward))).toBe("RW403:community_locked");
    });
  });

  describe("a goal saved while a player reserves its reward (crossed locks)", () => {
    it("a reserve holding the reward first lands, and the goal saves after it", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await member(event);
      const held = await hold(as(who.player), "SELECT * FROM reserve_reward($1, $2)", [
        reward,
        randomUUID(),
      ]);
      const saving = lockWith(event, { kind: "reward", id: reward });
      expect(await waitsOnLock("save_community_goal")).toBe(true);
      held.release();
      expect(await held.done).toHaveLength(1);
      expect(await saving).not.toBe("");
      expect(await refusal(reserve(who.player, reward))).toBe("RW403:community_locked");
    });

    it("a goal holding the reward's key first wins: the reserve waits, then is refused", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await member(event);
      const held = await hold(teamA(), "SELECT save_community_goal($1, NULL, $2, $3) AS id", [
        event,
        JSON.stringify(body({ reward: unlock({ kind: "reward", id: reward }) })),
        randomUUID(),
      ]);
      const reserving = refusal(reserve(who.player, reward));
      expect(await waitsOnLock("reserve_reward")).toBe(true);
      held.release();
      await held.done;
      expect(await reserving).toBe("RW403:community_locked");
      expect(await owner("SELECT 1 FROM redemption WHERE reward_id = $1", [reward])).toEqual([]);
    });
  });

  describe("the gate's cost and its completeness (CTO 3)", () => {
    it("probes the partial unique indexes", async () => {
      await owner("SET enable_seqscan = off");
      try {
        for (const column of ["unlock_quest_id", "unlock_category_id", "unlock_reward_id"]) {
          const plan = await owner<{ "QUERY PLAN": string }>(
            `EXPLAIN SELECT s.id FROM community_step s WHERE s.${column} = '${randomUUID()}'::uuid`,
          );
          expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
            `community_step_${column.replace("_id", "")}_key`,
          );
        }
      } finally {
        await owner("RESET enable_seqscan");
      }
    });

    it("maps every function the API may run that reads a quest, category or reward", async () => {
      const found = await owner<{ name: string }>(
        `SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND has_function_privilege('questify_app', p.oid, 'EXECUTE')
           AND p.prosrc ~* '((from|join)\\s+(quest|category|reward)\\M|(play_quest|play_enter|team_poll|team_flash|inbox_rows)\\()'
         ORDER BY 1`,
      );
      const names = found.map((row) => row.name);
      const unmapped = names.filter((name) => !(name in GATE_MAP));
      const stale = Object.keys(GATE_MAP).filter((name) => !names.includes(name));
      expect({ unmapped, stale }).toEqual({ unmapped: [], stale: [] });
    });
  });
});

/**
 * Every function `questify_app` may run whose source reads `quest`, `category` or `reward` (CTO 3): `gated` passes the
 * community lock (a door or reader above, each with its test), `staff` authorizes an owner, editor or operator first
 * (operator doors that offer quests are gated), `exempt` with the reason. Helpers that read them for a door (`inbox_rows`)
are matched by name, since the door's own source does not name the table. A new reader or door fails the test above
 * until it is placed here.
 */
const GATE_MAP: Readonly<Record<string, string>> = {
  // souvenir_event checks active owner/editor membership and award_event_of checks tenant/event scope.
  // This is configuration, with no play/wipe/payment; souvenir_evaluate separately refuses rehearsal members.
  souvenir_action:
    "staff: freezes visible nonflash/nonlive targets through quest_lock_missed; no quest payment (T-402b)",
  member_game: "gated: answers QN403 community_locked (the sheets test)",
  member_sessions:
    "exempt: lists agenda sessions and shows the title of a visible linked quest only; it plays and pays nothing, and the quest opens only through its own gated doors (T-505)",
  send_poll: "gated: Send refused while locked (the live poll test)",
  share_quest: "gated: share (door table)",
  start_game_round: "gated: game start (door table)",
  submit_survey: "gated: survey (door table)",
  close_poll: "staff: closes a poll already sent; it pays nothing",
  complete_quest: "gated: scan, typed code and location (door table)",
  finish_game_round: "gated: game finish (door table)",
  issue_meet_pass: "gated: meet pass (door table)",
  meet_player: "gated: meet code (door table)",
  operator_complete_quest: "gated: operator scan (door table)",
  quiz_start: "gated: quiz start (door table)",
  quiz_answer: "gated: quiz answer (door table)",
  quiz_next: "gated: through quiz_locked and play_enter, as quiz_answer",
  stamp_step: "gated: passport stamp (door table)",
  submit_quest: "gated: submission (door table)",
  vote_quest: "gated: vote and live poll vote (door table)",
  reserve_reward: "gated: reserve (door table)",
  member_event_quests: "gated: the locked line and notes",
  member_passport: "gated: the sheets serve nothing",
  member_poll: "gated: the sheets serve nothing; the live poll test",
  member_quiz: "gated: the sheets serve nothing",
  member_share: "gated: the sheets serve nothing",
  member_survey: "gated: the sheets serve nothing",
  member_vote: "gated: the sheets serve nothing",
  poll_results: "gated: through member_poll (QC404 while locked)",
  live_state: "gated: open and closed polls and the bar's marker",
  operator_award_quests: "gated: operators are not offered a locked quest",
  public_event_quests: "gated: the public page",
  shop_rewards: "gated: the shop's note",
  reveal_category: "exempt: reveals a hidden category, which stays community-locked (tested)",
  set_goal: "exempt: a player may pin a locked reward (CTO 8, tested)",
  event_has_live: "exempt: a boolean for the live cache; names nothing",
  cancel_redemption: "exempt: a redemption already made",
  deletion_pending: "exempt: redemptions already made",
  my_desk_items: "exempt: redemptions already made",
  my_redemptions: "exempt: redemptions already made",
  member_activity: "exempt: ledger entries already written",
  member_ledger: "exempt: ledger entries already written (team)",
  own_bonus: "exempt: bonuses already paid",
  own_category_bonus: "exempt: bonuses already paid",
  own_submissions: "exempt: submissions already sent",
  own_tickets:
    "exempt: help-desk tickets already sent; a quest's title only for a ticket about it (T-310)",
  open_ticket:
    "exempt: a help-desk ticket names a quest of the event without playing it; it pays nothing (T-310)",
  event_tickets: "staff: the team's Help desk page (T-310)",
  operator_ticket: "staff: a help-desk ticket the operator answers, as the review queue (T-310)",
  operator_inbox: "staff: the operator's Inbox, quest titles through inbox_rows (T-310)",
  operator_inbox_count: "staff: the operator's Inbox badge, through inbox_rows (T-310)",
  console_tickets:
    "staff: Questify's ticket queue, a quest's title only for a ticket about it (T-312)",
  console_ticket: "staff: one ticket of Questify's queue, a quest's title only (T-312)",
  close_one_due_round: "exempt: the system sweep closing a round already open; it pays no quest",
  add_reward_codes: "staff: the team's reward codes",
  audience_counts: "staff: the team's audience preview",
  bulk_award: "staff: the team's bulk award (a manual award passes the lock, ADR-227)",
  community_goals: "staff: the team's Community page",
  flag_detail: "staff: the team's flags",
  manual_awards: "staff: the team's award list",
  operator_scan_subject: "staff: the station's result screen (the scan itself is gated)",
  operator_stations: "staff: the operator's stations (the scan itself is gated)",
  operator_station_today: "staff: counts of the operator's station, no quest offered (T-311)",
  practice_wipe_owed:
    "staff: an operator's practice scan asks whether the go-live wipe is owed; the practice runs the gated scan door (T-311)",
  quest_bulk_count: "staff: the team's bulk award preview",
  quest_item_misses: "staff: the team's quest items",
  quest_items: "staff: the team's quest items",
  quest_vote_counts: "staff: the team's vote counts",
  set_audience: "staff: the team's audience rules",
  set_operator: "staff: the team's operator settings",
  survey_summary: "staff: the team's survey results",
  launch_flash: "gated: Launch refused while locked (flash-boosts.int.test.ts)",
  end_flash: "staff: ends a flash quest already running; it pays nothing",
  save_boost: "staff: the team's Boosts page",
  set_quest_first_bonus: "staff: the quest builder's save (test/db/first-bonus)",
  event_boosts: "staff: the team's Boosts page",
  own_pending_points: "exempt: submissions already sent",
  operator_nfc_tags:
    "staff: the operator's tag writes (a tap itself is gated through record_completion)",
  register_nfc_tag: "staff: an operator registers a tag; it pays nothing",
  move_nfc_tag: "staff: the team's Tags panel",
  revoke_quest_nfc_tags: "staff: the team's Tags panel",
  device_view:
    "staff: a paired station's title line (the scan itself is gated through record_completion)",
  operator_devices: "staff: the operator's stations to pair or show (the scan itself is gated)",
  screen_code_for_device:
    "staff: a station's rotating code; the scan is gated through record_completion (T-309)",
  screen_poll:
    "exempt: the big screen shows only a sent poll in a public category (no audience, not hidden) and none a community goal holds shut; it pays and plays nothing (T-504)",
  screen_code_for_operator:
    "staff: the operator's rotating code; the scan is gated through record_completion (T-309)",
};
