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

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

const as = (player: string): RequestContext => ({ playerId: player });
const QUIZ = {
  questions: [
    {
      id: "q1",
      text: { en: "Which?" },
      choices: [
        { id: "r", text: { en: "Right" } },
        { id: "w", text: { en: "Wrong" } },
      ],
      right: "r",
    },
  ],
};
const SURVEY = {
  questions: [{ id: "stars", text: { en: "How was it?" }, kind: "rating", required: true }],
};
const VERIFICATION: Readonly<Record<string, string>> = { scan_qr: "{quest_qr,my_qr}" };

type Redemption = {
  id: string;
  status: string;
  price: number;
  quest_item_id: string;
  source_completion_id: string | null;
  source_category_id: string | null;
  ended_by: string | null;
};

/**
 * Items as quest and category rewards in the database (T-304d, migration 0047, ADR-205): the item given as a price-0
 * desk reservation on a quest's first completion or with a category's bonus once per period; out of stock or the desk
 * closed pays points only and records a miss; links, removal, the desk's guard; ending, handing over and removing;
 * every completion path; rehearsal and erasure; the races.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("quest items (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 10 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
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
  const team = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });

  type EventOptions = { status?: string; hours?: string | null; desk?: string | null };
  const newEvent = async (options: EventOptions = {}): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en, desk_hours)
       VALUES ($1, $2, 'Item Fest', $3, now() - interval '1 hour', now() + interval '30 days', $4,
               $5::tstzmultirange) RETURNING id`,
      [
        ids.orgA,
        `QIT${counter}`,
        options.status ?? "live",
        options.desk === undefined ? "Hall B" : options.desk,
        options.hours ?? null,
      ],
    );
    return event?.id ?? "";
  };
  const newItem = async (event: string, stock = 5): Promise<string> =>
    (
      await owner<{ id: string }>(
        "INSERT INTO quest_item (event_id, name_en, name_ar, stock_total) VALUES ($1, 'T-shirt', 'قميص', $2) RETURNING id",
        [event, stock],
      )
    )[0]?.id ?? "";
  type CategoryOptions = { bonus?: number; refresh?: string; item?: string | null };
  const newCategory = async (event: string, options: CategoryOptions = {}) => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>(
          `INSERT INTO category (event_id, name_en, completion_bonus, refresh, item_id, position)
           VALUES ($1, 'Chapter', $2, $3, $4, $5) RETURNING id`,
          [event, options.bonus ?? 0, options.refresh ?? "none", options.item ?? null, counter],
        )
      )[0]?.id ?? ""
    );
  };
  type QuestOptions = {
    type?: string;
    config?: object;
    cap?: number;
    item?: string | null;
    points?: number;
  };
  const newQuest = async (event: string, category: string, options: QuestOptions = {}) => {
    counter += 1;
    const type = options.type ?? "enter_code";
    return (
      (
        await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position,
                              verification, item_id)
           VALUES ($1, $2, $3, 'Play', $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            event,
            category,
            type,
            options.points ?? 10,
            options.cap ?? 1,
            JSON.stringify(options.config ?? (type === "enter_code" ? { code: "ABC" } : {})),
            counter,
            VERIFICATION[type] ?? "{}",
            options.item ?? null,
          ],
        )
      )[0]?.id ?? ""
    );
  };
  const member = async (event: string, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`qi_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const operatorOf = async (event: string, abilities: string[]) => {
    const { player } = await member(event);
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [ids.orgA, event, player, abilities],
    );
    return player;
  };
  const code = async (player: string, quest: string, key: string = randomUUID()) =>
    (
      await query<{ completion_id: string; occurrence: number; score: string; replayed: boolean }>(
        as(player),
        "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
        [quest, key],
      )
    )[0] as { completion_id: string; occurrence: number; score: string; replayed: boolean };
  const award = async (event: string, enrollment: string, quest: string) =>
    query<{ entry_id: string }>(
      team(),
      "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)",
      [event, enrollment, quest, randomUUID(), randomUUID()],
    );
  const remove = async (event: string, entry: string, key: string = randomUUID()) =>
    (
      await query<{ item: string | null; replayed: boolean }>(
        team(),
        "SELECT * FROM remove_award($1, $2, 'Cheating', $3, $4)",
        [event, entry, key, randomUUID()],
      )
    )[0];
  const playQuiz = async (player: string, quest: string, choice: string) => {
    await query(as(player), "SELECT quiz_start($1)", [quest]);
    await query(as(player), "SELECT quiz_next($1)", [quest]);
    await query(as(player), "SELECT quiz_answer($1, 'q1', $2)", [quest, choice]);
  };
  const itemOf = async (player: string, completion: string) =>
    query<{ name_en: string; outcome: string }>(
      as(player),
      "SELECT name_en, outcome FROM own_quest_item($1)",
      [completion],
    );
  const bonusOf = async (player: string, completion: string) =>
    query<{ points: string; item_en: string | null; item_outcome: string | null }>(
      as(player),
      "SELECT points, item_en, item_outcome FROM own_bonus($1)",
      [completion],
    );
  const redemptions = async (enrollment: string) =>
    owner<Redemption>(
      `SELECT id, status, price, quest_item_id, source_completion_id, source_category_id, ended_by
       FROM redemption WHERE enrollment_id = $1 ORDER BY created_at, id`,
      [enrollment],
    );
  const unitsOut = async (item: string) =>
    (
      await owner<{ units_out: number }>("SELECT units_out FROM quest_item WHERE id = $1", [item])
    )[0]?.units_out;
  const misses = async (item: string) =>
    owner<{ reason: string; enrollment_id: string }>(
      "SELECT reason, enrollment_id FROM quest_item_miss WHERE quest_item_id = $1 ORDER BY id",
      [item],
    );
  const entries = async (enrollment: string, kind: string) =>
    owner<{ id: string; score_delta: string; balance_delta: string }>(
      "SELECT id, score_delta, balance_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = $2 ORDER BY id",
      [enrollment, kind],
    );
  /** A day passing for this member: completions, bonus rows and item sources move back one day. */
  const nextDay = async (enrollment: string) => {
    await owner(
      "UPDATE quest_completion SET created_at = created_at - interval '1 day' WHERE enrollment_id = $1",
      [enrollment],
    );
    await owner(
      `UPDATE category_bonus SET period_start = period_start - interval '1 day'
       WHERE enrollment_id = $1 AND period_start <> '-infinity'`,
      [enrollment],
    );
    await owner(
      `UPDATE redemption SET source_period = source_period - interval '1 day'
       WHERE enrollment_id = $1 AND source_period IS NOT NULL`,
      [enrollment],
    );
  };
  const givenFor = async (enrollment: string, completion: string | null | undefined) =>
    (await redemptions(enrollment)).filter(
      (row) => row.source_completion_id === String(completion),
    );
  const asTeam = (sql: string, values: unknown[]) => query(team(), sql, values);
  /** One quest in its own category, with an item, ready to play. */
  const itemQuest = async (
    options: EventOptions & { stock?: number; points?: number; cap?: number } = {},
  ) => {
    const event = await newEvent(options);
    const item = await newItem(event, options.stock ?? 5);
    const quest = await newQuest(event, await newCategory(event), {
      item,
      points: options.points ?? 50,
      cap: options.cap ?? 1,
    });
    return { event, item, quest };
  };
  /** Collects the item at the desk: the player taps Collect and the operator hands it over. */
  const handOver = async (event: string, player: string, redemption: string) => {
    const desk = await operatorOf(event, ["hand_over"]);
    await query(as(player), "SELECT start_collect($1)", [redemption]);
    return query(as(desk), "SELECT * FROM desk_hand_over($1)", [redemption]);
  };

  describe("giving the item (FR-522)", () => {
    it("pays a quest of item + 50 points and makes one pending price-0 reservation", async () => {
      const { event, item, quest } = await itemQuest();
      const { player, enrollment } = await member(event);
      const done = await code(player, quest);
      expect(done.score).toBe("50");
      expect(await itemOf(player, done.completion_id)).toEqual([
        { name_en: "T-shirt", outcome: "pending" },
      ]);
      const [given] = await redemptions(enrollment);
      expect(given).toMatchObject({
        status: "reserved",
        price: 0,
        quest_item_id: item,
        source_completion_id: done.completion_id,
        source_category_id: null,
      });
      expect(await unitsOut(item)).toBe(1);
      const [key] = await owner<{ idempotency_key: string; reserved_until: Date }>(
        "SELECT idempotency_key, reserved_until FROM redemption WHERE id = $1",
        [given?.id],
      );
      expect(key?.idempotency_key).toBe(`quest item ${given?.id}`);
      expect(key?.reserved_until.getTime()).toBeGreaterThan(Date.now());
    });

    it("gives an item-only category bonus with no ledger entry and no points", async () => {
      const event = await newEvent();
      const item = await newItem(event);
      const group = await newCategory(event, { item });
      const quest = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      const done = await code(player, quest);
      expect(done.score).toBe("10");
      expect(await bonusOf(player, done.completion_id)).toEqual([
        { points: "0", item_en: "T-shirt", item_outcome: "pending" },
      ]);
      expect(await entries(enrollment, "bonus")).toEqual([]);
      const [given] = await redemptions(enrollment);
      expect(given).toMatchObject({ source_category_id: group, source_completion_id: null });
      expect(
        await owner("SELECT entry_id FROM category_bonus WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([{ entry_id: null }]);
    });

    it("pays the points and records a miss when the item is out of stock (FR-1617)", async () => {
      const { event, item, quest } = await itemQuest({ stock: 0 });
      const { player, enrollment } = await member(event);
      const done = await code(player, quest);
      expect(done.score).toBe("50");
      expect(await itemOf(player, done.completion_id)).toEqual([
        { name_en: "T-shirt", outcome: "out_of_stock" },
      ]);
      expect(await redemptions(enrollment)).toEqual([]);
      expect(await misses(item)).toEqual([{ reason: "out_of_stock", enrollment_id: enrollment }]);
    });

    it("gives the last unit to one of two racing players and a miss to the other", async () => {
      const { event, item, quest } = await itemQuest({ stock: 1 });
      const [one, two] = [await member(event), await member(event)];
      const done = await Promise.all([code(one.player, quest), code(two.player, quest)]);
      const outcomes = [
        ...(await itemOf(one.player, done[0].completion_id)),
        ...(await itemOf(two.player, done[1].completion_id)),
      ].map((row) => row.outcome);
      expect(outcomes.toSorted()).toEqual(["out_of_stock", "pending"]);
      expect(await unitsOut(item)).toBe(1);
    });

    it("gives a quest's item on the first completion only", async () => {
      const { event, item, quest } = await itemQuest({ cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const again = await code(player, quest);
      expect(again).toMatchObject({ occurrence: 2, score: "100" });
      expect(await itemOf(player, again.completion_id)).toEqual([]);
      expect(await redemptions(enrollment)).toHaveLength(1);
      expect(await unitsOut(item)).toBe(1);
    });

    it("answers a replayed completion with the same item and moves no second unit", async () => {
      const { event, item, quest } = await itemQuest();
      const { player } = await member(event);
      const key = randomUUID();
      const first = await code(player, quest, key);
      const replay = await code(player, quest, key);
      expect(replay).toMatchObject({ replayed: true, completion_id: first.completion_id });
      expect(await itemOf(player, replay.completion_id)).toEqual([
        { name_en: "T-shirt", outcome: "pending" },
      ]);
      expect(await unitsOut(item)).toBe(1);
    });

    it("misses with claim_closed once the desk's hours are over, and holds to the last window", async () => {
      const past = await itemQuest({
        hours: "{[2020-01-01 10:00+00,2020-01-01 12:00+00)}",
      });
      const late = await member(past.event);
      const done = await code(late.player, past.quest);
      expect(await itemOf(late.player, done.completion_id)).toEqual([
        { name_en: "T-shirt", outcome: "claim_closed" },
      ]);
      expect(await misses(past.item)).toMatchObject([{ reason: "claim_closed" }]);

      const closing = await newEvent();
      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() - interval '1 hour', now() + interval '3 hours'))
         WHERE id = $1`,
        [closing],
      );
      const item = await newItem(closing);
      const quest = await newQuest(closing, await newCategory(closing), { item });
      const { player, enrollment } = await member(closing);
      await code(player, quest);
      const [until] = await owner<{ ok: boolean }>(
        `SELECT d.reserved_until = upper(e.desk_hours) AS ok FROM redemption d JOIN event e ON e.id = d.event_id
         WHERE d.enrollment_id = $1`,
        [enrollment],
      );
      expect(until?.ok).toBe(true);
    });
  });

  describe("a category's item once per period", () => {
    it("gives a daily category's item once a day, again the next, and none after a switch to none", async () => {
      const event = await newEvent();
      const item = await newItem(event);
      const group = await newCategory(event, { refresh: "daily", item });
      const quest = await newQuest(event, group, { cap: 5 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      await code(player, quest);
      expect(await redemptions(enrollment)).toHaveLength(1);
      await nextDay(enrollment);
      await code(player, quest);
      expect(await redemptions(enrollment)).toHaveLength(2);
      await owner("UPDATE category SET refresh = 'none' WHERE id = $1", [group]);
      await code(player, quest);
      expect(await redemptions(enrollment)).toHaveLength(2);
      expect(await unitsOut(item)).toBe(2);
    });

    it("gives no second item in a period after the bonus was removed", async () => {
      const event = await newEvent();
      const item = await newItem(event);
      const group = await newCategory(event, { refresh: "daily", bonus: 5, item });
      const quest = await newQuest(event, group, { cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [bonus] = await entries(enrollment, "bonus");
      expect(await remove(event, bonus?.id ?? "")).toMatchObject({ item: "cancelled" });
      await code(player, quest);
      expect((await redemptions(enrollment)).map((row) => row.status)).toEqual(["cancelled"]);
      expect(await unitsOut(item)).toBe(0);
    });

    it("refuses a second item for one source in the database", async () => {
      const event = await newEvent();
      const item = await newItem(event);
      const group = await newCategory(event, { item });
      const quest = await newQuest(event, group, { item });
      const { player, enrollment } = await member(event);
      const done = await code(player, quest);
      const copy = (source: string) =>
        owner(
          `INSERT INTO redemption (organizer_id, event_id, enrollment_id, quest_item_id, price, idempotency_key,
                                   reserved_until, source_completion_id, source_category_id, source_period)
           SELECT organizer_id, event_id, enrollment_id, quest_item_id, 0, gen_random_uuid()::text, reserved_until,
                  source_completion_id, source_category_id, source_period
           FROM redemption WHERE enrollment_id = $1 AND ${source} IS NOT NULL`,
          [enrollment],
        );
      expect(done.completion_id).toBeDefined();
      expect(await refusal(copy("source_completion_id"))).toMatch(/^23505/);
      expect(await refusal(copy("source_category_id"))).toMatch(/^23505/);
    });
  });

  describe("links, removal and the desk", () => {
    it("refuses linking a removed item and removing a linked one", async () => {
      const event = await newEvent();
      const item = await newItem(event);
      const group = await newCategory(event);
      const quest = await newQuest(event, group, { item });
      expect(
        await refusal(asTeam("UPDATE quest_item SET status = 'removed' WHERE id = $1", [item])),
      ).toBe("QI409:item_in_use");
      await asTeam("UPDATE quest SET item_id = NULL WHERE id = $1", [quest]);
      await asTeam("UPDATE category SET item_id = $2 WHERE id = $1", [group, item]);
      expect(
        await refusal(asTeam("UPDATE quest_item SET status = 'removed' WHERE id = $1", [item])),
      ).toBe("QI409:item_in_use");
      await asTeam("UPDATE category SET item_id = NULL WHERE id = $1", [group]);
      await asTeam("UPDATE quest_item SET status = 'removed' WHERE id = $1", [item]);
      expect(
        await refusal(asTeam("UPDATE quest SET item_id = $2 WHERE id = $1", [quest, item])),
      ).toBe("QI422:invalid_item");
      expect(
        await refusal(asTeam("UPDATE quest_item SET status = 'active' WHERE id = $1", [item])),
      ).toBe("QI409:removed");
    });

    it("refuses another event's item and an item with no desk; keeps the desk while an item needs it", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const foreign = await newItem(other);
      const quest = await newQuest(event, await newCategory(event));
      expect(
        await refusal(
          query(team(), "UPDATE quest SET item_id = $2 WHERE id = $1", [quest, foreign]),
        ),
      ).toBe("QI422:invalid_item");
      const bare = await newEvent({ desk: null });
      expect(
        await refusal(
          query(
            team(),
            "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Cap', 3)",
            [bare],
          ),
        ),
      ).toBe("DL409");
      await newItem(event);
      expect(
        await refusal(
          query(team(), "UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]),
        ),
      ).toBe("DL409");
    });

    it("never lets units out pass the stock", async () => {
      const { event, item, quest } = await itemQuest({ stock: 2 });
      await code((await member(event)).player, quest);
      await code((await member(event)).player, quest);
      expect(
        await refusal(query(team(), "UPDATE quest_item SET stock_total = 1 WHERE id = $1", [item])),
      ).toMatch(/^23514/);
      expect(
        await refusal(owner("UPDATE quest_item SET units_out = 3 WHERE id = $1", [item])),
      ).toMatch(/^23514/);
      expect(
        await refusal(query(team(), "UPDATE quest_item SET units_out = 0 WHERE id = $1", [item])),
      ).toBe("42501");
    });

    it("never leaves a quest naming a removed item when a link and a removal race", async () => {
      for (let round = 0; round < 6; round += 1) {
        const event = await newEvent();
        const item = await newItem(event);
        const quest = await newQuest(event, await newCategory(event));
        await Promise.all([
          refusal(query(team(), "UPDATE quest SET item_id = $2 WHERE id = $1", [quest, item])),
          refusal(query(team(), "UPDATE quest_item SET status = 'removed' WHERE id = $1", [item])),
        ]);
        const [state] = await owner<{ linked: boolean; removed: boolean }>(
          `SELECT q.item_id IS NOT NULL AS linked, i.status = 'removed' AS removed
           FROM quest q, quest_item i WHERE q.id = $1 AND i.id = $2`,
          [quest, item],
        );
        expect(state?.linked && state.removed).toBe(false);
      }
    });
  });

  describe("ending, handing over and removing", () => {
    it("returns the unit with no ledger entry on expiry and on an operator's cancel", async () => {
      const { event, item, quest } = await itemQuest();
      const one = await member(event);
      const two = await member(event);
      await code(one.player, quest);
      await code(two.player, quest);
      const [first] = await redemptions(one.enrollment);
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
        [first?.id],
      );
      expect(
        await owner("SELECT end_reservation($1, 'expired', 'timeout', 'system', NULL) AS ended", [
          first?.id,
        ]),
      ).toEqual([{ ended: true }]);
      const desk = await operatorOf(event, ["hand_over"]);
      const [second] = await redemptions(two.enrollment);
      await query(as(desk), "SELECT * FROM operator_cancel_redemption($1)", [second?.id]);
      expect(await unitsOut(item)).toBe(0);
      expect(await entries(one.enrollment, "redeem_return")).toEqual([]);
      expect(await entries(two.enrollment, "redeem_return")).toEqual([]);
    });

    it("refuses the player's own cancel", async () => {
      const { event, quest } = await itemQuest();
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [given] = await redemptions(enrollment);
      expect(
        await refusal(query(as(player), "SELECT * FROM cancel_redemption($1)", [given?.id])),
      ).toBe("RZ409");
    });

    it("hands the item over at the desk with a 0/0 entry, the unit kept out", async () => {
      const { event, item, quest } = await itemQuest();
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [given] = await redemptions(enrollment);
      expect(await handOver(event, player, given?.id ?? "")).toMatchObject([
        { status: "handed_over" },
      ]);
      expect(await entries(enrollment, "handover")).toMatchObject([
        { score_delta: "0", balance_delta: "0" },
      ]);
      expect(await unitsOut(item)).toBe(1);
    });

    it("cancels a pending item when its quest credit is removed and answers it again on a replay", async () => {
      const { event, item, quest } = await itemQuest();
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [credit] = await entries(enrollment, "quest");
      const key = randomUUID();
      expect(await remove(event, credit?.id ?? "", key)).toMatchObject({
        item: "cancelled",
        replayed: false,
      });
      expect(await remove(event, credit?.id ?? "", key)).toMatchObject({
        item: "cancelled",
        replayed: true,
      });
      expect(await redemptions(enrollment)).toMatchObject([
        { status: "cancelled", ended_by: "removal" },
      ]);
      expect(await unitsOut(item)).toBe(0);
      expect(await entries(enrollment, "redeem_return")).toEqual([]);
    });

    it("leaves a handed-over item when its credit is removed", async () => {
      const { event, item, quest } = await itemQuest();
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [given] = await redemptions(enrollment);
      await handOver(event, player, given?.id ?? "");
      const [credit] = await entries(enrollment, "quest");
      expect(await remove(event, credit?.id ?? "")).toMatchObject({ item: "handed_over" });
      expect(await unitsOut(item)).toBe(1);
    });

    it("answers no item for a credit that gave none", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event));
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [credit] = await entries(enrollment, "quest");
      expect(await remove(event, credit?.id ?? "")).toMatchObject({ item: null });
    });

    it("gives no item on a later scan after a removal (occurrence 2)", async () => {
      const { event, quest } = await itemQuest({ cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [credit] = await entries(enrollment, "quest");
      await remove(event, credit?.id ?? "");
      const again = await code(player, quest);
      expect(again.occurrence).toBe(2);
      expect(await itemOf(player, again.completion_id)).toEqual([]);
      expect(await redemptions(enrollment)).toHaveLength(1);
    });

    it("no longer blocks a removal that leaves the balance short on a reserved free item (AO409)", async () => {
      const { event, quest } = await itemQuest({ points: 50 });
      const reward = (
        await owner<{ id: string }>(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Mug', 40, 5) RETURNING id",
          [event],
        )
      )[0]?.id;
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [bought] = await query<{ redemption_id: string }>(
        as(player),
        "SELECT * FROM reserve_reward($1, $2)",
        [reward, randomUUID()],
      );
      await handOver(event, player, bought?.redemption_id ?? "");
      const [credit] = await entries(enrollment, "quest");
      expect(await remove(event, credit?.id ?? "")).toMatchObject({ item: "cancelled" });
    });
  });

  describe("every path that writes a completion", () => {
    it("gives the item once on a scan, an operator scan and a manual award", async () => {
      const event = await newEvent();
      const item = await newItem(event, 10);
      const quest = await newQuest(event, await newCategory(event), {
        type: "scan_qr",
        item,
        cap: 3,
      });
      const { player, enrollment } = await member(event);
      const [scan] = await query<{ completion_id: string }>(
        as(player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      expect(await givenFor(enrollment, scan?.completion_id)).toHaveLength(1);

      const other = await member(event);
      const booth = await operatorOf(event, ["scan_quests"]);
      const [scanned] = await query<{ completion_id: string }>(
        as(booth),
        "SELECT * FROM operator_complete_quest($1, $2, 1, $3)",
        [quest, other.player, randomUUID()],
      );
      expect(await givenFor(other.enrollment, scanned?.completion_id)).toHaveLength(1);

      const third = await member(event);
      await award(event, third.enrollment, quest);
      expect(await redemptions(third.enrollment)).toHaveLength(1);
      expect(await unitsOut(item)).toBe(3);
    });

    it("gives the item once on a survey, a passport and a quiz with a right answer", async () => {
      const event = await newEvent();
      const item = await newItem(event, 10);
      const survey = await newQuest(event, await newCategory(event), {
        type: "survey",
        config: SURVEY,
        item,
      });
      const passportGroup = await newCategory(event);
      await db.owner.query("BEGIN");
      const passport = await newQuest(event, passportGroup, {
        type: "passport",
        config: { needed: 1 },
        item,
      });
      const [step] = await owner<{ id: string }>(
        "INSERT INTO passport_step (event_id, quest_id, name_en, position) VALUES ($1, $2, 'Booth', 0) RETURNING id",
        [event, passport],
      );
      await db.owner.query("COMMIT");
      const quiz = await newQuest(event, await newCategory(event), {
        type: "quiz",
        config: QUIZ,
        item,
      });
      const { player, enrollment } = await member(event);
      await query(as(player), "SELECT * FROM submit_survey($1, $2, $3)", [
        survey,
        JSON.stringify({ stars: 5 }),
        randomUUID(),
      ]);
      await query(as(player), "SELECT * FROM stamp_step($1, 1, $2, NULL)", [
        step?.id,
        randomUUID(),
      ]);
      await playQuiz(player, quiz, "r");
      expect(await redemptions(enrollment)).toHaveLength(3);
      expect(await unitsOut(item)).toBe(3);
    });

    it("gives a zero-right quiz the category's item, not the quest's", async () => {
      const event = await newEvent();
      const questItem = await newItem(event);
      const groupItem = await newItem(event);
      const group = await newCategory(event, { item: groupItem });
      const quiz = await newQuest(event, group, { type: "quiz", config: QUIZ, item: questItem });
      const { player, enrollment } = await member(event);
      await playQuiz(player, quiz, "w");
      expect(await redemptions(enrollment)).toMatchObject([
        { quest_item_id: groupItem, source_category_id: group },
      ]);
      expect(
        await query(
          as(player),
          "SELECT points, item_en, item_outcome FROM own_category_bonus($1)",
          [quiz],
        ),
      ).toEqual([{ points: "0", item_en: "T-shirt", item_outcome: "pending" }]);
    });
  });

  describe("races", () => {
    it("completes crossed quest and category items in parallel with no deadlock", async () => {
      const event = await newEvent();
      const [itemA, itemB] = [await newItem(event, 100), await newItem(event, 100)];
      const pairs: Array<Promise<unknown>> = [];
      for (let round = 0; round < 5; round += 1) {
        const one = await newQuest(event, await newCategory(event, { item: itemB }), {
          item: itemA,
        });
        const two = await newQuest(event, await newCategory(event, { item: itemA }), {
          item: itemB,
        });
        const [p, q] = [await member(event), await member(event)];
        pairs.push(code(p.player, one), code(q.player, two));
      }
      await expect(Promise.all(pairs)).resolves.toHaveLength(10);
      expect([await unitsOut(itemA), await unitsOut(itemB)]).toEqual([10, 10]);
    });
  });

  describe("the shop, rehearsal and erasure", () => {
    it("keeps the shop's popular list to shop rewards", async () => {
      const { event, quest } = await itemQuest({ stock: 10, points: 50 });
      const rewards: string[] = [];
      for (const name of ["A", "B", "C"]) {
        const [made] = await owner<{ id: string }>(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', $2, 1, 10) RETURNING id",
          [event, name],
        );
        rewards.push(made?.id ?? "");
      }
      const players = [
        await member(event),
        await member(event),
        await member(event),
        await member(event),
      ];
      for (const { player } of players) {
        await code(player, quest);
      }
      for (const { player } of players.slice(0, 3)) {
        for (const reward of rewards) {
          await query(as(player), "SELECT * FROM reserve_reward($1, $2)", [reward, randomUUID()]);
        }
      }
      const shop = await query<{ popular: boolean }>(
        as(players[3]?.player ?? ""),
        "SELECT popular FROM shop_rewards($1)",
        [event],
      );
      expect(shop.map((row) => row.popular)).toEqual([true, true, true]);
    });

    it("gives rehearsal players items, then wipes them, their misses and recounts the units", async () => {
      const event = await newEvent({ status: "draft" });
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ABCD-EFGH')",
        [event, ids.orgA],
      );
      const item = await newItem(event);
      const none = await newItem(event, 0);
      const quest = await newQuest(event, await newCategory(event), { item });
      const empty = await newQuest(event, await newCategory(event), { item: none });
      const { player } = await member(event, "rehearsal");
      await code(player, quest);
      await code(player, empty);
      expect(await unitsOut(item)).toBe(1);
      const [wiped] = await owner<{ counts: { item_misses: number; reservations: number } }>(
        "SELECT wipe_rehearsal($1, 'go_live', NULL) AS counts",
        [event],
      );
      expect(wiped?.counts).toMatchObject({ item_misses: 1, reservations: 1 });
      expect(await unitsOut(item)).toBe(0);
      expect(await misses(none)).toEqual([]);
    });

    it("deletes an erased account's misses", async () => {
      const { event, item, quest } = await itemQuest({ stock: 0 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [player, enrollment]);
      expect(await misses(item)).toEqual([]);
    });
  });

  describe("readers and closed doors", () => {
    it("lists the items and who missed them for the team, and nothing for a stranger", async () => {
      const { event, item, quest } = await itemQuest({ stock: 1 });
      await code((await member(event)).player, quest);
      await code((await member(event)).player, quest);
      expect(
        await query(
          team(),
          "SELECT stock_total, units_out, stock_left, missed, quests FROM quest_items($1)",
          [event],
        ),
      ).toMatchObject([
        { stock_total: 1, units_out: 1, stock_left: 0, missed: 1, quests: [{ id: quest }] },
      ]);
      expect(
        await query(team(), "SELECT source, reason FROM quest_item_misses($1, $2)", [event, item]),
      ).toEqual([{ source: "quest", reason: "out_of_stock" }]);
      const stranger: RequestContext = {
        organizerId: ids.orgB,
        staffUserId: await addMember(db.owner, ids.orgB, "owner"),
      };
      expect(await refusal(query(stranger, "SELECT * FROM quest_items($1)", [event]))).toBe(
        "AN404",
      );
      expect(
        await refusal(query(stranger, "SELECT * FROM quest_item_misses($1, $2)", [event, item])),
      ).toBe("AN404");
    });

    it("lists the items still to win beside the quests and the category bonus", async () => {
      const event = await newEvent();
      const item = await newItem(event);
      const empty = await newItem(event, 0);
      const group = await newCategory(event, { item, bonus: 5 });
      const quest = await newQuest(event, group, { item });
      const dry = await newQuest(event, group, { item: empty });
      const { player } = await member(event);
      const read = async () =>
        query<{
          quest_id: string;
          item_en: string | null;
          bonus_item_en: string | null;
        }>(as(player), "SELECT quest_id, item_en, bonus_item_en FROM member_event_quests($1)", [
          event,
        ]);
      expect(await read()).toEqual([
        { quest_id: quest, item_en: "T-shirt", bonus_item_en: "T-shirt" },
        { quest_id: dry, item_en: null, bonus_item_en: "T-shirt" },
      ]);
      await code(player, quest);
      expect((await read()).find((row) => row.quest_id === quest)?.item_en).toBeNull();
    });

    it("shows a player only their own completion's item", async () => {
      const { event, quest } = await itemQuest();
      const { player } = await member(event);
      const done = await code(player, quest);
      const other = await member(event);
      expect(await itemOf(other.player, done.completion_id)).toEqual([]);
      expect(await bonusOf(other.player, done.completion_id)).toEqual([]);
    });

    it("keeps the misses table and the internal helpers away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM quest_item_miss",
        "SELECT give_item(NULL::enrollment, NULL, NULL, NULL, NULL)",
        "SELECT lock_quest_items(NULL::quest)",
        "SELECT credit_item(NULL::ledger_entry)",
        "SELECT credit_item_state(NULL::redemption)",
        "SELECT redemption_source(NULL::redemption)",
        "UPDATE quest_item SET units_out = 0",
      ]) {
        await expect(query(team(), sql), sql).rejects.toMatchObject({ code: "42501" });
      }
    });
  });
});
