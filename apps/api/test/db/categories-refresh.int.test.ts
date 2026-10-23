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
const VERIFICATION: Readonly<Record<string, string>> = {
  scan_qr: "{quest_qr}",
  challenge: "{my_qr}",
};

/**
 * Daily and weekly category refresh in the database (T-304c, migration 0046, ADR-204): the repeat cap, "done", the
 * gates and the bonus counted inside the current period; the occurrence and the points kept for life; switches between
 * refresh modes; only repeatable types in a refreshing category. A day passing is played by moving rows back a day.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("category refresh (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
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

  const newEvent = async (startsAt = "now() - interval '1 hour'"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Refresh Fest', 'live', ${startsAt}, now() + interval '30 days') RETURNING id`,
      [ids.orgA, `RFR${counter}`],
    );
    return event?.id ?? "";
  };
  type Rules = { refresh?: string; bonus?: number; order?: string; unlockAfter?: string };
  const newCategory = async (event: string, rules: Rules = {}) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, refresh, completion_bonus, order_mode, unlock_after, position)
         VALUES ($1, 'Daily', $2, $3, $4, $5, $6) RETURNING id`,
        [
          event,
          rules.refresh ?? "daily",
          rules.bonus ?? 0,
          rules.order ?? "any",
          rules.unlockAfter ?? null,
          (counter += 1),
        ],
      )
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    category: string,
    options: { type?: string; config?: object; cap?: number; verification?: string } = {},
  ) => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position,
                              verification)
           VALUES ($1, $2, $3, 'Play', 10, $4, $5, $6, $7) RETURNING id`,
          [
            event,
            category,
            options.type ?? "enter_code",
            options.cap ?? 1,
            JSON.stringify(options.config ?? { code: "ABC" }),
            counter,
            options.verification ?? VERIFICATION[options.type ?? "enter_code"] ?? "{}",
          ],
        )
      )[0]?.id ?? ""
    );
  };
  const member = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rf_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'code') RETURNING id",
      [ids.orgA, event, player?.id],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const code = async (player: string, quest: string, key: string = randomUUID()) =>
    (
      await query<{ completion_id: string; occurrence: number; score: string }>(
        as(player),
        "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
        [quest, key],
      )
    )[0];
  const award = async (event: string, enrollment: string, quest: string) =>
    query(team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
      event,
      enrollment,
      quest,
      randomUUID(),
      randomUUID(),
    ]);
  /** Plays a day passing for this member: their completions and bonus rows move back one day. */
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
  };
  const bonuses = async (enrollment: string) =>
    owner<{ score_delta: string }>(
      "SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus' ORDER BY id",
      [enrollment],
    );
  const score = async (enrollment: string) =>
    (await owner<{ score: string }>("SELECT score FROM enrollment WHERE id = $1", [enrollment]))[0]
      ?.score;
  const readQuest = async (player: string, event: string, quest: string) =>
    (
      await query<{
        quest_id: string;
        done: number;
        earned: string;
        lock: string | null;
        bonus_settled: boolean;
        refresh: string;
        resets_at: Date | null;
      }>(as(player), "SELECT * FROM member_event_quests($1)", [event])
    ).find((row) => row.quest_id === quest);
  const dayStart = async (event: string, offset = 0) =>
    (
      await owner<{ at: Date }>(
        "SELECT event_day_start(e, event_day(now(), e) + $2::int) AS at FROM event e WHERE e.id = $1",
        [event, offset],
      )
    )[0]?.at;

  describe("the repeat cap per period", () => {
    it("refuses a daily quest twice in one day and pays it again the next, points kept", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event));
      const { player, enrollment } = await member(event);
      expect(await code(player, quest)).toMatchObject({ occurrence: 1, score: "10" });
      expect(await refusal(code(player, quest))).toBe("QD409:1");
      await nextDay(enrollment);
      expect(await code(player, quest)).toMatchObject({ occurrence: 2, score: "20" });
      expect(await refusal(code(player, quest))).toBe("QD409:1");
    });

    it("counts a repeat cap of 2 per day", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event), { cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      await code(player, quest);
      expect(await refusal(code(player, quest))).toBe("QD409:2");
      await nextDay(enrollment);
      expect(await code(player, quest)).toMatchObject({ occurrence: 3 });
      expect(await code(player, quest)).toMatchObject({ occurrence: 4, score: "40" });
    });

    it("numbers the occurrence past 100", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event));
      const { player, enrollment } = await member(event);
      await owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, created_at)
         SELECT $1, $2, $3, $4, g, 'code', 'old-' || g, now() - interval '2 days' FROM generate_series(1, 100) g`,
        [ids.orgA, event, enrollment, quest],
      );
      expect(await code(player, quest)).toMatchObject({ occurrence: 101 });
    });

    it("counts a completion just before the day start in the old day, one at it in the new", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event));
      const { player, enrollment } = await member(event);
      await code(player, quest);
      await owner("UPDATE quest_completion SET created_at = $2 WHERE enrollment_id = $1", [
        enrollment,
        await dayStart(event),
      ]);
      expect(await refusal(code(player, quest))).toBe("QD409:1");
      await owner(
        "UPDATE quest_completion SET created_at = $2::timestamptz - interval '1 microsecond' WHERE enrollment_id = $1",
        [enrollment, await dayStart(event)],
      );
      expect(await code(player, quest)).toMatchObject({ occurrence: 2 });
    });

    it("pays one of two parallel completions in one period", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event));
      const { player, enrollment } = await member(event);
      const results = await Promise.all([
        refusal(code(player, quest)),
        refusal(code(player, quest)),
      ]);
      expect(results.toSorted()).toEqual(["QD409:1", "none"]);
      expect(await score(enrollment)).toBe("10");
    });

    it("holds a manual award and an operator scan to the period", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event), {
        type: "scan_qr",
        config: {},
        verification: "{quest_qr,my_qr}",
      });
      const { player, enrollment } = await member(event);
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{scan_quests}')",
        [ids.orgA, event, operator.player],
      );
      const scan = () =>
        query(as(operator.player), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
          quest,
          player,
          randomUUID(),
        ]);
      await award(event, enrollment, quest);
      expect(await refusal(award(event, enrollment, quest))).toBe("QD409:1");
      expect(await refusal(scan())).toBe("QD409:1");
      await nextDay(enrollment);
      expect(await refusal(scan())).toBe("none");
      expect(await score(enrollment)).toBe("20");
    });
  });

  describe("the period", () => {
    it("anchors a weekly block to the event's first day, from its day-start hour", async () => {
      // The event began nine event days ago at 10:00 (day start 04:00): week 2 began two days ago.
      const event = await newEvent();
      await owner(
        `UPDATE event e SET starts_at = event_day_start(e, event_day(now(), e) - 9) + interval '6 hours'
         WHERE e.id = $1`,
        [event],
      );
      const weekly = await newCategory(event, { refresh: "weekly" });
      const period = async () =>
        (
          await owner<{ starts: Date; resets: Date }>(
            `SELECT category_period_start(c, e) AS starts, category_resets_at(c, e) AS resets
             FROM category c JOIN event e ON e.id = c.event_id WHERE c.id = $1`,
            [weekly],
          )
        )[0];
      expect(await period()).toEqual({
        starts: await dayStart(event, -2),
        resets: await dayStart(event, 5),
      });
      // A start one hour before a day start belongs to the day before: week 2 began yesterday.
      await owner(
        `UPDATE event e SET starts_at = event_day_start(e, event_day(now(), e) - 7) - interval '1 hour'
         WHERE e.id = $1`,
        [event],
      );
      expect(await period()).toEqual({
        starts: await dayStart(event, -1),
        resets: await dayStart(event, 6),
      });
    });

    it("answers -infinity and no reset for none, today's day for daily", async () => {
      const event = await newEvent();
      const none = await newCategory(event, { refresh: "none" });
      const daily = await newCategory(event);
      const [row] = await owner<{
        none: string;
        daily: Date;
        none_reset: Date | null;
        reset: Date;
      }>(
        `SELECT category_period_start(n, e)::text AS none, category_period_start(d, e) AS daily,
                category_resets_at(n, e) AS none_reset, category_resets_at(d, e) AS reset
         FROM event e, category n, category d WHERE e.id = $1 AND n.id = $2 AND d.id = $3`,
        [event, none, daily],
      );
      expect(row).toEqual({
        none: "-infinity",
        daily: await dayStart(event),
        none_reset: null,
        reset: await dayStart(event, 1),
      });
    });
  });

  describe("done and the gates", () => {
    it("resets done each day while earned stays lifetime, and reads the refresh", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, await newCategory(event));
      const { player, enrollment } = await member(event);
      await code(player, quest);
      expect(await readQuest(player, event, quest)).toMatchObject({
        done: 1,
        earned: "10",
        refresh: "daily",
        resets_at: await dayStart(event, 1),
      });
      await nextDay(enrollment);
      expect(await readQuest(player, event, quest)).toMatchObject({ done: 0, earned: "10" });
    });

    it("locks an in-order quest again on a new day", async () => {
      const event = await newEvent();
      const chain = await newCategory(event, { order: "in_order" });
      const first = await newQuest(event, chain);
      const second = await newQuest(event, chain);
      const { player, enrollment } = await member(event);
      await code(player, first);
      expect((await readQuest(player, event, second))?.lock).toBeNull();
      await nextDay(enrollment);
      expect((await readQuest(player, event, second))?.lock).toBe("order_locked");
      expect(await refusal(code(player, second))).toBe("QN403:order_locked");
    });

    it("locks a category behind a daily unlock category again on a new day (Q-168)", async () => {
      const event = await newEvent();
      const daily = await newCategory(event);
      const first = await newQuest(event, daily);
      const follower = await newCategory(event, { refresh: "none", unlockAfter: daily });
      const quest = await newQuest(event, follower, { cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, first);
      await code(player, quest);
      await nextDay(enrollment);
      expect(await refusal(code(player, quest))).toBe("QN403:category_locked");
    });
  });

  describe("the bonus per period", () => {
    it("pays the bonus once a day and again the next, the earlier row untouched", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const quest = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      await code(player, quest);
      expect(await bonuses(enrollment)).toEqual([{ score_delta: "25" }]);
      const [before] = await owner<{ entry_id: string }>(
        "SELECT entry_id FROM category_bonus WHERE enrollment_id = $1",
        [enrollment],
      );
      expect((await readQuest(player, event, quest))?.bonus_settled).toBe(true);
      await nextDay(enrollment);
      expect((await readQuest(player, event, quest))?.bonus_settled).toBe(false);
      await code(player, quest);
      expect(await bonuses(enrollment)).toHaveLength(2);
      const rows = await owner<{ entry_id: string; period_start: Date }>(
        "SELECT entry_id, period_start FROM category_bonus WHERE enrollment_id = $1 ORDER BY period_start",
        [enrollment],
      );
      expect(rows.map((row) => row.period_start)).toEqual([
        await dayStart(event, -1),
        await dayStart(event),
      ]);
      expect(rows[0]?.entry_id).toBe(before?.entry_id);
      expect(rows[1]?.entry_id).not.toBe(before?.entry_id);
      expect(await score(enrollment)).toBe("70");
    });

    it("does not repay a removed bonus in its period", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const quest = await newQuest(event, group, { cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'",
        [enrollment],
      );
      await query(team(), "SELECT * FROM remove_award($1, $2, 'Cheating', $3, $4)", [
        event,
        entry?.id,
        randomUUID(),
        randomUUID(),
      ]);
      await code(player, quest);
      expect(await bonuses(enrollment)).toHaveLength(1);
      expect(await score(enrollment)).toBe("20");
    });

    it("pays one bonus for two parallel last completions in one period", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const a = await newQuest(event, group);
      const b = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      await Promise.all([code(player, a), code(player, b)]);
      expect(await bonuses(enrollment)).toHaveLength(1);
      expect(await score(enrollment)).toBe("45");
    });
  });

  describe("switching the refresh", () => {
    it("daily to none: the bonus is not repaid and a capped quest stays capped", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const quest = await newQuest(event, group, { cap: 3 });
      const capped = await newQuest(event, await newCategory(event), { cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, capped);
      await nextDay(enrollment);
      await code(player, capped);
      await code(player, quest);
      expect(await bonuses(enrollment)).toHaveLength(1);
      await owner("UPDATE category SET refresh = 'none' WHERE event_id = $1", [event]);
      await code(player, quest);
      expect(await bonuses(enrollment)).toHaveLength(1);
      expect((await readQuest(player, event, quest))?.bonus_settled).toBe(true);
      expect(await refusal(code(player, capped))).toBe("QD409:2");
    });

    it("none to daily: the cap and the bonus start fresh today", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { refresh: "none", bonus: 25 });
      const quest = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      await code(player, quest);
      await owner(
        "UPDATE quest_completion SET created_at = created_at - interval '1 day' WHERE enrollment_id = $1",
        [enrollment],
      );
      expect(await refusal(code(player, quest))).toBe("QD409:1");
      await owner("UPDATE category SET refresh = 'daily' WHERE id = $1", [group]);
      expect(await code(player, quest)).toMatchObject({ occurrence: 2 });
      expect(await bonuses(enrollment)).toHaveLength(2);
      expect(await score(enrollment)).toBe("70");
    });
  });

  describe("only repeatable types refresh", () => {
    it("refuses a played-once quest in a refreshing category, both ways", async () => {
      const event = await newEvent();
      const daily = await newCategory(event);
      const plain = await newCategory(event, { refresh: "none" });
      await expect(
        newQuest(event, daily, {
          type: "submission",
          config: { accepts: ["text"], autoApprove: false, resubmit: false },
        }),
      ).rejects.toMatchObject({ code: "QT422", detail: "refresh" });
      const sent = await newQuest(event, plain, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      await expect(
        owner("UPDATE quest SET category_id = $2 WHERE id = $1", [sent, daily]),
      ).rejects.toMatchObject({ code: "QT422", detail: "refresh" });
      await expect(
        owner("UPDATE category SET refresh = 'weekly' WHERE id = $1", [plain]),
      ).rejects.toMatchObject({ code: "QT422", detail: "refresh" });
      await newQuest(event, daily, { type: "challenge", config: {}, verification: "{my_qr}" });
      await newQuest(event, daily, { type: "scan_qr", config: {} });
      const typed = await newQuest(event, daily);
      await expect(
        owner("UPDATE quest SET type = 'share' WHERE id = $1", [typed]),
      ).rejects.toMatchObject({ code: "QT422" });
    });
  });

  describe("closed doors", () => {
    it("keeps the period helpers away from the API role", async () => {
      for (const sql of [
        "SELECT category_period_start(NULL::category, NULL::event)",
        "SELECT category_resets_at(NULL::category, NULL::event)",
        "SELECT period_count(gen_random_uuid(), NULL::quest)",
      ]) {
        await expect(query(team(), sql), sql).rejects.toMatchObject({ code: "42501" });
      }
    });
  });
});
