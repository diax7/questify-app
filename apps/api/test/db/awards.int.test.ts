import { randomUUID } from "node:crypto";
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

const refusal = async (
  work: Promise<unknown>,
): Promise<{ code: string; detail?: string; hint?: string }> => {
  try {
    await work;
  } catch (error) {
    const { code, detail, hint } = error as { code: string; detail?: string; hint?: string };
    return {
      code,
      ...(detail === undefined ? {} : { detail }),
      ...(hint === undefined ? {} : { hint }),
    };
  }
  throw new Error("expected a refusal");
};

/**
 * Manual awards in the database (T-207, migration 0030): the operator's and the dashboard's awards and their caps,
 * removals that never go below zero (FR-1601), bulk awards, the report, and the races between them.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("manual awards (database)", () => {
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

  const newEvent = async (
    fields: { status?: string; spendLowersRank?: boolean; organizer?: string } = {},
  ): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en,
                          spend_lowers_rank, award_cap_each, award_cap_day)
       VALUES ($1, $2, 'Award Fest', $3, now() - interval '1 hour', now() + interval '2 days', 'Hall B', $4, 200, 500)
       RETURNING id`,
      [
        fields.organizer ?? ids.orgA,
        `AWD${counter}`,
        fields.status ?? "live",
        fields.spendLowersRank ?? false,
      ],
    );
    return event?.id ?? "";
  };

  const newQuest = async (event: string, points = 50, repeatCap = 1): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
       VALUES ($1, $2, 'scan_qr', 'Treasure', $3, $4) RETURNING id`,
      [event, category?.id, points, repeatCap],
    );
    return quest?.id ?? "";
  };

  const newPlayer = async (event: string, phone?: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`Award_Player_${counter}`],
    );
    if (phone !== undefined) {
      await owner("INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, $2)", [
        player?.id,
        phone,
      ]);
    }
    const [org] = await owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [event],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [org?.organizer_id, event, player?.id],
    );
    return {
      player: player?.id ?? "",
      enrollment: enrolled?.id ?? "",
      username: `Award_Player_${counter}`,
    };
  };

  const newOperator = async (
    event: string,
    fields: { abilities?: string[]; canPlay?: boolean; quests?: string[] } = {},
  ) => {
    const made = await newPlayer(event);
    const [org] = await owner<{ organizer_id: string }>(
      "SELECT organizer_id FROM event WHERE id = $1",
      [event],
    );
    const [assignment] = await owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        org?.organizer_id,
        event,
        made.player,
        fields.abilities ?? ["award"],
        fields.canPlay ?? true,
      ],
    );
    for (const quest of fields.quests ?? []) {
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [assignment?.id, event, quest],
      );
    }
    return made.player;
  };

  const as = async <T>(context: RequestContext, work: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, context, () => work(client));
    } finally {
      client.release();
    }
  };
  const query = <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    as(context, async (client) => (await client.query<T>(sql, values)).rows);
  const staff = (user: string, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: user,
  });

  type Awarded = { entry_id: string; points: string; replayed: boolean };
  const opAward = async (
    operator: string,
    event: string,
    enrollment: string,
    award: { quest?: string; amount?: number; reason?: string; key?: string },
  ) =>
    (
      await query<Awarded>(
        { playerId: operator },
        "SELECT * FROM operator_award($1, $2, $3, $4, $5, $6)",
        [
          event,
          enrollment,
          award.quest ?? null,
          award.amount ?? null,
          award.reason ?? "Code failed",
          award.key ?? randomUUID(),
        ],
      )
    )[0];
  const staffAward = async (
    user: string,
    event: string,
    enrollment: string,
    award: { quest?: string; amount?: number; reason?: string; key?: string },
  ) =>
    (
      await query<Awarded>(staff(user), "SELECT * FROM staff_award($1, $2, $3, $4, $5, $6, $7)", [
        event,
        enrollment,
        award.quest ?? null,
        award.amount ?? null,
        award.reason ?? "Helped",
        award.key ?? randomUUID(),
        randomUUID(),
      ])
    )[0];
  type Removed = {
    entry_id: string;
    score_delta: string;
    balance_delta: string;
    replayed: boolean;
  };
  const remove = async (
    user: string,
    event: string,
    entry: string,
    key = randomUUID(),
    reason = "Cheating",
  ) =>
    (
      await query<Removed>(staff(user), "SELECT * FROM remove_award($1, $2, $3, $4, $5)", [
        event,
        entry,
        reason,
        key,
        randomUUID(),
      ])
    )[0];
  const standing = async (enrollment: string) =>
    (
      await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];

  const fund = async (event: string, enrollment: string, amount: number) =>
    (await staffAward(ownerA, event, enrollment, { amount }))?.entry_id ?? "";

  const bulk = async (
    user: string,
    event: string,
    target: { enrollments?: string[]; quest?: string },
    amount = 50,
    key = randomUUID(),
  ) =>
    (
      await query<{ bulk_id: string; awarded: number; skipped: number; replayed: boolean }>(
        staff(user),
        "SELECT * FROM bulk_award($1, $2, $3, $4, 'Code failed', $5, $6)",
        [event, target.enrollments ?? null, target.quest ?? null, amount, key, randomUUID()],
      )
    )[0];

  describe("the operator's award", () => {
    it("records points with the operator, the reason and the ranking mark", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const { enrollment } = await newPlayer(event);
      const done = await opAward(operator, event, enrollment, {
        amount: 40,
        reason: "  QR was torn  ",
      });
      expect(done).toMatchObject({ points: "40", replayed: false });
      const [entry] = await owner<Row>(
        `SELECT l.kind, l.actor, l.operator_id, l.score_delta, l.balance_delta, n.reason
         FROM ledger_entry l JOIN ledger_note n ON n.entry_id = l.id WHERE l.id = $1`,
        [done?.entry_id],
      );
      expect(entry).toEqual({
        kind: "award",
        actor: "operator",
        operator_id: operator,
        score_delta: "40",
        balance_delta: "40",
        reason: "QR was torn",
      });
      expect(await standing(enrollment)).toEqual({ score: "40", balance: "40" });
    });

    it("awards a quest by hand as a manual completion inside the repeat cap", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 30);
      const operator = await newOperator(event);
      const { enrollment } = await newPlayer(event);
      expect(await opAward(operator, event, enrollment, { quest })).toMatchObject({ points: "30" });
      const [completion] = await owner<{ method: string }>(
        "SELECT method FROM quest_completion WHERE enrollment_id = $1",
        [enrollment],
      );
      expect(completion?.method).toBe("manual");
      expect(await refusal(opAward(operator, event, enrollment, { quest }))).toMatchObject({
        code: "QD409",
      });
    });

    it("holds the per-award cap at its edge", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const { enrollment } = await newPlayer(event);
      expect(await opAward(operator, event, enrollment, { amount: 200 })).toMatchObject({
        points: "200",
      });
      expect(await refusal(opAward(operator, event, enrollment, { amount: 201 }))).toEqual({
        code: "AC409",
        detail: "each",
        hint: "200,300",
      });
    });

    it("holds the daily cap across awards and quests, and removals do not refund it", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 100);
      const operator = await newOperator(event);
      const one = await newPlayer(event);
      const two = await newPlayer(event);
      await opAward(operator, event, one.enrollment, { amount: 200 });
      const second = await opAward(operator, event, two.enrollment, { amount: 200 });
      await remove(ownerA, event, second?.entry_id ?? "");
      expect(await opAward(operator, event, one.enrollment, { quest })).toMatchObject({
        points: "100",
      });
      expect(await refusal(opAward(operator, event, two.enrollment, { amount: 1 }))).toEqual({
        code: "AC409",
        detail: "day",
        hint: "500,0",
      });
      const [state] = await query<Row>(
        { playerId: operator },
        "SELECT * FROM operator_award_state($1)",
        [event],
      );
      expect(state).toEqual({ cap_each: 200, cap_day: 500, left_today: "0", live: true });
    });

    it("refuses each rule with its own code", async () => {
      const event = await newEvent();
      const limited = await newQuest(event);
      const other = await newQuest(event);
      const operator = await newOperator(event, { quests: [limited] });
      const off = await newOperator(event, { abilities: ["scan_quests"] });
      const { enrollment } = await newPlayer(event);
      const [mine] = await owner<{ id: string }>(
        "SELECT id FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, operator],
      );
      const stranger = await newPlayer(ids.eventA);
      expect(await refusal(opAward(off, event, enrollment, { amount: 5 }))).toMatchObject({
        code: "OA403",
      });
      expect(
        await refusal(opAward(stranger.player, event, enrollment, { amount: 5 })),
      ).toMatchObject({
        code: "OP403",
      });
      expect(await refusal(opAward(operator, event, mine?.id ?? "", { amount: 5 }))).toMatchObject({
        code: "AY409",
      });
      expect(await refusal(opAward(operator, event, enrollment, { quest: other }))).toMatchObject({
        code: "OS403",
      });
      expect(
        await refusal(opAward(operator, event, enrollment, { amount: 5, reason: "   " })),
      ).toMatchObject({
        code: "AR400",
      });
      expect(await refusal(opAward(operator, event, enrollment, { amount: 0 }))).toMatchObject({
        code: "AP400",
      });
      expect(
        await refusal(opAward(operator, event, stranger.enrollment, { amount: 5 })),
      ).toMatchObject({
        code: "QC404",
      });
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [enrollment]);
      expect(await refusal(opAward(operator, event, enrollment, { amount: 5 }))).toEqual({
        code: "QC403",
        detail: "banned",
      });
    });

    it("refuses outside a live event and to an operator who may not play", async () => {
      const ended = await newEvent({ status: "ended" });
      const operator = await newOperator(ended);
      const { enrollment } = await newPlayer(ended);
      expect(await refusal(opAward(operator, ended, enrollment, { amount: 5 }))).toEqual({
        code: "QN403",
        detail: "event_not_live",
      });
      const event = await newEvent();
      const awarding = await newOperator(event);
      const benched = await newOperator(event, { abilities: ["scan_quests"], canPlay: false });
      const [benchedRow] = await owner<{ id: string }>(
        "SELECT id FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, benched],
      );
      expect(
        await refusal(opAward(awarding, event, benchedRow?.id ?? "", { amount: 5 })),
      ).toMatchObject({
        code: "QP403",
      });
    });

    it("replays a key and refuses it for another award", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const { enrollment } = await newPlayer(event);
      const key = randomUUID();
      const first = await opAward(operator, event, enrollment, { amount: 20, key });
      expect(await opAward(operator, event, enrollment, { amount: 20, key })).toEqual({
        ...first,
        replayed: true,
      });
      expect(
        await refusal(opAward(operator, event, enrollment, { amount: 21, key })),
      ).toMatchObject({
        code: "AK422",
      });
      expect(await standing(enrollment)).toEqual({ score: "20", balance: "20" });
    });

    it.each([
      ["another event of the organizer", undefined],
      ["another organizer's event (cross-tenant)", "orgB"],
    ] as const)(
      "refuses a replayed key that names a quest of %s, from both seats, writing nothing",
      async (_, otherOrganizer) => {
        const event = await newEvent();
        const quest = await newQuest(event, 10, 5);
        const operator = await newOperator(event);
        const sara = await newPlayer(event);
        const other = await newEvent(otherOrganizer === undefined ? {} : { organizer: ids.orgB });
        const foreign = await newQuest(other, 10, 5);
        const [org] = await owner<{ organizer_id: string }>(
          "SELECT organizer_id FROM event WHERE id = $1",
          [other],
        );
        const [there] = await owner<{ id: string }>(
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
          [org?.organizer_id, other, sara.player],
        );
        const opKey = randomUUID();
        const staffKey = randomUUID();
        await opAward(operator, event, sara.enrollment, { quest, key: opKey });
        await staffAward(ownerA, event, sara.enrollment, { quest, key: staffKey });
        expect(
          await refusal(opAward(operator, event, sara.enrollment, { quest: foreign, key: opKey })),
        ).toMatchObject({ code: "AQ404" });
        expect(
          await refusal(
            staffAward(ownerA, event, sara.enrollment, { quest: foreign, key: staffKey }),
          ),
        ).toMatchObject({ code: "AQ404" });
        expect(
          await owner("SELECT 1 FROM quest_completion WHERE enrollment_id = $1", [there?.id]),
        ).toHaveLength(0);
        expect(
          await owner("SELECT 1 FROM ledger_entry WHERE enrollment_id = $1", [there?.id]),
        ).toHaveLength(0);
        expect(await standing(sara.enrollment)).toEqual({ score: "20", balance: "20" });
      },
    );

    it("lets two awards race to the daily cap and pays only one", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const { enrollment } = await newPlayer(event);
      await opAward(operator, event, enrollment, { amount: 200 });
      await opAward(operator, event, enrollment, { amount: 150 });
      const results = await Promise.allSettled([
        opAward(operator, event, enrollment, { amount: 150 }),
        opAward(operator, event, enrollment, { amount: 150 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await standing(enrollment)).toEqual({ score: "500", balance: "500" });
    });

    it("finds one member by exact username or phone, without telling who is banned", async () => {
      const event = await newEvent();
      const operator = await newOperator(event);
      const found = await newPlayer(event, "+966500000101");
      const banned = await newPlayer(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      const find = (name: string | null, phone: string | null) =>
        query<Row>({ playerId: operator }, "SELECT * FROM operator_find_player($1, $2, $3)", [
          event,
          name,
          phone,
        ]);
      expect(await find(found.username.toLowerCase(), null)).toEqual([
        {
          enrollment_id: found.enrollment,
          username: found.username,
          avatar: expect.any(String),
          active: true,
        },
      ]);
      expect((await find(null, "+966500000101"))[0]?.["enrollment_id"]).toBe(found.enrollment);
      expect(await find(found.username.slice(0, 6), null)).toEqual([]);
      expect((await find(banned.username, null))[0]?.["active"]).toBe(false);
      const outsider = await newPlayer(ids.eventA);
      expect(await find(outsider.username, null)).toEqual([]);
      const off = await newOperator(event, { abilities: ["scan_quests"] });
      expect(
        await refusal(
          query({ playerId: off }, "SELECT * FROM operator_find_player($1, $2, NULL)", [
            event,
            "x",
          ]),
        ),
      ).toMatchObject({ code: "OA403" });
    });
  });

  describe("the dashboard's award", () => {
    it("caps an editor and not the owner, names the staff user and audits", async () => {
      const event = await newEvent();
      const { enrollment } = await newPlayer(event);
      expect(await refusal(staffAward(editorA, event, enrollment, { amount: 201 }))).toMatchObject({
        code: "AC409",
        detail: "each",
      });
      const big = await staffAward(ownerA, event, enrollment, { amount: 5000 });
      const [entry] = await owner<Row>(
        "SELECT actor, staff_user_id FROM ledger_entry WHERE id = $1",
        [big?.entry_id],
      );
      expect(entry).toEqual({ actor: "staff", staff_user_id: ownerA });
      const [audit] = await owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE event_id = $1 AND action = 'event.manual_award'",
        [event],
      );
      expect(audit?.action).toBe("event.manual_award");
    });

    it("awards a quest as a staff completion", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 70);
      const { enrollment } = await newPlayer(event);
      expect(await staffAward(editorA, event, enrollment, { quest })).toMatchObject({
        points: "70",
      });
    });

    it("keeps an editor inside their event limit and organizers inside their tenant", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const { enrollment } = await newPlayer(event);
      const scoped = await addMember(db.owner, ids.orgA, "editor", [other]);
      expect(await refusal(staffAward(scoped, event, enrollment, { amount: 5 }))).toMatchObject({
        code: "AN404",
      });
      expect(
        await refusal(
          query(
            staff(ownerB, ids.orgB),
            "SELECT * FROM staff_award($1, $2, NULL, 5, 'x', $3, $4)",
            [event, enrollment, randomUUID(), randomUUID()],
          ),
        ),
      ).toMatchObject({ code: "AN404" });
    });

    it("lets an editor's two awards race to the daily cap and pays only one", async () => {
      const event = await newEvent();
      const { enrollment } = await newPlayer(event);
      const editor = await addMember(db.owner, ids.orgA, "editor");
      await staffAward(editor, event, enrollment, { amount: 200 });
      await staffAward(editor, event, enrollment, { amount: 150 });
      const results = await Promise.allSettled([
        staffAward(editor, event, enrollment, { amount: 150 }),
        staffAward(editor, event, enrollment, { amount: 150 }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    });

    it("lets only the owner set the caps, inside their bounds", async () => {
      const event = await newEvent();
      const set = (user: string, each: number, day: number) =>
        query<{ set_award_caps: string }>(staff(user), "SELECT set_award_caps($1, $2, $3, $4)", [
          event,
          each,
          day,
          randomUUID(),
        ]);
      expect((await set(editorA, 10, 20))[0]?.set_award_caps).toBe("not_owner");
      expect((await set(ownerA, 10, 20))[0]?.set_award_caps).toBe("changed");
      expect((await set(ownerA, 10, 20))[0]?.set_award_caps).toBe("unchanged");
      expect(await refusal(set(ownerA, 30, 20))).toMatchObject({ code: "23514" });
    });
  });

  describe("removing an award", () => {
    it("drops the score by the full amount and the balance to no less than zero (FR-1601)", async () => {
      const event = await newEvent();
      const reward = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 150, 9) RETURNING id",
        [event],
      );
      const poor = await newPlayer(event);
      const award = await fund(event, poor.enrollment, 200);
      await query({ playerId: poor.player }, "SELECT * FROM reserve_reward($1, $2)", [
        reward[0]?.id,
        randomUUID(),
      ]);
      await owner(
        "UPDATE redemption SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = $2 WHERE enrollment_id = $1",
        [poor.enrollment, poor.player],
      );
      expect(await standing(poor.enrollment)).toEqual({ score: "200", balance: "50" });
      expect(await remove(editorA, event, award)).toMatchObject({
        score_delta: "-200",
        balance_delta: "-50",
      });
      expect(await standing(poor.enrollment)).toEqual({ score: "0", balance: "0" });

      const rich = await newPlayer(event);
      const big = await fund(event, rich.enrollment, 300);
      const small = await fund(event, rich.enrollment, 200);
      expect(big).not.toBe("");
      await remove(ownerA, event, small);
      expect(await standing(rich.enrollment)).toEqual({ score: "300", balance: "300" });
    });

    it("clamps the score when a spend already lowered the rank", async () => {
      const event = await newEvent({ spendLowersRank: true });
      const reward = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 200, 9) RETURNING id",
        [event],
      );
      const { player, enrollment } = await newPlayer(event);
      const award = await fund(event, enrollment, 200);
      const [made] = await query<{ redemption_id: string }>(
        { playerId: player },
        "SELECT * FROM reserve_reward($1, $2)",
        [reward[0]?.id, randomUUID()],
      );
      await owner(
        "UPDATE redemption SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = $2 WHERE id = $1",
        [made?.redemption_id, player],
      );
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      expect(await remove(ownerA, event, award)).toMatchObject({
        score_delta: "0",
        balance_delta: "0",
      });
      const [report] = await query<Row>(
        staff(ownerA),
        "SELECT * FROM manual_awards($1, NULL, NULL)",
        [event],
      );
      expect(report).toMatchObject({ kind: "removal", points: "200", reverses: award });
    });

    it("waits for an open reservation when it would clamp, and leaves it alone when it would not", async () => {
      const event = await newEvent();
      const reward = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 150, 9) RETURNING id",
        [event],
      );
      const { player, enrollment } = await newPlayer(event);
      const award = await fund(event, enrollment, 200);
      const [made] = await query<{ redemption_id: string }>(
        { playerId: player },
        "SELECT * FROM reserve_reward($1, $2)",
        [reward[0]?.id, randomUUID()],
      );
      expect(await refusal(remove(ownerA, event, award))).toMatchObject({ code: "AO409" });
      await query({ playerId: player }, "SELECT cancel_redemption($1)", [made?.redemption_id]);
      await remove(ownerA, event, award);
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });

      const other = await newPlayer(event);
      await fund(event, other.enrollment, 300);
      const extra = await fund(event, other.enrollment, 200);
      const [held] = await query<{ redemption_id: string }>(
        { playerId: other.player },
        "SELECT * FROM reserve_reward($1, $2)",
        [reward[0]?.id, randomUUID()],
      );
      await remove(ownerA, event, extra);
      expect(await standing(other.enrollment)).toEqual({ score: "300", balance: "150" });
      await query({ playerId: other.player }, "SELECT cancel_redemption($1)", [
        held?.redemption_id,
      ]);
      expect(await standing(other.enrollment)).toEqual({ score: "300", balance: "300" });
    });

    it("keeps a removed quest used", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 40);
      const { enrollment } = await newPlayer(event);
      const awarded = await staffAward(ownerA, event, enrollment, { quest });
      await remove(ownerA, event, awarded?.entry_id ?? "");
      expect(await refusal(staffAward(ownerA, event, enrollment, { quest }))).toMatchObject({
        code: "QD409",
      });
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
    });

    it("removes once, replays its key, and refuses what is not an award", async () => {
      const event = await newEvent();
      const reward = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 10, 9) RETURNING id",
        [event],
      );
      const { player, enrollment } = await newPlayer(event);
      const award = await fund(event, enrollment, 100);
      const key = randomUUID();
      const first = await remove(ownerA, event, award, key);
      expect(await remove(ownerA, event, award, key)).toEqual({ ...first, replayed: true });
      expect(await refusal(remove(ownerA, event, award))).toMatchObject({ code: "AD409" });
      await fund(event, enrollment, 100);
      await query({ playerId: player }, "SELECT * FROM reserve_reward($1, $2)", [
        reward[0]?.id,
        randomUUID(),
      ]);
      const [spend] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'redeem'",
        [enrollment],
      );
      expect(await refusal(remove(ownerA, event, spend?.id ?? ""))).toMatchObject({
        code: "AT422",
      });
      expect(await refusal(remove(ownerA, event, award, randomUUID(), " "))).toMatchObject({
        code: "AR400",
      });
      const elsewhere = await newEvent();
      expect(await refusal(remove(ownerA, elsewhere, award))).toMatchObject({ code: "AE404" });
    });

    it("works after the event ended and not before it starts", async () => {
      const event = await newEvent();
      const { enrollment } = await newPlayer(event);
      const award = await fund(event, enrollment, 100);
      await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [event]);
      expect(await remove(ownerA, event, award)).toMatchObject({ score_delta: "-100" });
      const draft = await newEvent({ status: "draft" });
      const later = await newPlayer(draft);
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
         VALUES ($1, $2, $3, 'welcome', 10, 10, 'system')`,
        [ids.orgA, draft, later.enrollment],
      );
      const [welcome] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1",
        [later.enrollment],
      );
      expect(await refusal(remove(ownerA, draft, welcome?.id ?? ""))).toMatchObject({
        code: "AS409",
      });
    });

    it("lets two removals of one entry race and takes the points once", async () => {
      const event = await newEvent();
      const { enrollment } = await newPlayer(event);
      await fund(event, enrollment, 500);
      const award = await fund(event, enrollment, 100);
      const results = await Promise.allSettled([
        remove(ownerA, event, award),
        remove(editorA, event, award),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await standing(enrollment)).toEqual({ score: "500", balance: "500" });
    });

    it("lets a removal race a reservation and never leaves a negative balance or a free refund", async () => {
      const event = await newEvent();
      const reward = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 200, 9) RETURNING id",
        [event],
      );
      const { player, enrollment } = await newPlayer(event);
      const award = await fund(event, enrollment, 200);
      const results = await Promise.allSettled([
        remove(ownerA, event, award),
        query<{ redemption_id: string }>(
          { playerId: player },
          "SELECT * FROM reserve_reward($1, $2)",
          [reward[0]?.id, randomUUID()],
        ),
      ]);
      const after = await standing(enrollment);
      expect(Number(after?.balance)).toBeGreaterThanOrEqual(0);
      if (results[0].status === "fulfilled") {
        expect(after).toEqual({ score: "0", balance: "0" });
      } else {
        expect(await refusal(Promise.reject(results[0].reason))).toMatchObject({ code: "AO409" });
      }
    });
  });

  describe("bulk awards", () => {
    it("awards a list, skipping strangers, inactive members and benched operators", async () => {
      const event = await newEvent();
      const one = await newPlayer(event);
      const two = await newPlayer(event);
      const banned = await newPlayer(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
      const benched = await newOperator(event, { abilities: ["scan_quests"], canPlay: false });
      const [benchedRow] = await owner<{ id: string }>(
        "SELECT id FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, benched],
      );
      const stranger = await newPlayer(ids.eventA);
      const done = await bulk(editorA, event, {
        enrollments: [
          one.enrollment,
          two.enrollment,
          one.enrollment,
          banned.enrollment,
          benchedRow?.id ?? "",
          stranger.enrollment,
        ],
      });
      expect(done).toMatchObject({ awarded: 2, skipped: 4, replayed: false });
      expect(await standing(one.enrollment)).toEqual({ score: "50", balance: "50" });
      expect(await standing(stranger.enrollment)).toEqual({ score: "0", balance: "0" });
      const [note] = await owner<{ reason: string | null; bulk_id: string }>(
        "SELECT n.reason, n.bulk_id FROM ledger_note n JOIN ledger_entry l ON l.id = n.entry_id WHERE l.enrollment_id = $1",
        [one.enrollment],
      );
      expect(note).toEqual({ reason: null, bulk_id: done?.bulk_id });
    });

    it("caps an editor's bulk per award only, and never counts it toward the daily cap", async () => {
      const event = await newEvent();
      const one = await newPlayer(event);
      expect(
        await refusal(bulk(editorA, event, { enrollments: [one.enrollment] }, 201)),
      ).toMatchObject({
        code: "AC409",
      });
      await bulk(ownerA, event, { enrollments: [one.enrollment] }, 5000);
      const editor = await addMember(db.owner, ids.orgA, "editor");
      await bulk(editor, event, { enrollments: [one.enrollment] }, 200);
      await bulk(editor, event, { enrollments: [one.enrollment] }, 200);
      await bulk(editor, event, { enrollments: [one.enrollment] }, 200);
      expect(await staffAward(editor, event, one.enrollment, { amount: 200 })).toMatchObject({
        points: "200",
      });
    });

    it("replays its key and refuses it for another bulk", async () => {
      const event = await newEvent();
      const one = await newPlayer(event);
      const key = randomUUID();
      const first = await bulk(ownerA, event, { enrollments: [one.enrollment] }, 50, key);
      expect(await bulk(ownerA, event, { enrollments: [one.enrollment] }, 50, key)).toEqual({
        ...first,
        replayed: true,
      });
      expect(
        await refusal(bulk(ownerA, event, { enrollments: [one.enrollment] }, 60, key)),
      ).toMatchObject({
        code: "AK422",
      });
      expect(await standing(one.enrollment)).toEqual({ score: "50", balance: "50" });
    });

    it("reaches a quest's completers, leaving out removed ones", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, 10);
      const one = await newPlayer(event);
      const cheat = await newPlayer(event);
      await staffAward(ownerA, event, one.enrollment, { quest });
      const caught = await staffAward(ownerA, event, cheat.enrollment, { quest });
      await remove(ownerA, event, caught?.entry_id ?? "");
      const [count] = await query<{ quest_bulk_count: number }>(
        staff(editorA),
        "SELECT quest_bulk_count($1, $2)",
        [event, quest],
      );
      expect(count?.quest_bulk_count).toBe(1);
      expect(await bulk(editorA, event, { quest })).toMatchObject({ awarded: 1, skipped: 0 });
      expect(await standing(cheat.enrollment)).toEqual({ score: "0", balance: "0" });
    });

    it("matches pasted lines by username and phone", async () => {
      const event = await newEvent();
      const one = await newPlayer(event, "+966500000202");
      const two = await newPlayer(event);
      const rows = await query<Row>(
        staff(editorA),
        "SELECT * FROM resolve_bulk_targets($1, $2, $3)",
        [event, [two.username.toUpperCase(), "nobody_here"], ["+966500000202"]],
      );
      expect(rows).toEqual([
        {
          line: two.username.toUpperCase(),
          enrollment_id: two.enrollment,
          username: two.username,
          active: true,
        },
        { line: "nobody_here", enrollment_id: null, username: null, active: null },
        {
          line: "+966500000202",
          enrollment_id: one.enrollment,
          username: one.username,
          active: true,
        },
      ]);
    });
  });

  describe("the report and the record", () => {
    it("lists every manual entry with who and why, and says when there are none", async () => {
      const event = await newEvent();
      expect(
        await query(staff(editorA), "SELECT * FROM manual_awards($1, NULL, NULL)", [event]),
      ).toEqual([]);
      const operator = await newOperator(event);
      const { enrollment, username } = await newPlayer(event);
      const award = await opAward(operator, event, enrollment, {
        amount: 30,
        reason: "Helped at the booth",
      });
      await remove(editorA, event, award?.entry_id ?? "", randomUUID(), "Duplicate");
      const rows = await query<Row>(staff(editorA), "SELECT * FROM manual_awards($1, NULL, NULL)", [
        event,
      ]);
      expect(
        rows.map((row) => [
          row["kind"],
          row["points"],
          row["reason"],
          row["username"],
          row["removed"],
        ]),
      ).toEqual([
        ["removal", "30", "Duplicate", username, false],
        ["award", "30", "Helped at the booth", username, true],
      ]);
      expect(rows[1]?.["by_operator"]).toEqual(expect.any(String));
      expect(rows[0]?.["by_staff"]).toEqual(expect.stringContaining("@team.test"));
      const record = await query<Row>(
        staff(editorA),
        "SELECT * FROM member_ledger($1, $2, NULL, NULL)",
        [event, enrollment],
      );
      expect(record.map((row) => [row["kind"], row["removable"], row["removed"]])).toEqual([
        ["removal", false, false],
        ["award", false, true],
      ]);
    });

    it("keeps reasons out of the API role's writes and out of other tenants", async () => {
      const event = await newEvent();
      const { enrollment } = await newPlayer(event);
      await staffAward(ownerA, event, enrollment, { amount: 5 });
      expect(
        await refusal(
          query(staff(ownerA), "UPDATE ledger_note SET reason = 'x' WHERE event_id = $1", [event]),
        ),
      ).toMatchObject({ code: "42501" });
      expect(
        await query(staff(ownerB, ids.orgB), "SELECT * FROM ledger_note WHERE event_id = $1", [
          event,
        ]),
      ).toEqual([]);
      expect(
        await query({ playerId: ids.playerA }, "SELECT * FROM ledger_note WHERE event_id = $1", [
          event,
        ]),
      ).toEqual([]);
    });
  });
});
