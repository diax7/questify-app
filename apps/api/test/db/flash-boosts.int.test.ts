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
type Paid = Readonly<{ score_delta: string; balance_delta: string; boost_id: string | null }>;

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
const REPEATS: Readonly<Record<string, number>> = {
  scan_qr: 100,
  enter_code: 100,
  location: 100,
  meet: 10,
};
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const noop = (): void => undefined;
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * Flash quests and boosts in the database (T-307, migration 0055, ADR-231 to ADR-233): every door refuses a flash
 * quest outside its window and while switched off, the readers show it only inside it, the category rules leave it
 * out, Launch and End now, the boost builder and its freeze, every payer pays the boost of its quest's category at the
 * time its points were fixed and never for staff, the rehearsal and its wipe, the live read, the crossed locks, the
 * probe's index and the payer completeness map.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("flash quests and boosts (database)", () => {
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

  const newEvent = async (status = "live", startsIn = "-2 hours", endsIn = "1 day") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Tower Fest', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `FLB${counter}`, status, startsIn, endsIn],
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
    repeat?: number;
  }>;
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
        fields.repeat ?? REPEATS[type] ?? 1,
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
  /** Makes a quest flash with a window `from` and `to` minutes from now (draft: hidden with no window). */
  const flashWindow = async (quest: string, window: "draft" | readonly [number, number]) => {
    if (window === "draft") {
      await owner(
        "UPDATE quest SET flash = true, visible = false, opens_at = NULL, closes_at = NULL WHERE id = $1",
        [quest],
      );
      return;
    }
    await owner(
      `UPDATE quest SET flash = true, visible = true, opens_at = now() + make_interval(mins => $2),
                        closes_at = now() + make_interval(mins => $3) WHERE id = $1`,
      [quest, window[0], window[1]],
    );
  };
  const member = async (event: string, via = "code"): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`fb_player_${counter}`],
    );
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
      [player?.id, GUIDELINES],
    );
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.orgA, event, player?.id, via],
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
  const switchOff = (event: string, feature: string) =>
    owner(
      `UPDATE event SET config = jsonb_set(config, '{features}',
                                           coalesce(config -> 'features', '{}') || jsonb_build_object($2::text, false))
       WHERE id = $1`,
      [event, feature],
    );
  const switchOn = (event: string, feature: string) =>
    owner("UPDATE event SET config = config #- ARRAY['features', $2::text] WHERE id = $1", [
      event,
      feature,
    ]);
  const openRehearsal = async (event: string) => {
    counter += 1;
    const code = `${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}FB-BSTX`;
    await owner("INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)", [
      event,
      ids.orgA,
      code,
    ]);
  };

  const complete = (player: string, quest: string, key = randomUUID()) =>
    query<{ completion_id: string; points: string }>(
      as(player),
      "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
      [quest, key],
    );
  const staffAward = (event: string, who: Member, quest: string) =>
    query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
      event,
      who.enrollment,
      quest,
      randomUUID(),
      randomUUID(),
    ]);
  const vote = (player: string, quest: string) =>
    query(as(player), "SELECT * FROM vote_quest($1, $2, $3)", [quest, ["a"], randomUUID()]);
  const lastPaid = async (who: Member, kind = "quest") =>
    (
      await owner<Paid>(
        `SELECT score_delta, balance_delta, boost_id FROM ledger_entry
         WHERE enrollment_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`,
        [who.enrollment, kind],
      )
    )[0];
  /** A boost written as its builder would, with a window `from` to `to` minutes from now. */
  const boostOn = async (
    event: string,
    category: string,
    from = -10,
    to = 30,
    rehearsal = false,
  ) => {
    const [made] = await owner<{ id: string }>(
      `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at, rehearsal)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4), now() + make_interval(mins => $5), $6) RETURNING id`,
      [ids.orgA, event, category, from, to, rehearsal],
    );
    return made?.id ?? "";
  };
  const save = (
    event: string,
    fields: Readonly<{
      boost?: string | null;
      category: string;
      starts?: string | null;
      minutes?: number;
      team?: RequestContext;
    }>,
  ) =>
    query<{ id: string }>(
      fields.team ?? teamA(),
      "SELECT save_boost($1, $2, $3, $4, $5, $6) AS id",
      [
        event,
        fields.boost ?? null,
        fields.category,
        fields.starts ?? null,
        fields.minutes ?? 30,
        randomUUID(),
      ],
    ).then((rows) => rows[0]?.id ?? "");
  const launch = (event: string, quest: string, minutes = 10, team = teamA()) =>
    query<{ opens_at: Date; closes_at: Date; replayed: boolean }>(
      team,
      "SELECT * FROM launch_flash($1, $2, $3, $4)",
      [event, quest, minutes, randomUUID()],
    );
  const endFlash = (event: string, quest: string) =>
    query<{ opens_at: Date; closes_at: Date; replayed: boolean }>(
      teamA(),
      "SELECT * FROM end_flash($1, $2, $3)",
      [event, quest, randomUUID()],
    );
  const listed = async (player: string, event: string) =>
    query<{
      quest_id: string;
      flash_closes_at: Date | null;
      boost: { boostId: string; multiplier: number; endsAt: string } | null;
      lock: string | null;
    }>(as(player), "SELECT * FROM member_event_quests($1)", [event]);
  const live = async (player: string, event: string) =>
    (
      await query<{
        s: {
          flash: { questId: string; closesAt: string }[];
          boosts: { boostId: string; categoryId: string; multiplier: number }[];
        };
      }>(as(player), "SELECT live_state($1) AS s", [event])
    )[0]?.s;
  const hasLive = async (event: string) =>
    (await query<{ h: boolean }>(SYSTEM, "SELECT event_has_live($1) AS h", [event]))[0]?.h;
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

  // ============================================================ the table's walls
  describe("the quest's flash shape (CTO 1, CTO 10)", () => {
    it("refuses a flash live poll, a shown flash quest without both times or past 1,440 minutes", async () => {
      const event = await newEvent();
      const poll = await newQuest(event, {
        type: "vote",
        visible: false,
        config: { options: OPTIONS, live: { choices: "one", results: "after_vote", minutes: 5 } },
      });
      expect(await refusal(owner("UPDATE quest SET flash = true WHERE id = $1", [poll]))).toBe(
        "23514",
      );
      const quest = await newQuest(event);
      expect(await refusal(owner("UPDATE quest SET flash = true WHERE id = $1", [quest]))).toBe(
        "23514",
      );
      expect(await refusal(flashWindow(quest, [0, 1441]))).toBe("23514");
      expect(await refusal(flashWindow(quest, [0, 1440]))).toBe("none");
      expect(await refusal(flashWindow(quest, "draft"))).toBe("none");
    });

    it("keeps a launched quest flash: the flag can not be turned off once launched", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await flashWindow(quest, "draft");
      await launch(event, quest);
      expect(await refusal(owner("UPDATE quest SET flash = false WHERE id = $1", [quest]))).toBe(
        "23514",
      );
    });

    it("keeps a running flash quest's window against the API's own writes (FL409 window)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await flashWindow(quest, "draft");
      await launch(event, quest);
      const client = await pool.connect();
      try {
        expect(
          await refusal(
            withRequestContext(client, teamA(), () =>
              client.query(
                "UPDATE quest SET closes_at = closes_at + interval '1 hour' WHERE id = $1",
                [quest],
              ),
            ),
          ),
        ).toBe("FL409:window");
      } finally {
        client.release();
      }
    });
  });

  // ============================================================ the door table (flash)
  type DoorContext = {
    event: string;
    quest: string;
    who: Member;
    extra: Record<string, string | Buffer>;
  };
  type Door = Readonly<{
    name: string;
    type: string;
    config?: object;
    verification?: string[];
    before?: (context: DoorContext) => Promise<void>;
    run: (context: DoorContext) => Promise<unknown>;
  }>;
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
      name: "quiz start",
      type: "quiz",
      config: QUIZ,
      run: (c) => query(as(c.who.player), "SELECT quiz_start($1)", [c.quest]),
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
      name: "meet code",
      type: "meet",
      config: { dailyCap: 5 },
      before: async (c) => {
        const shown = await member(c.event);
        const hash = randomBytes(32);
        await owner(
          `UPDATE quest SET flash = true, visible = true, opens_at = now() - interval '1 minute',
                            closes_at = now() + interval '30 minutes' WHERE id = $1`,
          [c.quest],
        );
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

  describe("the door table: every door refuses a flash quest outside its window and switched off", () => {
    for (const door of DOORS) {
      it(door.name, async () => {
        const event = await newEvent();
        const quest = await newQuest(event, {
          type: door.type,
          config: door.config ?? {},
          ...(door.verification === undefined ? {} : { verification: door.verification }),
        });
        const context: DoorContext = { event, quest, who: await member(event), extra: {} };
        await door.before?.(context);
        await flashWindow(quest, "draft");
        expect(await refusal(door.run(context))).toBe("QN403:hidden");
        await flashWindow(quest, [5, 30]);
        expect(await refusal(door.run(context))).toBe("QN403:not_started");
        await flashWindow(quest, [-30, -5]);
        expect(await refusal(door.run(context))).toBe("QN403:ended");
        await flashWindow(quest, [-1, 30]);
        await switchOff(event, "flashQuests");
        expect(await refusal(door.run(context))).toBe("QN403:switched_off");
        await switchOn(event, "flashQuests");
        expect(await refusal(door.run(context))).toBe("none");
      });
    }

    it("the platform's switch off refuses at every door too", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      await flashWindow(quest, [-1, 30]);
      await owner(
        `INSERT INTO platform_setting (key, value) VALUES ('features', '{"flashQuests": {"enabled": false}}')
         ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || EXCLUDED.value`,
      );
      try {
        expect(await refusal(complete(who.player, quest))).toBe("QN403:switched_off");
        expect((await listed(who.player, event)).map((row) => row.quest_id)).not.toContain(quest);
      } finally {
        await owner(
          "UPDATE platform_setting SET value = value - 'flashQuests' WHERE key = 'features'",
        );
      }
      expect(await refusal(complete(who.player, quest))).toBe("none");
    });
  });

  // ============================================================ the readers
  describe("the readers show a flash quest only inside its window (ADR-231)", () => {
    it("the quest list, with its end, the sheets and the operator's award list", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const survey = await newQuest(event, { category, type: "survey", config: SURVEY });
      const game = await newQuest(event, { category, type: "game", config: GAME });
      const who = await member(event);
      const desk = await operator(event, ["award"]);
      const shown = async () => ({
        listed: (await listed(who.player, event)).map((row) => row.quest_id),
        survey: (
          await query<{ s: Row | null }>(as(who.player), "SELECT member_survey($1) AS s", [survey])
        )[0]?.s,
        game: await refusal(query(as(who.player), "SELECT * FROM member_game($1)", [game])),
        award: (
          await query<{ quest_id: string }>(
            as(desk.player),
            "SELECT * FROM operator_award_quests($1)",
            [event],
          )
        ).map((row) => row.quest_id),
      });
      for (const id of [quest, survey, game]) {
        await flashWindow(id, [5, 30]);
      }
      const before = await shown();
      expect(before.listed).toEqual([]);
      expect(before.survey).toBeNull();
      expect(before.game).toBe("QN403:hidden");
      expect(before.award).toEqual([]);
      for (const id of [quest, survey, game]) {
        await flashWindow(id, [-1, 30]);
      }
      const inside = await shown();
      expect(new Set(inside.listed)).toEqual(new Set([quest, survey, game]));
      expect(inside.survey).not.toBeNull();
      expect(inside.game).toBe("none");
      expect(inside.award).toContain(quest);
      const row = (await listed(who.player, event)).find((item) => item.quest_id === quest);
      expect(row?.flash_closes_at).toBeInstanceOf(Date);
      for (const id of [quest, survey, game]) {
        await flashWindow(id, [-30, -1]);
      }
      const after = await shown();
      expect(after.listed).toEqual([]);
      expect(after.game).toBe("QN403:hidden");
      expect(after.award).toEqual([]);
    });

    it("never lists a flash quest on the public event page", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET access = 'public' WHERE id = $1", [event]);
      const quest = await newQuest(event);
      const plain = await newQuest(event);
      await flashWindow(quest, [-1, 30]);
      const [code] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      const rows = await query<{ quest_id: string }>(
        SYSTEM,
        "SELECT * FROM public_event_quests($1)",
        [code?.join_code],
      );
      expect(rows.map((item) => item.quest_id)).toEqual([plain]);
    });

    it("a player who did it keeps it in their activity after the window", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      await flashWindow(quest, [-1, 30]);
      await complete(who.player, quest);
      await flashWindow(quest, [-30, -1]);
      const rows = await query<{ quest_id: string }>(
        as(who.player),
        "SELECT * FROM member_activity($1, NULL, 10)",
        [event],
      );
      expect(rows.map((item) => item.quest_id)).toContain(quest);
    });
  });

  // ============================================================ the category rules
  describe("flash quests stay out of the category rules", () => {
    it("a missed flash quest never holds the bonus, the successor or the next in-order quest", async () => {
      const event = await newEvent();
      const first = await newCategory(event, { completion_bonus: 50, order_mode: "in_order" });
      const flash = await newQuest(event, { category: first, position: 0 });
      const plain = await newQuest(event, { category: first, position: 1 });
      const next = await newCategory(event, { unlock_after: first });
      const after = await newQuest(event, { category: next });
      const who = await member(event);
      await flashWindow(flash, [-1, 30]);
      expect(
        (await listed(who.player, event)).find((row) => row.quest_id === plain)?.lock,
      ).toBeNull();
      await complete(who.player, plain);
      expect(await lastPaid(who, "bonus")).toMatchObject({ score_delta: "50" });
      expect(await refusal(complete(who.player, after))).toBe("none");
      await complete(who.player, flash);
      expect(
        await owner("SELECT 1 FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'", [
          who.enrollment,
        ]),
      ).toHaveLength(1);
    });

    it("a category of only flash quests is never done (no bonus) and is cleared at once", async () => {
      const event = await newEvent();
      const only = await newCategory(event, { completion_bonus: 50 });
      const flash = await newQuest(event, { category: only });
      const next = await newCategory(event, { unlock_after: only });
      const after = await newQuest(event, { category: next });
      const who = await member(event);
      await flashWindow(flash, [-1, 30]);
      expect(await refusal(complete(who.player, after))).toBe("none");
      await complete(who.player, flash);
      expect(await lastPaid(who, "bonus")).toBeUndefined();
    });

    it("a flash quest in a daily category follows the period cap; its item is given on the first completion", async () => {
      const event = await newEvent();
      const daily = await newCategory(event, { refresh: "daily" });
      const quest = await newQuest(event, { category: daily, repeat: 1 });
      const [item] = await owner<{ id: string }>(
        `INSERT INTO quest_item (organizer_id, event_id, name_en, stock_total)
         VALUES ($1, $2, 'Badge', 5) RETURNING id`,
        [ids.orgA, event],
      );
      await owner("UPDATE quest SET item_id = $2 WHERE id = $1", [quest, item?.id]);
      const who = await member(event);
      await flashWindow(quest, [-1, 30]);
      expect(await refusal(complete(who.player, quest))).toBe("none");
      expect(await refusal(complete(who.player, quest))).toBe("QD409:1");
      expect(
        await owner("SELECT 1 FROM redemption WHERE enrollment_id = $1 AND quest_item_id = $2", [
          who.enrollment,
          item?.id,
        ]),
      ).toHaveLength(1);
    });
  });

  // ============================================================ Launch and End now
  describe("Launch and End now (ADR-231)", () => {
    it("launches a draft for its minutes, replays while open, then refuses once ended", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const who = await member(event);
      await flashWindow(quest, "draft");
      const [first] = await launch(event, quest, 10);
      expect(first?.replayed).toBe(false);
      expect((first?.closes_at.getTime() ?? 0) - (first?.opens_at.getTime() ?? 0)).toBe(600_000);
      expect((await launch(event, quest, 30))[0]).toMatchObject({
        replayed: true,
        closes_at: first?.closes_at,
      });
      expect((await listed(who.player, event)).map((row) => row.quest_id)).toEqual([quest]);
      const [audit] = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'quest.flash_launch' AND target_id = $1",
        [quest],
      );
      expect(audit?.n).toBe("1");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const [ended] = await endFlash(event, quest);
      expect(ended?.replayed).toBe(false);
      expect((await endFlash(event, quest))[0]?.replayed).toBe(true);
      expect(await refusal(complete(who.player, quest))).toBe("QN403:ended");
      expect(await refusal(launch(event, quest))).toBe("FL409:already_launched");
    });

    it("clamps to the event's end, and refuses with less than a minute left (too_late)", async () => {
      const event = await newEvent("live", "-2 hours", "5 minutes");
      const quest = await newQuest(event);
      await flashWindow(quest, "draft");
      const [run] = await launch(event, quest, 60);
      const [ev] = await owner<{ ends_at: Date }>("SELECT ends_at FROM event WHERE id = $1", [
        event,
      ]);
      expect(run?.closes_at.getTime()).toBe(ev?.ends_at.getTime());
      const late = await newEvent("live", "-2 hours", "30 seconds");
      const other = await newQuest(late);
      await flashWindow(other, "draft");
      expect(await refusal(launch(late, other))).toBe("FL409:too_late");
    });

    it("refuses a scheduled one, a community-locked one, a non-flash quest and another organizer's", async () => {
      const event = await newEvent();
      const scheduled = await newQuest(event);
      await flashWindow(scheduled, [5, 30]);
      expect(await refusal(launch(event, scheduled))).toBe("FL409:scheduled");
      const locked = await newQuest(event);
      await flashWindow(locked, "draft");
      await query(teamA(), "SELECT save_community_goal($1, NULL, $2, $3)", [
        event,
        JSON.stringify({
          title: { en: "Light the tower" },
          measure: "points",
          target: 5,
          startsAt: new Date().toISOString(),
          endsAt: minutesFromNow(60),
          reward: { kind: "unlock", target: { kind: "quest", id: locked } },
          milestones: [],
        }),
        randomUUID(),
      ]);
      expect(await refusal(launch(event, locked))).toBe("FL409:community_locked");
      expect(await refusal(launch(event, await newQuest(event)))).toBe("FN422");
      expect(await refusal(launch(event, scheduled, 10, teamB()))).toBe("AN404");
      expect(await refusal(endFlash(event, await newQuest(event)))).toBe("FN422");
    });

    it("refuses outside a live event or a rehearsal, and while switched off", async () => {
      const draft = await newEvent("draft", "1 day", "2 days");
      const quest = await newQuest(draft);
      await flashWindow(quest, "draft");
      expect(await refusal(launch(draft, quest))).toBe("FE409:event_not_live");
      const event = await newEvent();
      const other = await newQuest(event);
      await flashWindow(other, "draft");
      await switchOff(event, "flashQuests");
      expect(await refusal(launch(event, other))).toBe("FF403:feature_off");
      expect(await refusal(launch(event, other, 0))).toBe("22023");
    });

    it("End now 10 s into a launch, and refused on a scheduled one not yet started (not_started)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await flashWindow(quest, "draft");
      expect(await refusal(endFlash(event, quest))).toBe("FL409:not_started");
      await launch(event, quest);
      await owner(
        `UPDATE quest SET opens_at = opens_at - interval '10 seconds', flash_launched_at = flash_launched_at
           - interval '10 seconds' WHERE id = $1`,
        [quest],
      );
      expect((await endFlash(event, quest))[0]?.replayed).toBe(false);
      const scheduled = await newQuest(event);
      await flashWindow(scheduled, [5, 30]);
      expect(await refusal(endFlash(event, scheduled))).toBe("FL409:not_started");
      await flashWindow(scheduled, [-1, 30]);
      expect((await endFlash(event, scheduled))[0]?.replayed).toBe(false);
    });
  });

  // ============================================================ the boost builder
  describe("the boost builder (ADR-232)", () => {
    it("fires now or schedules, inside the event, never two on one category at once", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const other = await newCategory(event);
      const now = await save(event, { category });
      expect(now).not.toBe("");
      expect(await refusal(save(event, { category, starts: minutesFromNow(10) }))).toBe(
        "BO409:boost_overlap",
      );
      expect(await refusal(save(event, { category: other, starts: minutesFromNow(10) }))).toBe(
        "none",
      );
      expect(await refusal(save(event, { category, starts: minutesFromNow(31) }))).toBe("none");
      expect(await refusal(save(event, { category, starts: minutesFromNow(60 * 24) }))).toBe(
        "BO422:outside_event",
      );
      expect(await refusal(save(event, { category, starts: minutesFromNow(-2) }))).toBe(
        "BO422:startsAt",
      );
      expect(await refusal(save(event, { category, minutes: 0 }))).toBe("BO422:minutes");
      expect(await refusal(save(event, { category, minutes: 1441 }))).toBe("BO422:minutes");
      expect(await refusal(save(event, { category: await newCategory(await newEvent()) }))).toBe(
        "BO422:category",
      );
      expect(await refusal(save(event, { category, team: teamB() }))).toBe("AN404");
      const [audit] = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM audit_log WHERE action = 'boost.create' AND event_id = $1",
        [event],
      );
      expect(audit?.n).toBe("3");
    });

    it("edits and deletes until a minute before the start, never once started or named by an entry", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const scheduled = await save(event, { category, starts: minutesFromNow(10) });
      expect(
        await refusal(save(event, { boost: scheduled, category, starts: minutesFromNow(20) })),
      ).toBe("none");
      const [moved] = await owner<{ starts_at: Date }>(
        "SELECT starts_at FROM boost WHERE id = $1",
        [scheduled],
      );
      expect((moved?.starts_at.getTime() ?? 0) - Date.now()).toBeGreaterThan(19 * 60_000);
      await owner("UPDATE boost SET starts_at = now() + interval '50 seconds' WHERE id = $1", [
        scheduled,
      ]);
      expect(await refusal(save(event, { boost: scheduled, category }))).toBe(
        "BO409:boost_started",
      );
      expect(
        await refusal(
          query(teamA(), "SELECT delete_boost($1, $2, $3)", [event, scheduled, randomUUID()]),
        ),
      ).toBe("BO409:boost_started");
      const later = await save(event, { category, starts: minutesFromNow(120) });
      const quest = await newQuest(event, { category });
      const who = await member(event);
      await owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', 'fake') `,
        [ids.orgA, event, who.enrollment, quest],
      );
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, boost_id)
         SELECT $1, $2, $3, 'quest', 20, 20, c.id, $4, 'player', $5 FROM quest_completion c
         WHERE c.idempotency_key = 'fake' AND c.enrollment_id = $3`,
        [ids.orgA, event, who.enrollment, quest, later],
      );
      expect(
        await refusal(
          query(teamA(), "SELECT delete_boost($1, $2, $3)", [event, later, randomUUID()]),
        ),
      ).toBe("BO409:boost_started");
      const free = await save(event, { category, starts: minutesFromNow(300) });
      expect(
        await refusal(
          query(teamA(), "SELECT delete_boost($1, $2, $3)", [event, free, randomUUID()]),
        ),
      ).toBe("none");
      expect(await owner("SELECT 1 FROM boost WHERE id = $1", [free])).toEqual([]);
    });

    it("stops a running boost (replayed after), and refuses a stop before the start", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const scheduled = await save(event, { category, starts: minutesFromNow(10) });
      const stop = (boost: string) =>
        query<{ ends_at: Date; replayed: boolean }>(
          teamA(),
          "SELECT * FROM end_boost($1, $2, $3)",
          [event, boost, randomUUID()],
        );
      expect(await refusal(stop(scheduled))).toBe("BO409:not_started");
      const running = await boostOn(event, await newCategory(event));
      expect((await stop(running))[0]?.replayed).toBe(false);
      expect((await stop(running))[0]?.replayed).toBe(true);
      expect(await refusal(stop(randomUUID()))).toBe("BN404");
    });

    it("refuses past 100 an event and after the event ended", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      await owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         SELECT $1, $2, $3, now() + make_interval(hours => 2 + g), now() + make_interval(hours => 2 + g, mins => 1)
         FROM generate_series(1, 100) g`,
        [ids.orgA, event, category],
      );
      expect(await refusal(save(event, { category, starts: minutesFromNow(30) }))).toBe(
        "BO409:limit_reached",
      );
      const ended = await newEvent("live", "-2 days", "-1 hour");
      expect(await refusal(save(ended, { category: await newCategory(ended) }))).toBe(
        "BO409:event_ended",
      );
    });

    it("keeps a category with a boost (RESTRICT), and a draft event's delete takes its boosts", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      await save(event, { category, starts: minutesFromNow(30) });
      const failure = await refusal(owner("DELETE FROM category WHERE id = $1", [category]));
      expect(failure).toBe("23503");
      const draft = await newEvent("draft", "1 day", "2 days");
      await boostOn(draft, await newCategory(draft), 60 * 25, 60 * 26);
      expect(await refusal(owner("DELETE FROM event WHERE id = $1", [draft]))).toBe("none");
    });

    it("lists the event's boosts with what may still change", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const later = await save(event, { category, starts: minutesFromNow(30) });
      const [list] = await query<{ b: Row[] }>(teamA(), "SELECT event_boosts($1) AS b", [event]);
      expect(list?.b).toMatchObject([
        {
          id: later,
          categoryId: category,
          multiplier: 2,
          rehearsal: false,
          editable: true,
          paid: 0,
        },
      ]);
      expect(await refusal(query(teamB(), "SELECT event_boosts($1)", [event]))).toBe("AN404");
    });
  });

  // ============================================================ the payer table
  type PayerContext = {
    event: string;
    category: string;
    quest: string;
    who: Member;
    extra: Record<string, string | Buffer>;
  };
  type Payer = Readonly<{
    name: string;
    type: string;
    config?: object;
    verification?: string[];
    /** What the quest pays without a boost. */
    base?: number;
    before?: (context: PayerContext) => Promise<void>;
    pay: (context: PayerContext) => Promise<unknown>;
    /** Whose entry to read (the player's by default). */
    paid?: (context: PayerContext) => Member;
  }>;
  const PAYERS: readonly Payer[] = [
    { name: "scan", type: "scan_qr", pay: (c) => complete(c.who.player, c.quest) },
    {
      name: "typed code",
      type: "enter_code",
      config: { code: "TOWER" },
      pay: (c) =>
        query(
          as(c.who.player),
          "SELECT * FROM complete_quest($1, 'code', NULL, 'TOWER', $2, NULL)",
          [c.quest, randomUUID()],
        ),
    },
    {
      name: "location",
      type: "location",
      pay: (c) =>
        query(
          as(c.who.player),
          "SELECT * FROM complete_quest($1, 'location', NULL, NULL, $2, NULL, $3)",
          [c.quest, randomUUID(), JSON.stringify(READING)],
        ),
    },
    {
      name: "my-QR (an operator scanning the player)",
      type: "scan_qr",
      verification: ["my_qr"],
      before: async (c) => {
        c.extra["operator"] = (await operator(c.event, ["scan_quests"])).player;
      },
      pay: (c) =>
        query(
          as(String(c.extra["operator"])),
          "SELECT * FROM operator_complete_quest($1, $2, 1, $3)",
          [c.quest, c.who.player, randomUUID()],
        ),
    },
    {
      name: "vote",
      type: "vote",
      config: { options: OPTIONS },
      pay: (c) => vote(c.who.player, c.quest),
    },
    {
      name: "live poll vote",
      type: "vote",
      config: { options: OPTIONS, live: { choices: "one", results: "after_vote", minutes: 30 } },
      before: async (c) => {
        await owner("UPDATE quest SET visible = false WHERE id = $1", [c.quest]);
        await query(teamA(), "SELECT * FROM send_poll($1, $2, $3)", [
          c.event,
          c.quest,
          randomUUID(),
        ]);
      },
      pay: (c) => vote(c.who.player, c.quest),
    },
    {
      name: "survey",
      type: "survey",
      config: SURVEY,
      pay: (c) =>
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
      pay: (c) =>
        query(as(c.who.player), "SELECT * FROM share_quest($1, $2)", [c.quest, randomUUID()]),
    },
    {
      name: "passport's final stamp",
      type: "passport",
      config: { needed: 1 },
      verification: [],
      pay: async (c) => {
        const [step] = await owner<{ id: string }>(
          "SELECT id FROM passport_step WHERE quest_id = $1",
          [c.quest],
        );
        return query(as(c.who.player), "SELECT * FROM stamp_step($1, 1, $2, NULL)", [
          step?.id,
          randomUUID(),
        ]);
      },
    },
    {
      name: "meet (the scanner's side)",
      type: "meet",
      config: { dailyCap: 5 },
      pay: async (c) => {
        const shown = await member(c.event);
        c.extra["shown"] = shown.enrollment;
        const hash = randomBytes(32);
        await query(as(shown.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [
          c.quest,
          hash,
        ]);
        return query(as(c.who.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
          hash,
          randomUUID(),
        ]);
      },
    },
    {
      name: "meet (the shown side)",
      type: "meet",
      config: { dailyCap: 5 },
      pay: async (c) => {
        const scanner = await member(c.event);
        const hash = randomBytes(32);
        await query(as(c.who.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [
          c.quest,
          hash,
        ]);
        return query(as(scanner.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
          hash,
          randomUUID(),
        ]);
      },
    },
    {
      name: "submission (auto-approved at the send)",
      type: "submission",
      config: { accepts: ["text"], autoApprove: true, resubmit: false },
      pay: (c) =>
        query(as(c.who.player), "SELECT * FROM submit_quest($1, 'My answer', $2, $3)", [
          c.quest,
          GUIDELINES,
          randomUUID(),
        ]),
    },
    {
      name: "submission (approved)",
      type: "submission",
      config: { accepts: ["text"], autoApprove: false, resubmit: false },
      pay: async (c) => {
        const [sent] = await query<{ submission_id: string }>(
          as(c.who.player),
          "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
          [c.quest, GUIDELINES, randomUUID()],
        );
        return query(
          teamA(),
          "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
          [c.event, sent?.submission_id, randomUUID(), randomUUID()],
        );
      },
    },
    {
      name: "quiz",
      type: "quiz",
      config: QUIZ,
      pay: async (c) => {
        await query(as(c.who.player), "SELECT quiz_start($1)", [c.quest]);
        await query(as(c.who.player), "SELECT quiz_next($1)", [c.quest]);
        return query(as(c.who.player), "SELECT quiz_answer($1, 'q1', 'r')", [c.quest]);
      },
    },
    {
      name: "mini-game",
      type: "game",
      config: GAME,
      pay: async (c) => {
        const [round] = await query<{ round_id: string }>(
          as(c.who.player),
          "SELECT * FROM start_game_round($1, $2, NULL, 1)",
          [c.quest, randomUUID()],
        );
        return query(
          as(c.who.player),
          "SELECT * FROM finish_game_round($1, $2, 'passed', $3, NULL, false, 0)",
          [round?.round_id, randomUUID(), JSON.stringify(PASS)],
        );
      },
    },
  ];

  /** Pays one play of the payer's quest with a boost on its own category, on another, or none. */
  const payWith = async (payer: Payer, boosted: "own" | "other" | "none") => {
    const event = await newEvent();
    const category = await newCategory(event);
    const quest = await newQuest(event, {
      category,
      type: payer.type,
      config: payer.config ?? {},
      ...(payer.verification === undefined ? {} : { verification: payer.verification }),
    });
    const context: PayerContext = {
      event,
      category,
      quest,
      who: await member(event),
      extra: {},
    };
    await payer.before?.(context);
    const boost =
      boosted === "own"
        ? await boostOn(event, category)
        : boosted === "other"
          ? await boostOn(event, await newCategory(event))
          : null;
    await payer.pay(context);
    return { paid: await lastPaid(context.who), boost };
  };
  describe("the payer table: ×2 on the boosted category, ×1 elsewhere (ADR-232)", () => {
    for (const payer of PAYERS) {
      it(payer.name, async () => {
        const own = await payWith(payer, "own");
        expect(own.paid).toEqual({ score_delta: "20", balance_delta: "20", boost_id: own.boost });
        expect((await payWith(payer, "other")).paid).toEqual({
          score_delta: "10",
          balance_delta: "10",
          boost_id: null,
        });
        expect((await payWith(payer, "none")).paid).toEqual({
          score_delta: "10",
          balance_delta: "10",
          boost_id: null,
        });
      });
    }
  });

  describe("frozen points are judged when they were fixed (ADR-233)", () => {
    type Frozen = Readonly<{
      name: string;
      type: string;
      config: object;
      /** Starts the play and answers the time its points were fixed. */
      start: (c: PayerContext) => Promise<Date>;
      finish: (c: PayerContext) => Promise<unknown>;
    }>;
    const FROZEN: readonly Frozen[] = [
      {
        name: "a submission sent",
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
        start: async (c) => {
          const [sent] = await query<{ submission_id: string }>(
            as(c.who.player),
            "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
            [c.quest, GUIDELINES, randomUUID()],
          );
          c.extra["submission"] = sent?.submission_id ?? "";
          const [row] = await owner<{ created_at: Date }>(
            "SELECT created_at FROM submission WHERE id = $1",
            [sent?.submission_id],
          );
          return row?.created_at ?? new Date();
        },
        finish: (c) =>
          query(teamA(), "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)", [
            c.event,
            c.extra["submission"],
            randomUUID(),
            randomUUID(),
          ]),
      },
      {
        name: "a quiz started",
        type: "quiz",
        config: QUIZ,
        start: async (c) => {
          await query(as(c.who.player), "SELECT quiz_start($1)", [c.quest]);
          const [row] = await owner<{ started_at: Date }>(
            "SELECT started_at FROM quiz_attempt WHERE enrollment_id = $1",
            [c.who.enrollment],
          );
          return row?.started_at ?? new Date();
        },
        finish: async (c) => {
          await query(as(c.who.player), "SELECT quiz_next($1)", [c.quest]);
          return query(as(c.who.player), "SELECT quiz_answer($1, 'q1', 'r')", [c.quest]);
        },
      },
      {
        name: "a game round issued",
        type: "game",
        config: GAME,
        start: async (c) => {
          const [round] = await query<{ round_id: string }>(
            as(c.who.player),
            "SELECT * FROM start_game_round($1, $2, NULL, 1)",
            [c.quest, randomUUID()],
          );
          c.extra["round"] = round?.round_id ?? "";
          const [row] = await owner<{ issued_at: Date }>(
            "SELECT issued_at FROM game_round WHERE id = $1",
            [round?.round_id],
          );
          return row?.issued_at ?? new Date();
        },
        finish: (c) =>
          query(
            as(c.who.player),
            "SELECT * FROM finish_game_round($1, $2, 'passed', $3, NULL, false, 0)",
            [c.extra["round"], randomUUID(), JSON.stringify(PASS)],
          ),
      },
    ];
    for (const frozen of FROZEN) {
      it(`${frozen.name} inside a boost and paid after its end is ×2; before it and paid inside, ×1`, async () => {
        const setUp = async () => {
          const event = await newEvent();
          const category = await newCategory(event);
          const quest = await newQuest(event, {
            category,
            type: frozen.type,
            config: frozen.config,
          });
          const context: PayerContext = {
            event,
            category,
            quest,
            who: await member(event),
            extra: {},
          };
          return { context, fixed: await frozen.start(context) };
        };
        const inside = await setUp();
        const [boost] = await owner<{ id: string }>(
          `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
           VALUES ($1, $2, $3, $4::timestamptz - interval '1 minute', $4::timestamptz + interval '1 millisecond')
           RETURNING id`,
          [ids.orgA, inside.context.event, inside.context.category, inside.fixed],
        );
        await frozen.finish(inside.context);
        expect(await lastPaid(inside.context.who)).toEqual({
          score_delta: "20",
          balance_delta: "20",
          boost_id: boost?.id,
        });
        const before = await setUp();
        await owner(
          `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
           VALUES ($1, $2, $3, $4::timestamptz + interval '1 millisecond', now() + interval '30 minutes')`,
          [ids.orgA, before.context.event, before.context.category, before.fixed],
        );
        await frozen.finish(before.context);
        expect(await lastPaid(before.context.who)).toEqual({
          score_delta: "10",
          balance_delta: "10",
          boost_id: null,
        });
      });
    }

    it("a quiz still open is finished by confirm_results with the boost at its start", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category, type: "quiz", config: QUIZ });
      const who = await member(event);
      const boost = await boostOn(event, category);
      await query(as(who.player), "SELECT quiz_start($1)", [quest]);
      await query(as(who.player), "SELECT quiz_next($1)", [quest]);
      await owner(
        `UPDATE quiz_answer a SET answered_at = now(), choice_id = 'r', correct = true
         FROM quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = $1`,
        [who.enrollment],
      );
      await owner("UPDATE quiz_attempt SET right_count = 1 WHERE enrollment_id = $1", [
        who.enrollment,
      ]);
      await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [event]);
      const places = await owner<{ enrollment_id: string }>(
        `SELECT c.enrollment_id FROM current_places((SELECT e FROM event e WHERE e.id = $1)) c ORDER BY c.rank`,
        [event],
      );
      await query(teamA(), "SELECT confirm_results($1, $2, $3)", [
        event,
        places.map((row) => row.enrollment_id),
        randomUUID(),
      ]);
      expect(await lastPaid(who)).toEqual({
        score_delta: "20",
        balance_delta: "20",
        boost_id: boost,
      });
    });

    it("a quest moved to another category between the send and the approval is judged by its new category (CTO 8)", async () => {
      const event = await newEvent();
      const first = await newCategory(event);
      const second = await newCategory(event);
      const quest = await newQuest(event, {
        category: first,
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      const who = await member(event);
      const boost = await boostOn(event, second);
      const [sent] = await query<{ submission_id: string }>(
        as(who.player),
        "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
        [quest, GUIDELINES, randomUUID()],
      );
      await owner("UPDATE quest SET category_id = $2 WHERE id = $1", [quest, second]);
      await query(
        teamA(),
        "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
        [event, sent?.submission_id, randomUUID(), randomUUID()],
      );
      expect(await lastPaid(who)).toMatchObject({ score_delta: "20", boost_id: boost });
    });

    it("pending points and a sent submission show what approval will pay (CTO 4)", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, {
        category,
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      const who = await member(event);
      await boostOn(event, category);
      const [sent] = await query<{ submission_id: string }>(
        as(who.player),
        "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
        [quest, GUIDELINES, randomUUID()],
      );
      const pending = async () =>
        (
          await query<{ p: string }>(as(who.player), "SELECT own_pending_points($1) AS p", [event])
        )[0]?.p;
      const own = async () =>
        (
          await query<{ points: number }>(as(who.player), "SELECT * FROM own_submissions($1)", [
            event,
          ])
        )[0]?.points;
      expect(await pending()).toBe("20");
      expect(await own()).toBe(20);
      await query(
        teamA(),
        "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
        [event, sent?.submission_id, randomUUID(), randomUUID()],
      );
      expect(await lastPaid(who)).toMatchObject({ score_delta: "20" });
      expect(await own()).toBe(20);
      expect(await pending()).toBe("0");
    });
  });

  describe("never boosted (ADR-232)", () => {
    it("manual quest awards by an owner and an operator, with the operator's cap unchanged", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await boostOn(event, category);
      const who = await member(event);
      await staffAward(event, who, quest);
      expect(await lastPaid(who)).toEqual({
        score_delta: "10",
        balance_delta: "10",
        boost_id: null,
      });
      const desk = await operator(event, ["award"]);
      const other = await member(event);
      await query(
        as(desk.player),
        "SELECT * FROM operator_award($1, $2, $3, NULL, 'Code failed', $4)",
        [event, other.enrollment, quest, randomUUID()],
      );
      expect(await lastPaid(other)).toEqual({
        score_delta: "10",
        balance_delta: "10",
        boost_id: null,
      });
      const [today] = await owner<{ a: string }>(
        "SELECT awarded_today(e, $2, NULL) AS a FROM event e WHERE e.id = $1",
        [event, desk.player],
      );
      expect(today?.a).toBe("10");
    });

    it("the category bonus (per period too) and quest items; a bonus can never name a boost", async () => {
      const event = await newEvent();
      const category = await newCategory(event, { completion_bonus: 50, refresh: "daily" });
      const quest = await newQuest(event, { category, repeat: 1 });
      await boostOn(event, category);
      const who = await member(event);
      await complete(who.player, quest);
      expect(await lastPaid(who)).toMatchObject({ score_delta: "20" });
      expect(await lastPaid(who, "bonus")).toEqual({
        score_delta: "50",
        balance_delta: "50",
        boost_id: null,
      });
      const boost = await boostOn(event, await newCategory(event));
      expect(
        await refusal(
          owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                       category_id, actor, bonus_period, boost_id)
             VALUES ($1, $2, $3, 'bonus', 1, 1, $4, 'system', '-infinity', $5)`,
            [ids.orgA, event, who.enrollment, category, boost],
          ),
        ),
      ).toBe("23514");
    });
  });

  // ============================================================ what the boosted entry moves
  describe("the boosted entry is the record (ADR-233)", () => {
    it("removal takes back exactly the doubled points; the score is the ledger's sum", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const boost = await boostOn(event, category);
      const who = await member(event);
      await complete(who.player, quest);
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [who.enrollment],
      );
      const [removed] = await query<{ score_delta: string }>(
        teamA(),
        "SELECT * FROM remove_award($1, $2, 'Mistake', $3, $4)",
        [event, entry?.id, randomUUID(), randomUUID()],
      );
      expect(removed?.score_delta).toBe("-20");
      expect(await lastPaid(who, "removal")).toEqual({
        score_delta: "-20",
        balance_delta: "-20",
        boost_id: boost,
      });
      const [sums] = await owner<{ score: string; total: string }>(
        `SELECT n.score::text AS score, (SELECT sum(score_delta) FROM ledger_entry l WHERE l.enrollment_id = n.id)::text
                AS total
         FROM enrollment n WHERE n.id = $1`,
        [who.enrollment],
      );
      expect(sums?.score).toBe(sums?.total);
    });

    it("the places rebuilt from the ledger follow the boosted scores", async () => {
      const event = await newEvent();
      const boosted = await newCategory(event);
      const plain = await newCategory(event);
      const a = await newQuest(event, { category: boosted, points: 6 });
      const b = await newQuest(event, { category: plain, points: 10 });
      await boostOn(event, boosted);
      const first = await member(event);
      const second = await member(event);
      await complete(first.player, a);
      await complete(second.player, b);
      const places = await owner<{ enrollment_id: string; score: string }>(
        `SELECT c.enrollment_id, c.score FROM current_places((SELECT e FROM event e WHERE e.id = $1)) c
         ORDER BY c.rank`,
        [event],
      );
      expect(places.map((row) => row.enrollment_id)).toEqual([first.enrollment, second.enrollment]);
      const rebuilt = await owner<{ enrollment_id: string }>(
        `SELECT l.enrollment_id FROM ledger_entry l WHERE l.event_id = $1
         GROUP BY l.enrollment_id ORDER BY sum(l.score_delta) DESC`,
        [event],
      );
      expect(rebuilt.map((row) => row.enrollment_id)).toEqual(
        places.map((row) => row.enrollment_id),
      );
    });

    it("today's ranking and a community points goal count the doubled points", async () => {
      const event = await newEvent("live", "-2 hours", "3 days");
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await boostOn(event, category);
      const who = await member(event);
      const [made] = await complete(who.player, quest);
      const [day] = await query<{ score: string }>(
        as(who.player),
        "SELECT * FROM ranking_day_entry_of($1)",
        [made?.completion_id],
      );
      expect(day?.score).toBe("20");
      const [goal] = await query<{ id: string }>(
        teamA(),
        "SELECT save_community_goal($1, NULL, $2, $3) AS id",
        [
          event,
          JSON.stringify({
            title: { en: "Light the tower" },
            measure: "points",
            target: 100,
            startsAt: new Date().toISOString(),
            endsAt: minutesFromNow(60),
            reward: { kind: "nothing" },
            milestones: [],
          }),
          randomUUID(),
        ],
      );
      await owner(
        "UPDATE community_goal SET starts_at = now() - interval '10 minutes' WHERE id = $1",
        [goal?.id],
      );
      const other = await member(event);
      await complete(other.player, quest);
      await owner(
        "UPDATE community_goal SET starts_at = now() - interval '10 minutes' WHERE id = $1",
        [goal?.id],
      );
      for (let tick = 0; tick < 3; tick += 1) {
        await query(SYSTEM, "SELECT settle_goal($1, true)", [goal?.id]);
      }
      const [progress] = await owner<{ progress: string }>(
        "SELECT progress FROM community_goal WHERE id = $1",
        [goal?.id],
      );
      expect(Number(progress?.progress)).toBeGreaterThanOrEqual(20);
      expect(Number(progress?.progress) % 20).toBe(0);
    });

    it("the player's activity and the team's record say ×2, the removal too", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await boostOn(event, category);
      const who = await member(event);
      const [made] = await complete(who.player, quest);
      const activity = await query<{ kind: string; multiplier: number | null }>(
        as(who.player),
        "SELECT kind, multiplier FROM member_activity($1, NULL, 10)",
        [event],
      );
      expect(activity).toEqual([{ kind: "quest", multiplier: 2 }]);
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE completion_id = $1",
        [made?.completion_id],
      );
      await query(teamA(), "SELECT * FROM remove_award($1, $2, 'Mistake', $3, $4)", [
        event,
        entry?.id,
        randomUUID(),
        randomUUID(),
      ]);
      const record = await query<{ kind: string; multiplier: number | null }>(
        teamA(),
        "SELECT kind, multiplier FROM member_ledger($1, $2, NULL, 10)",
        [event, who.enrollment],
      );
      expect(record).toEqual([
        { kind: "removal", multiplier: 2 },
        { kind: "quest", multiplier: 2 },
      ]);
    });

    it("completion_boost answers the caller's own completion only", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await boostOn(event, category);
      const who = await member(event);
      const other = await member(event);
      const [made] = await complete(who.player, quest);
      const boostOf = async (player: string) =>
        (
          await query<{ m: number | null }>(as(player), "SELECT completion_boost($1) AS m", [
            made?.completion_id,
          ])
        )[0]?.m;
      expect(await boostOf(who.player)).toBe(2);
      expect(await boostOf(other.player)).toBeNull();
    });

    it("the event's switch off stops every boost paying at once; on again, it resumes", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await boostOn(event, category);
      const who = await member(event);
      await switchOff(event, "boosts");
      await complete(who.player, quest);
      expect(await lastPaid(who)).toMatchObject({ score_delta: "10", boost_id: null });
      expect((await listed(who.player, event))[0]?.boost).toBeNull();
      await switchOn(event, "boosts");
      await complete(who.player, quest);
      expect(await lastPaid(who)).toMatchObject({ score_delta: "20" });
    });

    it("a real entry can never name a rehearsal boost (LB500, CTO 9)", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const who = await member(event);
      const rehearsalBoost = await boostOn(event, category, -10, 30, true);
      await complete(who.player, quest);
      expect(await lastPaid(who)).toMatchObject({ score_delta: "10", boost_id: null });
      const [made] = await owner<{ completion_id: string }>(
        "SELECT completion_id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [who.enrollment],
      );
      expect(
        await refusal(
          owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                       quest_id, actor, staff_user_id, reverses, boost_id)
             SELECT organizer_id, event_id, enrollment_id, 'removal', -1, -1, quest_id, 'staff', $3, id, $2
             FROM ledger_entry WHERE completion_id = $1`,
            [made?.completion_id, rehearsalBoost, ownerA],
          ),
        ),
      ).toBe("LB500");
    });
  });

  // ============================================================ what the player is told
  describe("the quest list and live (ADR-231, ADR-232)", () => {
    it("names the boost on its category's quests only; never a rehearsal boost to a real player", async () => {
      const event = await newEvent();
      const boosted = await newCategory(event);
      const plain = await newCategory(event);
      const a = await newQuest(event, { category: boosted });
      const b = await newQuest(event, { category: plain });
      const boost = await boostOn(event, boosted);
      await boostOn(event, plain, -10, 30, true);
      const who = await member(event);
      const rows = await listed(who.player, event);
      expect(rows.find((row) => row.quest_id === a)?.boost).toMatchObject({
        boostId: boost,
        multiplier: 2,
      });
      expect(rows.find((row) => row.quest_id === b)?.boost).toBeNull();
      const state = await live(who.player, event);
      expect(state?.boosts).toEqual([
        expect.objectContaining({ boostId: boost, categoryId: boosted, multiplier: 2 }),
      ]);
    });

    it("live lists the open flash quests the member may play, and a hidden category's boost only once found", async () => {
      const event = await newEvent();
      const hidden = await newCategory(event, { hidden: true });
      const open = await newCategory(event);
      const flash = await newQuest(event, { category: open });
      const done = await newQuest(event, { category: open });
      await newQuest(event, { category: hidden });
      await flashWindow(flash, [-1, 30]);
      await flashWindow(done, [-1, 30]);
      await boostOn(event, hidden);
      const who = await member(event);
      await complete(who.player, done);
      const state = await live(who.player, event);
      expect(state?.flash.map((item) => item.questId)).toEqual([flash]);
      expect(state?.boosts).toEqual([]);
      const desk = await member(event);
      await owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
         VALUES ($1, $2, $3, '{scan_quests}', false)`,
        [ids.orgA, event, desk.player],
      );
      expect((await live(desk.player, event))?.flash).toEqual([]);
    });

    it("event_has_live is true for 15 minutes after a flash quest opens or a boost starts", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      expect(await hasLive(event)).toBe(false);
      await flashWindow(quest, [-5, 30]);
      expect(await hasLive(event)).toBe(true);
      await flashWindow(quest, [-20, 30]);
      expect(await hasLive(event)).toBe(false);
      const boost = await boostOn(event, await newCategory(event), -5, 30);
      expect(await hasLive(event)).toBe(true);
      await owner("UPDATE boost SET starts_at = now() - interval '20 minutes' WHERE id = $1", [
        boost,
      ]);
      expect(await hasLive(event)).toBe(false);
    });

    it("reads the boost by one probe of its category index", async () => {
      await owner("SET enable_seqscan = off");
      try {
        const plan = await owner<{ "QUERY PLAN": string }>(
          `EXPLAIN SELECT b.* FROM boost b WHERE b.category_id = '${randomUUID()}'::uuid
             AND b.starts_at <= now() AND b.ends_at > now()`,
        );
        expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("boost_category_idx");
      } finally {
        await owner("RESET enable_seqscan");
      }
    });
  });

  // ============================================================ rehearsal and the go-live wipe
  describe("rehearsal and the go-live wipe (CTO 3)", () => {
    it("a rehearsal boost doubles a rehearsal scan; the wipe removes it; a real boost survives and pays live", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      await openRehearsal(event);
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const rehearsal = await member(event, "rehearsal");
      const practice = await save(event, { category, minutes: 10 });
      const [kind] = await owner<{ rehearsal: boolean }>(
        "SELECT rehearsal FROM boost WHERE id = $1",
        [practice],
      );
      expect(kind?.rehearsal).toBe(true);
      expect(await refusal(save(event, { category, minutes: 60 }))).toBe("BO422:outside_event");
      const [ev] = await owner<{ starts_at: Date }>("SELECT starts_at FROM event WHERE id = $1", [
        event,
      ]);
      const real = await save(event, {
        category,
        starts: new Date((ev?.starts_at.getTime() ?? 0) + 1000).toISOString(),
        minutes: 60,
      });
      await complete(rehearsal.player, quest);
      expect(await lastPaid(rehearsal)).toMatchObject({ score_delta: "20", boost_id: practice });

      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      await owner("UPDATE boost SET starts_at = now() - interval '30 seconds' WHERE id = $1", [
        real,
      ]);
      const player = await member(event);
      await complete(player.player, quest);
      expect(await owner("SELECT 1 FROM boost WHERE id = $1", [practice])).toEqual([]);
      expect(await lastPaid(player)).toMatchObject({ score_delta: "20", boost_id: real });
    });

    it("rehearsal boosts overlap-check apart from real ones, and an erase mid-rehearsal removes them", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      await openRehearsal(event);
      const category = await newCategory(event);
      const practice = await save(event, { category, minutes: 10 });
      expect(await refusal(save(event, { category, minutes: 10 }))).toBe("BO409:boost_overlap");
      await query(teamA(), "SELECT erase_rehearsal($1, $2)", [event, randomUUID()]);
      expect(await owner("SELECT 1 FROM boost WHERE id = $1", [practice])).toEqual([]);
    });

    it("a boost saved with no event start is a rehearsal boost; a start set before its end is accepted, and real players get ×1 (CTO note 2)", async () => {
      const [made] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'FLBNOSTART', 'Tower Fest', 'draft')
         RETURNING id`,
        [ids.orgA],
      );
      const event = made?.id ?? "";
      await openRehearsal(event);
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const practice = await save(event, { category, minutes: 60 });
      const [kind] = await owner<{ rehearsal: boolean }>(
        "SELECT rehearsal FROM boost WHERE id = $1",
        [practice],
      );
      expect(kind?.rehearsal).toBe(true);
      await owner(
        `UPDATE event SET status = 'live', starts_at = now() - interval '1 minute', ends_at = now() + interval '1 day'
         WHERE id = $1`,
        [event],
      );
      const player = await member(event);
      expect((await listed(player.player, event))[0]?.boost).toBeNull();
      await complete(player.player, quest);
      expect(await lastPaid(player)).toMatchObject({ score_delta: "10", boost_id: null });
      expect(await owner("SELECT 1 FROM boost WHERE id = $1", [practice])).toEqual([]);
    });

    it("refuses a rehearsal launch at the live door whose own call runs the go-live wipe (CTO code review 1)", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      await openRehearsal(event);
      const quest = async (type: string, config: object = {}) => {
        const id = await newQuest(event, { type, config });
        await flashWindow(id, "draft");
        expect((await launch(event, id))[0]?.replayed).toBe(false);
        return id;
      };
      const scan = await quest("scan_qr");
      const submission = await quest("submission", {
        accepts: ["text"],
        autoApprove: true,
        resubmit: false,
      });
      const quiz = await quest("quiz", QUIZ);
      const game = await quest("game", GAME);
      const meet = await quest("meet", { dailyCap: 5 });
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      const player = await member(event);
      const shown = await member(event);
      const hash = randomBytes(32);
      await owner(
        `INSERT INTO meet_pass (organizer_id, event_id, quest_id, enrollment_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 minute')`,
        [ids.orgA, event, meet, shown.enrollment, hash],
      );
      // Each refused door rolls its own wipe back, so every call below is the first live one; each starts only when
      // awaited, so no refusal is left unhandled.
      const doors: readonly [string, () => Promise<unknown>][] = [
        ["scan", () => complete(player.player, scan)],
        [
          "submission",
          () =>
            query(as(player.player), "SELECT * FROM submit_quest($1, 'My answer', $2, $3)", [
              submission,
              GUIDELINES,
              randomUUID(),
            ]),
        ],
        ["quiz start", () => query(as(player.player), "SELECT quiz_start($1)", [quiz])],
        [
          "game start",
          () =>
            query(as(player.player), "SELECT * FROM start_game_round($1, $2, NULL, 1)", [
              game,
              randomUUID(),
            ]),
        ],
        [
          "meet pass",
          () =>
            query(as(player.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [
              meet,
              randomBytes(32),
            ]),
        ],
        [
          "meet code",
          () =>
            query(as(player.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
              hash,
              randomUUID(),
            ]),
        ],
      ];
      for (const [name, door] of doors) {
        expect(await refusal(door()), name).toBe("QN403:hidden");
      }
      expect(
        await owner("SELECT 1 FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'", [
          player.enrollment,
        ]),
      ).toEqual([]);
    });

    it("a rehearsal launch is hidden between go-live and the wipe, a draft again after it, and can be launched live", async () => {
      const event = await newEvent("scheduled", "30 minutes", "1 day");
      await openRehearsal(event);
      const quest = await newQuest(event);
      await flashWindow(quest, "draft");
      const rehearsal = await member(event, "rehearsal");
      expect((await launch(event, quest))[0]?.replayed).toBe(false);
      expect((await listed(rehearsal.player, event)).map((row) => row.quest_id)).toEqual([quest]);
      await owner(
        "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      const player = await member(event);
      expect((await listed(player.player, event)).map((row) => row.quest_id)).toEqual([]);
      await query(SYSTEM, "SELECT ensure_rehearsal_wiped($1)", [event]);
      const [reset] = await owner<{ visible: boolean; flash_launched_at: Date | null }>(
        "SELECT visible, flash_launched_at FROM quest WHERE id = $1",
        [quest],
      );
      expect(reset).toEqual({ visible: false, flash_launched_at: null });
      expect((await launch(event, quest))[0]?.replayed).toBe(false);
      expect(await refusal(complete(player.player, quest))).toBe("none");
    });
  });

  // ============================================================ crossed locks
  describe("crossed locks", () => {
    it("a stop while a scan holds the boost's key does not wait; the scan pays ×2 by the end it saw", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const boost = await boostOn(event, category);
      const who = await member(event);
      const held = await hold(
        as(who.player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      const stopped = await query<{ replayed: boolean }>(
        teamA(),
        "SELECT * FROM end_boost($1, $2, $3)",
        [event, boost, randomUUID()],
      );
      expect(stopped[0]?.replayed).toBe(false);
      held.release();
      await held.done;
      expect(await lastPaid(who)).toMatchObject({ score_delta: "20", boost_id: boost });
    });

    it("a scan after a committed stop pays ×1", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      const boost = await boostOn(event, category);
      const who = await member(event);
      const held = await hold(teamA(), "SELECT * FROM end_boost($1, $2, $3)", [
        event,
        boost,
        randomUUID(),
      ]);
      held.release();
      await held.done;
      await complete(who.player, quest);
      expect(await lastPaid(who)).toMatchObject({ score_delta: "10", boost_id: null });
    });

    it("two overlapping saves serialise on the event's lock: the second is boost_overlap", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const held = await hold(teamA(), "SELECT save_boost($1, NULL, $2, NULL, 30, $3)", [
        event,
        category,
        randomUUID(),
      ]);
      const second = refusal(save(event, { category }));
      expect(await waitsOnLock("save_boost")).toBe(true);
      held.release();
      await held.done;
      expect(await second).toBe("BO409:boost_overlap");
    });
  });

  // ============================================================ another organizer
  describe("another organizer (cross-tenant)", () => {
    it("never boosts, launches, ends, stops or lists across organizers: AN404 or BO422, never a row", async () => {
      const event = await newEvent();
      const category = await newCategory(event);
      const quest = await newQuest(event, { category });
      await flashWindow(quest, "draft");
      const boost = await save(event, { category, starts: minutesFromNow(30) });
      expect(await refusal(save(event, { category, team: teamB() }))).toBe("AN404");
      expect(await refusal(launch(event, quest, 10, teamB()))).toBe("AN404");
      for (const sql of [
        "SELECT * FROM end_flash($1, $2, $3)",
        "SELECT delete_boost($1, $2, $3)",
        "SELECT * FROM end_boost($1, $2, $3)",
      ]) {
        const target = sql.includes("flash") ? quest : boost;
        expect(await refusal(query(teamB(), sql, [event, target, randomUUID()])), sql).toBe(
          "AN404",
        );
      }
      const [eventB] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'FLBORGB', 'Other Fest', 'live', now() - interval '1 hour', now() + interval '1 day')
         RETURNING id`,
        [ids.orgB],
      );
      const [categoryB] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'Theirs') RETURNING id",
        [eventB?.id],
      );
      expect(await refusal(save(event, { category: categoryB?.id ?? "" }))).toBe("BO422:category");
      expect(await refusal(save(eventB?.id ?? "", { category }))).toBe("AN404");
      expect(
        await refusal(
          query(teamA(), "SELECT * FROM end_boost($1, $2, $3)", [eventB?.id, boost, randomUUID()]),
        ),
      ).toBe("AN404");
    });
  });

  // ============================================================ the payer completeness map
  describe("the payer completeness map (CTO 2)", () => {
    it("maps every function that writes a ledger entry or calls a quest payer", async () => {
      const found = await owner<{ name: string; writes: boolean; pays: boolean; records: boolean }>(
        `SELECT DISTINCT p.proname AS name,
                p.prosrc ~* 'insert\\s+into\\s+(public\\.)?ledger_entry' AS writes,
                p.prosrc ~* '(public\\.)?pay_completion\\s*\\(' AS pays,
                p.prosrc ~* '(public\\.)?record_completion\\s*\\(' AS records
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosrc ~* '(insert\\s+into\\s+(public\\.)?ledger_entry|(public\\.)?pay_completion\\s*\\(|(public\\.)?record_completion\\s*\\()'
         ORDER BY 1`,
      );
      const names = found.map((row) => row.name);
      const unmapped = names.filter((name) => !(name in PAYER_MAP));
      const stale = Object.keys(PAYER_MAP).filter((name) => !names.includes(name));
      expect({ unmapped, stale }).toEqual({ unmapped: [], stale: [] });
      const callers = found.filter((row) => row.pays || row.records).map((row) => row.name);
      const noTime = callers.filter(
        (name) => !/^(now|manual|frozen|caller)/.test(PAYER_MAP[name] ?? ""),
      );
      expect(noTime).toEqual([]);
    });
  });
});

/**
 * Every function in `public` that inserts into `ledger_entry` or calls `pay_completion` or `record_completion` (CTO 2),
 * granted or not. A ledger writer is `boosted` (with its payer-table row) or `never` (why); a caller of a payer names
 * the time its points are judged at: `now`, `frozen` (its column), `manual` (never boosted), or `caller` (the payer
 * itself, which takes the time from its caller). A new writer or caller fails the test until it is placed here.
 * pay_submission's own callers (the auto-approve in submit_quest, 0040:355, 0041:851, 0045:531, and review_core)
 * call pay_submission, not pay_completion: they need no time entry, since it judges at sub.created_at.
 */
const PAYER_MAP: Readonly<Record<string, string>> = {
  pay_completion: "caller: boosted at its fixed_at (no default; the payer table)",
  record_completion:
    "caller: boosted now unless manual (scan, code, location, my-QR, vote, poll, survey, share)",
  complete_quest:
    "now: record_completion (scan, typed code, location rows; screen_qr in test/db/devices)",
  operator_complete_quest: "now: record_completion (my-QR row)",
  vote_quest: "now: record_completion (vote and live poll rows)",
  submit_survey: "now: record_completion (survey row)",
  share_quest: "now: record_completion (share row)",
  tap_quest: "now: record_completion (nfc rows, test/db/nfc-tags)",
  kiosk_complete_quest: "now: record_completion (kiosk rows, test/db/kiosks)",
  grant_manual_award:
    "manual: record_completion with manual, never boosted; `award` entries never (manual awards test)",
  pay_submission: "frozen: sub.created_at (the frozen rows)",
  finish_quiz: "frozen: attempt.started_at (the frozen rows, confirm_results)",
  finish_game_round: "frozen: played.issued_at (the frozen rows)",
  stamp_step: "now: the passport row",
  pay_meeting: "now: both meet rows",
  pay_category_bonus: "never: the organizer's fixed bonus (never-boosted test)",
  pay_first_bonus:
    "never: the organizer's fixed first-N bonus (never-boosted test, test/db/first-bonus)",
  streak_record:
    "never: the organizer's flat streak bonus, written by the ledger_streak trigger (kind streak: the boost CHECK, test/db/event-streak)",
  pay_community_batch: "never: the step's fixed reward (kind community: the boost CHECK)",
  grant_welcome: "never: welcome points",
  bulk_award: "never: a point award from the team",
  session_check_in: "never: a session's points on check-in (T-505b)",
  remove_award: "never: copies the reversed entry's boost (removal test)",
  reserve_reward: "never: a spend",
  end_reservation: "never: a spend returned",
  finish_handover: "never: a hand-over",
};
