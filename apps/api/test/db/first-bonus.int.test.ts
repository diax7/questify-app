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
type Bonus = Readonly<{ enrollment_id: string; score_delta: string; balance_delta: string }>;
type Left = Readonly<{
  quest_id: string;
  points: number;
  slots: number;
  free: number;
  given: number;
  real_given: number;
}>;

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
const UID = Buffer.from("04a1b2c3d4e5f6", "hex");
const GUIDELINES = "1.0";
const REPEATS: Readonly<Record<string, number>> = {
  scan_qr: 100,
  enter_code: 100,
  location: 100,
  meet: 10,
};
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const noop = (): void => undefined;

/**
 * The first-N bonus in the database (T-313, migration 0062, ADR-260 to ADR-263): the race at the Nth place, every door
 * (a repeat, a manual award and a practice scan never), the results-time quiz sweep, the meet's two sides and the
 * crossed locks, Stop under continuous claims, the place shown after a lower, the setter's rules, rehearsal and its
 * wipe, removal, the readers, the ledger's shape and the payer completeness rule.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the first-N bonus (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    // Eight claimers and the setter at once (the Stop test).
    pool = new Pool({ connectionString: db.appUrl, max: 9 });
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
      [ids.orgA, `FNB${counter}`, status, startsIn, endsIn],
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
         VALUES ($1, $2, $3, 'Tower', $4, $5, $6, 0, $7, $8, $9, $10, $11) RETURNING id, type
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
        fields.verification ?? null,
        fields.visible ?? true,
        type === "location" ? SPOT.lat : null,
        type === "location" ? SPOT.lng : null,
        type === "location" ? 50 : null,
      ],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code"): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`fnb_player_${counter}`],
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
  const openRehearsal = async (event: string) => {
    counter += 1;
    const code = `${LETTERS[counter % 24]}${LETTERS[Math.floor(counter / 24) % 24]}FN-BNSX`;
    await owner("INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)", [
      event,
      ids.orgA,
      code,
    ]);
  };

  const setBonus = (
    event: string,
    quest: string,
    points: number | null,
    slots: number | null,
    team: RequestContext = teamA(),
  ) =>
    query<{ outcome: string }>(
      team,
      "SELECT set_quest_first_bonus($1, $2, $3, $4, $5) AS outcome",
      [event, quest, points, slots, randomUUID()],
    ).then((rows) => rows[0]?.outcome);
  const complete = (player: string, quest: string, key = randomUUID()) =>
    query<{ completion_id: string; points: string; score: string }>(
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
  const bonuses = (quest: string) =>
    owner<Bonus>(
      `SELECT enrollment_id, score_delta, balance_delta FROM ledger_entry
       WHERE quest_id = $1 AND kind = 'first_bonus' ORDER BY id`,
      [quest],
    );
  const bonusOf = async (who: Member, quest: string) =>
    (await bonuses(quest)).filter((row) => row.enrollment_id === who.enrollment);
  const slotsOf = (quest: string) =>
    owner<{ place: number; enrollment_id: string | null; rehearsal: boolean }>(
      "SELECT place, enrollment_id, rehearsal FROM quest_bonus_slot WHERE quest_id = $1 ORDER BY place",
      [quest],
    );
  const leftOf = async (event: string, context: RequestContext = teamA()) =>
    query<Left>(context, "SELECT * FROM first_bonus_left($1)", [event]);
  const placeOf = async (who: Member, quest: string) =>
    (
      await query<{ quest_id: string; first_bonus_place: number | null }>(
        as(who.player),
        "SELECT quest_id, first_bonus_place FROM member_event_quests($1) WHERE quest_id = $2",
        [await eventOf(quest), quest],
      )
    )[0]?.first_bonus_place;
  const eventOf = async (quest: string) =>
    (await owner<{ event_id: string }>("SELECT event_id FROM quest WHERE id = $1", [quest]))[0]
      ?.event_id ?? "";
  const live = async (player: string, event: string) =>
    (
      await query<{ s: { firstBonus: string[] } }>(as(player), "SELECT live_state($1) AS s", [
        event,
      ])
    )[0]?.s;
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
  /** Like hold, but rolls the transaction back at release. */
  const holdThenUndo = async (context: RequestContext, sql: string, values: unknown[]) => {
    const client = await pool.connect();
    let release = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = noop;
    const started = new Promise<void>((resolve) => {
      ran = resolve;
    });
    const done = refusal(
      withRequestContext(client, context, async () => {
        await client.query(sql, values);
        ran();
        await gate;
        throw new Error("undo");
      }),
    ).finally(() => client.release());
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
  const hasLiveOf = async (event: string) =>
    (await query<{ h: boolean }>(SYSTEM, "SELECT event_has_live($1) AS h", [event]))[0]?.h;
  const lockKey = "SELECT pg_advisory_xact_lock(hashtextextended('first-bonus:' || $1, 0))";
  /** A quest with a bonus of `points` for `slots`, and `claimed` players who already got it. */
  const bonusQuest = async (slots: number, claimed = 0, points = 7, fields: QuestFields = {}) => {
    const event = await newEvent();
    const quest = await newQuest(event, fields);
    await setBonus(event, quest, points, slots);
    for (let n = 0; n < claimed; n += 1) {
      await complete((await member(event)).player, quest);
    }
    return { event, quest };
  };

  const answeredRight = async (who: Member, quest: string) => {
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
  };
  const rehearsing = async () => {
    const event = await newEvent("scheduled", "30 minutes", "1 day");
    await openRehearsal(event);
    const quest = await newQuest(event);
    await setBonus(event, quest, 7, 5);
    for (let n = 0; n < 3; n += 1) {
      await complete((await member(event, "rehearsal")).player, quest);
    }
    expect(await leftOf(event)).toMatchObject([{ free: 2, given: 3, real_given: 0 }]);
    return { event, quest };
  };
  const goLive = (event: string) =>
    owner(
      "UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE id = $1",
      [event],
    );
  const remove = (event: string, entry: string, key = randomUUID()) =>
    query<{ entry_id: string; replayed: boolean }>(
      teamA(),
      "SELECT * FROM remove_award($1, $2, 'Cheated', $3, $4)",
      [event, entry, key, randomUUID()],
    );
  const entryOf = async (who: Member, kind: string) =>
    (
      await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = $2",
        [who.enrollment, kind],
      )
    )[0]?.id ?? "";
  const scoreOf = async (who: Member) =>
    (
      await owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [who.enrollment])
    )[0]?.score;
  const own = (player: string, completion: string | undefined) =>
    query(as(player), "SELECT * FROM own_first_bonus($1)", [completion]);

  // ============================================================ the race (Done when)
  describe("the race at the Nth place (ADR-260)", () => {
    it("two completions at the 50th place pay exactly one bonus; the other gets the quest's points only", async () => {
      const { event, quest } = await bonusQuest(50, 49);
      const one = await member(event);
      const two = await member(event);
      const gate = await hold(SYSTEM, lockKey, [quest]);
      const racing = Promise.all([complete(one.player, quest), complete(two.player, quest)]);
      expect(await waitsOnLock("complete_quest")).toBe(true);
      gate.release();
      await gate.done;
      const paid = await racing;
      expect(paid.map((rows) => rows[0]?.points)).toEqual(["10", "10"]);
      expect(await bonuses(quest)).toHaveLength(50);
      const winners = [...(await bonusOf(one, quest)), ...(await bonusOf(two, quest))];
      expect(winners).toHaveLength(1);
      const places = [await placeOf(one, quest), await placeOf(two, quest)];
      expect(places.toSorted()).toEqual([50, null].toSorted());
    });

    it("repeats the race at the last place 20 times: always exactly one bonus", async () => {
      for (let round = 0; round < 20; round += 1) {
        const { event, quest } = await bonusQuest(3, 2);
        const racers = [await member(event), await member(event)];
        const gate = await hold(SYSTEM, lockKey, [quest]);
        const racing = Promise.all(racers.map((who) => complete(who.player, quest)));
        expect(await waitsOnLock("complete_quest")).toBe(true);
        gate.release();
        await gate.done;
        await racing;
        expect(await bonuses(quest), `round ${round}`).toHaveLength(3);
        expect(
          await owner(
            "SELECT 1 FROM quest_bonus_slot WHERE quest_id = $1 AND completion_id IS NULL",
            [quest],
          ),
        ).toEqual([]);
      }
    });

    it("40 completers on 8 connections and N = 5: exactly 5 bonuses, places 1 to 5", async () => {
      const { event, quest } = await bonusQuest(5);
      const players = await Promise.all(Array.from({ length: 40 }, () => member(event)));
      await Promise.all(players.map((who) => complete(who.player, quest)));
      expect(await bonuses(quest)).toHaveLength(5);
      const places = await Promise.all(players.map((who) => placeOf(who, quest)));
      expect(places.filter((place) => place !== null).toSorted()).toEqual([1, 2, 3, 4, 5]);
      expect(await leftOf(event)).toMatchObject([
        { quest_id: quest, free: 0, given: 5, real_given: 5 },
      ]);
    });

    it("a claimer that rolls back after taking a slot leaves it free for the next", async () => {
      const { event, quest } = await bonusQuest(1);
      const first = await member(event);
      const client = await pool.connect();
      try {
        await refusal(
          withRequestContext(client, as(first.player), async () => {
            await client.query("SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)", [
              quest,
              randomUUID(),
            ]);
            throw new Error("undo");
          }),
        );
      } finally {
        client.release();
      }
      const second = await member(event);
      await complete(second.player, quest);
      expect(await bonusOf(second, quest)).toHaveLength(1);
      expect(await placeOf(second, quest)).toBe(1);
    });
  });

  // ============================================================ the door table
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
    pay: (context: DoorContext) => Promise<unknown>;
    /** Whether the quest can be completed again (a repeat never takes a bonus). */
    repeats?: boolean;
  }>;
  const screenWindow = async () =>
    (await owner<{ w: number }>("SELECT screen_window_of(now()) AS w"))[0]?.w ?? 0;
  const pairKiosk = async (event: string, quest: string) => {
    const pending = { secret: randomBytes(32), code: randomBytes(32) };
    await query({}, "SELECT * FROM open_device_request($1, $2, 'kiosk', 'Safari on iPadOS')", [
      pending.secret,
      pending.code,
    ]);
    const [row] = await query<{ id: string }>(
      teamA(),
      "SELECT team_claim_device($1, $2, 'kiosk', $3, 'Gate tablet', $4) AS id",
      [pending.code, event, quest, randomUUID()],
    );
    await query({}, "SELECT activate_device($1, $2)", [pending.secret, randomBytes(32)]);
    return row?.id ?? "";
  };
  const DOORS: readonly Door[] = [
    {
      name: "scan",
      type: "scan_qr",
      repeats: true,
      pay: (c) => complete(c.who.player, c.quest),
    },
    {
      name: "typed code",
      type: "enter_code",
      config: { code: "TOWER" },
      repeats: true,
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
      repeats: true,
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
      name: "NFC tap",
      type: "scan_qr",
      verification: ["quest_qr", "nfc"],
      before: async (c) => {
        const [tag] = await owner<{ id: string }>(
          `INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, label, locked)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'Gate', true) RETURNING id`,
          [ids.orgA, c.event, c.quest, UID],
        );
        c.extra["tag"] = tag?.id ?? "";
      },
      pay: (c) =>
        query(as(c.who.player), "SELECT * FROM tap_quest($1, $2, false, $3, NULL)", [
          c.extra["tag"],
          UID,
          randomUUID(),
        ]),
    },
    {
      name: "screen QR",
      type: "scan_qr",
      verification: ["screen_qr"],
      pay: async (c) =>
        query(
          as(c.who.player),
          "SELECT * FROM complete_quest($1, 'screen_qr', $2, NULL, $3, NULL)",
          [c.quest, await screenWindow(), randomUUID()],
        ),
    },
    {
      name: "kiosk",
      type: "scan_qr",
      verification: ["kiosk"],
      before: async (c) => {
        c.extra["device"] = await pairKiosk(c.event, c.quest);
      },
      pay: async (c) =>
        query(
          { deviceId: String(c.extra["device"]) },
          "SELECT * FROM kiosk_complete_quest($1, $2, $3)",
          [c.who.player, await screenWindow(), randomUUID()],
        ),
    },
    {
      name: "vote",
      type: "vote",
      config: { options: OPTIONS },
      pay: (c) =>
        query(as(c.who.player), "SELECT * FROM vote_quest($1, $2, $3)", [
          c.quest,
          ["a"],
          randomUUID(),
        ]),
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
      pay: (c) =>
        query(as(c.who.player), "SELECT * FROM vote_quest($1, $2, $3)", [
          c.quest,
          ["a"],
          randomUUID(),
        ]),
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
      name: "submission (at its approval)",
      type: "submission",
      config: { accepts: ["text"], autoApprove: false, resubmit: false },
      pay: async (c) => {
        const [sent] = await query<{ submission_id: string }>(
          as(c.who.player),
          "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
          [c.quest, GUIDELINES, randomUUID()],
        );
        expect(await bonusOf(c.who, c.quest)).toEqual([]);
        return query(
          teamA(),
          "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
          [c.event, sent?.submission_id, randomUUID(), randomUUID()],
        );
      },
    },
    {
      name: "quiz (at its finish)",
      type: "quiz",
      config: QUIZ,
      pay: async (c) => {
        await query(as(c.who.player), "SELECT quiz_start($1)", [c.quest]);
        await query(as(c.who.player), "SELECT quiz_next($1)", [c.quest]);
        return query(as(c.who.player), "SELECT quiz_answer($1, 'q1', 'r')", [c.quest]);
      },
    },
    {
      name: "mini-game (at its result)",
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

  describe("the door table: a player's first completion through any door takes a slot (ADR-261)", () => {
    for (const door of DOORS) {
      it(door.name, async () => {
        const event = await newEvent();
        const quest = await newQuest(event, {
          type: door.type,
          config: door.config ?? {},
          ...(door.verification === undefined ? {} : { verification: door.verification }),
        });
        await setBonus(event, quest, 7, 5);
        const context: DoorContext = { event, quest, who: await member(event), extra: {} };
        await door.before?.(context);
        await door.pay(context);
        expect(await bonusOf(context.who, quest)).toEqual([
          { enrollment_id: context.who.enrollment, score_delta: "7", balance_delta: "7" },
        ]);
        expect(await placeOf(context.who, quest)).toBeGreaterThanOrEqual(1);
        if (door.repeats === true) {
          await door.pay(context);
          expect(await bonusOf(context.who, quest)).toHaveLength(1);
          expect(await bonuses(quest)).toHaveLength(1);
        }
      });
    }

    it("a meet with one slot left gives it to the side with the lower player id", async () => {
      const { event, quest } = await bonusQuest(1, 0, 7, { type: "meet", config: { dailyCap: 5 } });
      const scanner = await member(event);
      const shown = await member(event);
      const hash = randomBytes(32);
      await query(as(shown.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [quest, hash]);
      await query(as(scanner.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
        hash,
        randomUUID(),
      ]);
      const lower = scanner.player < shown.player ? scanner : shown;
      expect((await bonuses(quest)).map((row) => row.enrollment_id)).toEqual([lower.enrollment]);
    });

    it("a manual award never takes a slot; a scan after it is a repeat and earns no bonus (CTO 7, Q-225)", async () => {
      const { event, quest } = await bonusQuest(5);
      const who = await member(event);
      await staffAward(event, who, quest);
      const desk = await operator(event, ["award"]);
      const other = await member(event);
      await query(
        as(desk.player),
        "SELECT * FROM operator_award($1, $2, $3, NULL, 'Code failed', $4)",
        [event, other.enrollment, quest, randomUUID()],
      );
      expect(await bonuses(quest)).toEqual([]);
      await complete(who.player, quest);
      expect(await bonuses(quest)).toEqual([]);
      expect(await leftOf(event)).toMatchObject([{ free: 5, given: 0 }]);
    });

    it("a practice scan takes no slot and no lock, answers bonus_points, and a real claim meanwhile gets the slot", async () => {
      const { event, quest } = await bonusQuest(1, 0, 7, { verification: ["quest_qr", "my_qr"] });
      const desk = await operator(event, ["scan_quests"]);
      const who = await member(event);
      const practice = () =>
        query<{ outcome: string; points: string; bonus_points: number | null }>(
          as(desk.player),
          "SELECT * FROM operator_practice_scan($1, $2, 1)",
          [quest, who.player],
        ).then((rows) => rows[0]);
      expect(await practice()).toMatchObject({
        outcome: "completed",
        points: "10",
        bonus_points: 7,
      });
      expect(await leftOf(event)).toMatchObject([{ free: 1, given: 0 }]);
      const real = await member(event);
      const held = await hold(
        as(real.player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      expect(await practice()).toMatchObject({ outcome: "completed", bonus_points: 7 });
      held.release();
      await held.done;
      expect((await bonuses(quest)).map((row) => row.enrollment_id)).toEqual([real.enrollment]);
      expect(await practice()).toMatchObject({ outcome: "completed", bonus_points: null });
      await complete(who.player, quest);
      expect(await practice()).toMatchObject({ outcome: "completed", bonus_points: null });
    });

    it("a used-up bonus pays the quest's points only and takes no lock for it (the setter's lock held)", async () => {
      const { event, quest } = await bonusQuest(1, 1);
      const gate = await hold(SYSTEM, lockKey, [quest]);
      try {
        const late = await member(event);
        const [paid] = await complete(late.player, quest);
        expect(paid?.points).toBe("10");
        expect(await bonusOf(late, quest)).toEqual([]);
      } finally {
        gate.release();
        await gate.done;
      }
    });

    it("a quest without a bonus takes no lock either", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const gate = await hold(SYSTEM, lockKey, [quest]);
      try {
        await complete((await member(event)).player, quest);
      } finally {
        gate.release();
        await gate.done;
      }
      expect(await bonuses(quest)).toEqual([]);
    });
  });

  // ============================================================ the quiz sweeps (CTO MAJOR 1, CTO note 1)
  describe("the quiz sweeps", () => {
    it("a quiz still open paid by confirm_results' sweep claims no slot, and the places never move for it", async () => {
      const { event, quest } = await bonusQuest(5, 0, 7, { type: "quiz", config: QUIZ });
      const who = await member(event);
      await answeredRight(who, quest);
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
      expect(
        await owner(
          "SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
          [who.enrollment],
        ),
      ).toEqual([{ score_delta: "10" }]);
      expect(await bonuses(quest)).toEqual([]);
      expect(await slotsOf(quest)).toHaveLength(5);
      expect((await slotsOf(quest)).every((slot) => slot.enrollment_id === null)).toBe(true);
    });

    it("a quiz that timed out during play is finished by the tick's sweep and claims as any finish", async () => {
      const { event, quest } = await bonusQuest(5, 0, 7, { type: "quiz", config: QUIZ });
      const who = await member(event);
      await answeredRight(who, quest);
      await owner("UPDATE quest SET closes_at = now() - interval '1 second' WHERE id = $1", [
        quest,
      ]);
      let outcome: string | null | undefined;
      do {
        outcome = (
          await query<{ o: string | null }>(SYSTEM, "SELECT finish_one_due_quiz() AS o")
        )[0]?.o;
      } while (
        outcome !== null &&
        (
          await owner("SELECT 1 FROM quiz_attempt WHERE enrollment_id = $1 AND status = 'open'", [
            who.enrollment,
          ])
        ).length > 0
      );
      expect(
        await owner("SELECT swept FROM quiz_attempt WHERE enrollment_id = $1", [who.enrollment]),
      ).toEqual([{ swept: true }]);
      expect(await bonusOf(who, quest)).toHaveLength(1);
    });
  });

  // ============================================================ crossed locks (CTO MAJOR 2, CTO 4)
  describe("crossed locks", () => {
    it("a meet, the setter's raise and a second completion by one side, on three connections in both orders: no deadlock, exact claims", async () => {
      for (const order of ["setter first", "meet first"] as const) {
        const event = await newEvent();
        const category = await newCategory(event);
        const quest = await newQuest(event, { category, type: "meet", config: { dailyCap: 5 } });
        const other = await newQuest(event, { category });
        await setBonus(event, quest, 7, 1);
        await setBonus(event, other, 5, 1);
        const a = await member(event);
        const b = await member(event);
        const hash = randomBytes(32);
        await query(as(b.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [quest, hash]);
        const meet = () =>
          query(as(a.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
            hash,
            randomUUID(),
          ]);
        const scan = () => complete(b.player, other);
        // Each order is forced: the first transaction holds its locks open while the other two queue behind it.
        if (order === "setter first") {
          const raise = await hold(teamA(), "SELECT set_quest_first_bonus($1, $2, 7, 2, $3)", [
            event,
            quest,
            randomUUID(),
          ]);
          const met = meet();
          expect(await waitsOnLock("meet_player"), order).toBe(true);
          const scanned = scan();
          expect(await waitsOnLock("complete_quest"), order).toBe(true);
          raise.release();
          await Promise.all([raise.done, met, scanned]);
        } else {
          const met = await hold(as(a.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [
            hash,
            randomUUID(),
          ]);
          const raised = setBonus(event, quest, 7, 2);
          expect(await waitsOnLock("set_quest_first_bonus"), order).toBe(true);
          const scanned = scan();
          expect(await waitsOnLock("complete_quest"), order).toBe(true);
          met.release();
          await Promise.all([met.done, raised, scanned]);
        }
        // Raised first, both sides of the meet claim; met first, one slot was left for the lower player id.
        const expected = order === "setter first" ? 2 : 1;
        expect((await bonuses(quest)).length, order).toBe(expected);
        expect(
          await leftOf(event).then((rows) => rows.find((row) => row.quest_id === quest)),
          order,
        ).toMatchObject({ slots: 2, given: expected, free: 2 - expected });
        expect(await bonuses(other), order).toHaveLength(1);
      }
    });

    it("an edit waits for a claim in flight, and a claim during an edit waits and pays the new amount", async () => {
      const { event, quest } = await bonusQuest(5);
      const one = await member(event);
      const claim = await hold(
        as(one.player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      const edit = setBonus(event, quest, 9, 5);
      expect(await waitsOnLock("set_quest_first_bonus")).toBe(true);
      claim.release();
      await claim.done;
      expect(await refusal(edit)).toBe("QB409:first_bonus_paid");

      const fresh = await bonusQuest(5);
      const editing = await hold(teamA(), "SELECT set_quest_first_bonus($1, $2, 9, 5, $3)", [
        fresh.event,
        fresh.quest,
        randomUUID(),
      ]);
      const two = await member(fresh.event);
      const waiting = complete(two.player, fresh.quest);
      expect(await waitsOnLock("complete_quest")).toBe(true);
      editing.release();
      await editing.done;
      await waiting;
      expect(await bonusOf(two, fresh.quest)).toMatchObject([{ score_delta: "9" }]);
    });

    it("Stop during continuous claims on 8 connections finishes in under 2 seconds (CTO 4)", async () => {
      const { event, quest } = await bonusQuest(1000);
      const players = await Promise.all(Array.from({ length: 210 }, () => member(event)));
      const running = { stop: false };
      const loops = Array.from({ length: 8 }, async (_, lane) => {
        for (let next = lane; !running.stop && next < players.length; next += 8) {
          await complete(players[next]?.player ?? "", quest);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      expect(await setBonus(event, quest, null, 0)).toBe("set");
      const took = Date.now() - started;
      const [after] = await leftOf(event);
      running.stop = true;
      await Promise.all(loops);
      expect(took).toBeLessThan(2000);
      expect(after?.free).toBe(0);
      expect(after?.slots).toBe(after?.given);
      expect(await bonuses(quest)).toHaveLength(after?.given ?? -1);
    });
  });

  // ============================================================ the place shown (CTO 5)
  describe("the place shown is the claim's rank (CTO 5)", () => {
    it("lowering 10 to 4 with claims at places 1, 2, 3 and 5 shows places 1 to 4", async () => {
      const { event, quest } = await bonusQuest(10, 3);
      const fourth = await member(event);
      const rolled = await holdThenUndo(
        as(fourth.player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      const fifth = await member(event);
      await complete(fifth.player, quest);
      rolled.release();
      await rolled.done;
      const claimed = async () =>
        (await slotsOf(quest))
          .filter((slot) => slot.enrollment_id !== null)
          .map((slot) => slot.place);
      expect(await claimed()).toEqual([1, 2, 3, 5]);
      expect(await placeOf(fifth, quest)).toBe(4);
      expect(await setBonus(event, quest, 7, 4)).toBe("set");
      expect((await slotsOf(quest)).map((slot) => slot.place)).toEqual([1, 2, 3, 5]);
      expect(await placeOf(fifth, quest)).toBe(4);
      expect(await leftOf(event)).toMatchObject([{ slots: 4, free: 0, given: 4 }]);
    });
  });

  // ============================================================ the setter (ADR-262)
  describe("the setter (ADR-262)", () => {
    it("on, raise, lower, points before any real claim, then first_bonus_paid and below_given; off before", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      expect(await setBonus(event, quest, null, null)).toBe("unchanged");
      expect(await setBonus(event, quest, 7, 3)).toBe("set");
      expect(await setBonus(event, quest, 7, 3)).toBe("unchanged");
      expect(await setBonus(event, quest, 9, 5)).toBe("set");
      expect((await slotsOf(quest)).map((slot) => slot.place)).toEqual([1, 2, 3, 4, 5]);
      expect(await setBonus(event, quest, 9, 2)).toBe("set");
      expect((await slotsOf(quest)).map((slot) => slot.place)).toEqual([1, 2]);
      expect(await setBonus(event, quest, null, null)).toBe("off");
      expect(await owner("SELECT 1 FROM quest_first_bonus WHERE quest_id = $1", [quest])).toEqual(
        [],
      );
      expect(await setBonus(event, quest, 9, 3)).toBe("set");
      await complete((await member(event)).player, quest);
      await complete((await member(event)).player, quest);
      expect(await refusal(setBonus(event, quest, 8, 3))).toBe("QB409:first_bonus_paid");
      expect(await refusal(setBonus(event, quest, null, null))).toBe("QB409:first_bonus_paid");
      expect(await refusal(setBonus(event, quest, 9, 1))).toBe("QB409:below_given");
      expect(await setBonus(event, quest, 9, 6)).toBe("set");
      expect((await slotsOf(quest)).map((slot) => slot.place)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(await setBonus(event, quest, null, 0)).toBe("set");
      expect(await leftOf(event)).toMatchObject([{ points: 9, slots: 2, free: 0, given: 2 }]);
      const audits = await owner<{ before: Row | null; after: Row | null }>(
        `SELECT before, after FROM audit_log WHERE action = 'event.first_bonus_set' AND target_id = $1
         ORDER BY id`,
        [quest],
      );
      expect(audits.at(-1)).toEqual({
        before: { points: 9, slots: 6, given: 2 },
        after: { points: 9, slots: 2, given: 2 },
      });
      expect(audits.filter((row) => row.after === null)).toHaveLength(1);
    });

    it("refuses bad values, another event's quest, another organizer, an editor out of scope, an ended event", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      expect(await refusal(setBonus(event, quest, 0, 3))).toBe("QB422:points");
      expect(await refusal(setBonus(event, quest, 100_001, 3))).toBe("QB422:points");
      expect(await refusal(setBonus(event, quest, 5, 0))).toBe("QB422:slots");
      expect(await refusal(setBonus(event, quest, 5, 1001))).toBe("QB422:slots");
      expect(await refusal(setBonus(event, quest, null, 3))).toBe("QB422:points");
      expect(await refusal(setBonus(event, quest, 100_000, 1000))).toBe("none");
      const other = await newEvent();
      expect(await refusal(setBonus(other, quest, 5, 3))).toBe("QC404");
      expect(await refusal(setBonus(event, quest, 5, 3, teamB()))).toBe("AN404");
      const editor = await addMember(db.owner, ids.orgA, "editor", [other]);
      expect(
        await refusal(setBonus(event, quest, 5, 3, { organizerId: ids.orgA, staffUserId: editor })),
      ).toBe("AN404");
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      expect(await refusal(setBonus(event, quest, 5, 3))).toBe("QE409");
      const ended = await newEvent("live", "-2 days", "-1 hour");
      const late = await newQuest(ended);
      expect(await refusal(setBonus(ended, late, 5, 3))).toBe("QE409");
    });

    it("a quest whose bonus was claimed cannot be deleted (its completions hold it)", async () => {
      const { quest } = await bonusQuest(2, 1);
      expect(await refusal(owner("DELETE FROM quest WHERE id = $1", [quest]))).toBe("23503");
    });

    it("a draft event's delete takes its bonuses and slots", async () => {
      const event = await newEvent("draft", "1 day", "2 days");
      const quest = await newQuest(event);
      await setBonus(event, quest, 5, 3);
      await owner("DELETE FROM event WHERE id = $1", [event]);
      expect(await owner("SELECT 1 FROM quest_bonus_slot WHERE quest_id = $1", [quest])).toEqual(
        [],
      );
    });
  });

  // ============================================================ rehearsal and its wipe
  describe("rehearsal and the go-live wipe", () => {
    it("rehearsal accounts claim 3 of 5; the points stay editable; the first real completion's wipe gives the 3 back", async () => {
      const { event, quest } = await rehearsing();
      expect(await setBonus(event, quest, 8, 5)).toBe("set");
      await goLive(event);
      const real = await member(event);
      await complete(real.player, quest);
      expect(await slotsOf(quest)).toEqual([
        { place: 1, enrollment_id: real.enrollment, rehearsal: false },
        ...[2, 3, 4, 5].map((place) => ({ place, enrollment_id: null, rehearsal: false })),
      ]);
      expect(await placeOf(real, quest)).toBe(1);
      expect(await bonusOf(real, quest)).toMatchObject([{ score_delta: "8" }]);
      const [card] = await owner<{ erase_counts: Row }>(
        "SELECT erase_counts FROM event_rehearsal WHERE event_id = $1",
        [event],
      );
      expect(card?.erase_counts).toMatchObject({ first_bonuses: 3, points: 3 * 10 + 3 * 7 });
    });

    it("Stop with only rehearsal claims switches the bonus off, so the go-live wipe never reopens it", async () => {
      const { event, quest } = await rehearsing();
      expect(await setBonus(event, quest, null, 0)).toBe("off");
      expect(await owner("SELECT 1 FROM quest_first_bonus WHERE quest_id = $1", [quest])).toEqual(
        [],
      );
      await goLive(event);
      await complete((await member(event)).player, quest);
      expect(await bonuses(quest)).toEqual([]);
      expect(await leftOf(event)).toEqual([]);
    });

    it("the tick's wipe and the team's Erase rehearsal give the slots back too", async () => {
      const ticked = await rehearsing();
      await goLive(ticked.event);
      await query(SYSTEM, "SELECT ensure_rehearsal_wiped($1)", [ticked.event]);
      expect(await leftOf(ticked.event)).toMatchObject([{ free: 5, given: 0 }]);
      const erased = await rehearsing();
      await query(teamA(), "SELECT erase_rehearsal($1, $2)", [erased.event, randomUUID()]);
      expect(await leftOf(erased.event)).toMatchObject([{ free: 5, given: 0 }]);
    });

    it("the rehearsal card counts the bonus in its points", async () => {
      const { event } = await rehearsing();
      const [card] = await query<{ points: string }>(teamA(), "SELECT * FROM rehearsal_card($1)", [
        event,
      ]);
      expect(card?.points).toBe(String(3 * 10 + 3 * 7));
    });
  });

  // ============================================================ removal
  describe("removal (Q-223)", () => {
    it("the bonus line goes on its own, the quest line leaves it, and neither frees the slot", async () => {
      const { event, quest } = await bonusQuest(2);
      const one = await member(event);
      const two = await member(event);
      await complete(one.player, quest);
      await complete(two.player, quest);
      const key = randomUUID();
      const [removed] = await remove(event, await entryOf(one, "first_bonus"), key);
      expect((await remove(event, await entryOf(one, "first_bonus"), key))[0]).toMatchObject({
        entry_id: removed?.entry_id,
        replayed: true,
      });
      await remove(event, await entryOf(two, "quest"));
      expect(await scoreOf(one)).toBe("10");
      expect(await scoreOf(two)).toBe("7");
      expect(await leftOf(event)).toMatchObject([{ free: 0, given: 2 }]);
      const late = await member(event);
      await complete(late.player, quest);
      expect(await bonusOf(late, quest)).toEqual([]);
      const [credit] = await owner<{ item: string | null }>(
        "SELECT (credit_item(l)).id AS item FROM ledger_entry l WHERE l.id = $1",
        [await entryOf(one, "first_bonus")],
      );
      expect(credit?.item).toBeNull();
    });

    it("the team's record names the bonus with its place; the quest line hints at it until it is removed", async () => {
      const { event, quest } = await bonusQuest(4);
      const who = await member(event);
      await complete(who.player, quest);
      const record = () =>
        query<{
          kind: string;
          bonus_slots: number | null;
          bonus_place: number | null;
          removable: boolean;
        }>(
          teamA(),
          "SELECT kind, bonus_slots, bonus_place, removable FROM member_ledger($1, $2, NULL, 50) ORDER BY id",
          [event, who.enrollment],
        );
      expect(await record()).toEqual([
        { kind: "quest", bonus_slots: 4, bonus_place: null, removable: true },
        { kind: "first_bonus", bonus_slots: 4, bonus_place: 1, removable: true },
      ]);
      await remove(event, await entryOf(who, "first_bonus"));
      expect((await record())[0]).toMatchObject({ kind: "quest", bonus_slots: null });
      const activity = await query<{ kind: string; bonus_slots: number | null }>(
        as(who.player),
        "SELECT kind, bonus_slots FROM member_activity($1, NULL, 25) ORDER BY id",
        [event],
      );
      expect(activity.map((row) => [row.kind, row.bonus_slots])).toEqual([
        ["quest", null],
        ["first_bonus", 4],
        ["removal", null],
      ]);
    });
  });

  // ============================================================ the amounts
  describe("the amounts (ADR-261)", () => {
    it("never boosted, no XP, the score answered holds both; the category bonus and item still pay once", async () => {
      const event = await newEvent();
      const [item] = await owner<{ id: string }>(
        `INSERT INTO quest_item (organizer_id, event_id, name_en, stock_total)
         VALUES ($1, $2, 'Pin', 5) RETURNING id`,
        [ids.orgA, event],
      );
      const category = await newCategory(event, { completion_bonus: 3 });
      const quest = await newQuest(event, { category });
      await owner("UPDATE quest SET item_id = $2 WHERE id = $1", [quest, item?.id]);
      await setBonus(event, quest, 7, 2);
      await owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         VALUES ($1, $2, $3, now() - interval '5 minutes', now() + interval '30 minutes')`,
        [ids.orgA, event, category],
      );
      const who = await member(event);
      const [paid] = await complete(who.player, quest);
      expect(paid?.points).toBe("20");
      expect(paid?.score).toBe(String(20 + 3 + 7));
      const entries = await owner<{ kind: string; score_delta: string; boost_id: string | null }>(
        "SELECT kind, score_delta, boost_id FROM ledger_entry WHERE enrollment_id = $1 ORDER BY id",
        [who.enrollment],
      );
      expect(entries.map((row) => row.kind).toSorted()).toEqual(["bonus", "first_bonus", "quest"]);
      expect(entries.find((row) => row.kind === "first_bonus")).toMatchObject({
        score_delta: "7",
        boost_id: null,
      });
      expect(
        await owner(
          `SELECT 1 FROM xp_entry x JOIN ledger_entry l ON l.id = x.ledger_entry_id
           WHERE l.enrollment_id = $1 AND l.kind = 'first_bonus'`,
          [who.enrollment],
        ),
      ).toEqual([]);
      expect(
        await owner("SELECT 1 FROM redemption WHERE enrollment_id = $1", [who.enrollment]),
      ).toHaveLength(1);
    });

    it("moves the balance by 0 once the shop has closed (an approval after the event)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      await setBonus(event, quest, 7, 2);
      const who = await member(event);
      const [sent] = await query<{ submission_id: string }>(
        as(who.player),
        "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
        [quest, GUIDELINES, randomUUID()],
      );
      await owner(
        `UPDATE event SET status = 'ended', ends_at = now() - interval '5 days',
                          starts_at = now() - interval '6 days', shop_days_after = 1 WHERE id = $1`,
        [event],
      );
      await query(
        teamA(),
        "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
        [event, sent?.submission_id, randomUUID(), randomUUID()],
      );
      expect(await bonusOf(who, quest)).toEqual([
        { enrollment_id: who.enrollment, score_delta: "7", balance_delta: "0" },
      ]);
    });

    it("the approval order decides who is first, not the sending order (CTO 7)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      await setBonus(event, quest, 7, 2);
      const early = await member(event);
      const late = await member(event);
      const send = async (who: Member) =>
        (
          await query<{ submission_id: string }>(
            as(who.player),
            "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
            [quest, GUIDELINES, randomUUID()],
          )
        )[0]?.submission_id;
      const first = await send(early);
      const second = await send(late);
      for (const sent of [second, first]) {
        await query(
          teamA(),
          "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
          [event, sent, randomUUID(), randomUUID()],
        );
      }
      expect(await placeOf(late, quest)).toBe(1);
      expect(await placeOf(early, quest)).toBe(2);
    });

    it("erasure of a claimer keeps the slot used (CTO 9)", async () => {
      const { event, quest } = await bonusQuest(2);
      const who = await member(event);
      await complete(who.player, quest);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [who.player, who.enrollment]);
      expect(await leftOf(event)).toMatchObject([{ free: 1, given: 1 }]);
    });
  });

  // ============================================================ the readers (ADR-263, CTO 6)
  describe("the readers", () => {
    it("first_bonus_left counts for a member and the team, and gives a stranger or another organizer nothing", async () => {
      const { event, quest } = await bonusQuest(3, 1);
      const who = await member(event);
      expect(await leftOf(event, as(who.player))).toEqual([
        { quest_id: quest, points: 7, slots: 3, free: 2, given: 1, real_given: 1 },
      ]);
      const stranger = await member(await newEvent());
      expect(await leftOf(event, as(stranger.player))).toEqual([]);
      expect(await leftOf(event, teamB())).toEqual([]);
      expect(await leftOf(event, SYSTEM)).toEqual([]);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [who.enrollment]);
      expect(await leftOf(event, as(who.player))).toEqual([]);
    });

    it("own_first_bonus answers the caller's own completion only: won, all taken, or nothing", async () => {
      const { event, quest } = await bonusQuest(1);
      const one = await member(event);
      const two = await member(event);
      const [won] = await complete(one.player, quest);
      const [missed] = await complete(two.player, quest);
      expect(await own(one.player, won?.completion_id)).toEqual([
        { points: 7, place: 1, slots: 1 },
      ]);
      expect(await own(two.player, missed?.completion_id)).toEqual([
        { points: 7, place: null, slots: 1 },
      ]);
      expect(await own(two.player, won?.completion_id)).toEqual([]);
      const [again] = await complete(one.player, quest);
      expect(await own(one.player, again?.completion_id)).toEqual([]);
      const plain = await newQuest(event);
      const [none] = await complete(one.player, plain);
      expect(await own(one.player, none?.completion_id)).toEqual([]);
    });

    it("the quest list shows the bonus and the caller's place; live lists only what the member may play and has not done", async () => {
      const event = await newEvent();
      const open = await newQuest(event);
      const done = await newQuest(event);
      const hidden = await newQuest(event, { visible: false });
      const later = await newQuest(event);
      const flash = await newQuest(event);
      const plain = await newQuest(event);
      await owner("UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1", [later]);
      await owner(
        `UPDATE quest SET flash = true, visible = true, opens_at = now() + interval '5 minutes',
                          closes_at = now() + interval '30 minutes' WHERE id = $1`,
        [flash],
      );
      for (const quest of [open, done, hidden, later, flash]) {
        await setBonus(event, quest, 7, 1);
      }
      const who = await member(event);
      await complete(who.player, done);
      expect((await live(who.player, event))?.firstBonus).toEqual([open]);
      const rows = await query<{
        quest_id: string;
        first_bonus_points: number | null;
        first_bonus_slots: number | null;
        first_bonus_place: number | null;
      }>(
        as(who.player),
        `SELECT quest_id, first_bonus_points, first_bonus_slots, first_bonus_place
         FROM member_event_quests($1)`,
        [event],
      );
      const byQuest = new Map(rows.map((row) => [row.quest_id, row]));
      expect(byQuest.has(hidden)).toBe(false);
      expect(byQuest.has(flash)).toBe(false);
      expect(byQuest.get(done)).toMatchObject({
        first_bonus_points: 7,
        first_bonus_slots: 1,
        first_bonus_place: 1,
      });
      expect(byQuest.get(open)).toMatchObject({ first_bonus_points: 7, first_bonus_place: null });
      expect(byQuest.get(plain)).toMatchObject({
        first_bonus_points: null,
        first_bonus_slots: null,
      });
      const other = await member(event);
      await complete(other.player, open);
      expect((await live(who.player, event))?.firstBonus).toEqual([open]);
      expect(await leftOf(event, as(who.player))).toContainEqual(
        expect.objectContaining({ quest_id: open, free: 0 }),
      );
    });

    it("event_has_live stays true while a slot is free and for 15 minutes after the last claim", async () => {
      const { event, quest } = await bonusQuest(1);
      const hasLive = async () =>
        (await query<{ h: boolean }>(SYSTEM, "SELECT event_has_live($1) AS h", [event]))[0]?.h;
      expect(await hasLive()).toBe(true);
      await complete((await member(event)).player, quest);
      expect(await hasLive()).toBe(true);
      await owner(
        "UPDATE quest_bonus_slot SET claimed_at = now() - interval '16 minutes' WHERE quest_id = $1",
        [quest],
      );
      expect(await hasLive()).toBe(false);
      // Only a live event, and only while the quest is not closed (CTO code review 1).
      const { event: closing, quest: closed } = await bonusQuest(1);
      expect(await hasLiveOf(closing)).toBe(true);
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
        closed,
      ]);
      expect(await hasLiveOf(closing)).toBe(false);
      const later = await newEvent("scheduled", "1 day", "2 days");
      await setBonus(later, await newQuest(later), 7, 1);
      expect(await hasLiveOf(later)).toBe(false);
    });

    it("a community points goal counts the bonus", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await setBonus(event, quest, 7, 5);
      const [goal] = await owner<{ id: string }>(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at,
                                     paid_to)
         VALUES ($1, $2, 'Light it', 'points', 1000, now() - interval '10 minutes', now() + interval '1 hour',
                 'everyone') RETURNING id`,
        [ids.orgA, event],
      );
      await complete((await member(event)).player, quest);
      const [slice] = await owner<{ settled: string; tail: string }>(
        `SELECT settled, tail FROM community_read_slice((SELECT g FROM community_goal g WHERE g.id = $1),
                now() + interval '1 hour', now() - interval '1 hour', now() + interval '1 minute',
                now() + interval '1 minute')`,
        [goal?.id],
      );
      expect(Number(slice?.settled) + Number(slice?.tail)).toBe(17);
    });
  });

  // ============================================================ the ledger's shape
  describe("the ledger's shape", () => {
    it("refuses a forged bonus: no completion, a boost, a negative amount, a second per completion or player", async () => {
      const { event, quest } = await bonusQuest(2);
      const who = await member(event);
      const [paid] = await complete(who.player, quest);
      const [boost] = await owner<{ id: string }>(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         SELECT $1, $2, q.category_id, now() + interval '1 hour', now() + interval '2 hours'
         FROM quest q WHERE q.id = $3
         RETURNING id`,
        [ids.orgA, event, quest],
      );
      const forge = (
        fields: Readonly<{ completion?: string | null; points?: number; boost?: string | null }>,
      ) =>
        refusal(
          owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                       completion_id, quest_id, actor, boost_id)
             VALUES ($1, $2, $3, 'first_bonus', $4, $4, $5, $6, 'system', $7)`,
            [
              ids.orgA,
              event,
              who.enrollment,
              fields.points ?? 5,
              fields.completion === undefined ? paid?.completion_id : fields.completion,
              quest,
              fields.boost ?? null,
            ],
          ),
        );
      expect(await forge({ completion: null })).toBe("23514");
      expect(await forge({ points: -5 })).toBe("23514");
      expect(await forge({ boost: boost?.id ?? null })).toBe("23514");
      expect(await forge({})).toBe("23505");
      const [later] = await complete(who.player, quest);
      expect(await forge({ completion: later?.completion_id ?? null })).toBe("23505");
    });

    it("keeps both tables closed to the API role", async () => {
      for (const table of ["quest_first_bonus", "quest_bonus_slot"]) {
        expect(await refusal(query(teamA(), `SELECT * FROM ${table}`)), table).toBe("42501");
      }
    });
  });

  // ============================================================ the payer completeness rule
  describe("the payer completeness rule", () => {
    it("every function that calls pay_completion also claims the first-N bonus; record_completion claims itself", async () => {
      const found = await owner<{ name: string; claims: boolean }>(
        `SELECT DISTINCT p.proname AS name, p.prosrc ~* 'pay_first_bonus\\s*\\(' AS claims
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND (p.prosrc ~* '(public\\.)?pay_completion\\s*\\(' OR p.proname = 'record_completion')
           AND p.proname <> 'pay_completion'
         ORDER BY 1`,
      );
      expect(found.filter((row) => !row.claims).map((row) => row.name)).toEqual([]);
      expect(found.map((row) => row.name)).toEqual([
        "finish_game_round",
        "finish_quiz",
        "pay_meeting",
        "pay_submission",
        "record_completion",
        "stamp_step",
      ]);
    });
  });
});
