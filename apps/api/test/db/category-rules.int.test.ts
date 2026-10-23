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

/**
 * Category rules and the completion bonus in the database (T-304, migration 0044, ADR-200 to ADR-202): the gates
 * (opens at, unlock after, in order) and who passes them, the bonus paid once under every path and its removal, the
 * player's read, rehearsal and erasure.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("category rules and the bonus (database)", () => {
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

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Rules Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `CRU${counter}`, status],
    );
    return event?.id ?? "";
  };
  type CategoryRules = {
    bonus?: number;
    order?: "any" | "in_order";
    opensAt?: string;
    unlockAfter?: string;
  };
  const newCategory = async (event: string, rules: CategoryRules = {}) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, completion_bonus, order_mode, opens_at, unlock_after)
         VALUES ($1, 'Chapter', $2, $3, $4, $5) RETURNING id`,
        [
          event,
          rules.bonus ?? 0,
          rules.order ?? "any",
          rules.opensAt ?? null,
          rules.unlockAfter ?? null,
        ],
      )
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    category: string,
    options: { type?: string; config?: object; points?: number; cap?: number } = {},
  ) => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position)
           VALUES ($1, $2, $3, 'Play', $4, $5, $6, $7) RETURNING id`,
          [
            event,
            category,
            options.type ?? "enter_code",
            options.points ?? 10,
            options.cap ?? 1,
            JSON.stringify(options.config ?? { code: "ABC" }),
            counter,
          ],
        )
      )[0]?.id ?? ""
    );
  };
  const member = async (event: string, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`cr_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const code = async (player: string, quest: string, key: string = randomUUID()) =>
    (
      await query<{ completion_id: string; score: string; balance: string }>(
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
  const remove = async (event: string, entry: string) =>
    query(team(), "SELECT * FROM remove_award($1, $2, 'Cheating', $3, $4)", [
      event,
      entry,
      randomUUID(),
      randomUUID(),
    ]);
  const bonuses = async (enrollment: string) =>
    owner<{ score_delta: string; balance_delta: string; actor: string }>(
      "SELECT score_delta, balance_delta, actor FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'",
      [enrollment],
    );
  const standing = async (enrollment: string) =>
    (
      await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];
  const lockOf = async (player: string, event: string, quest: string) =>
    (
      await query<{ quest_id: string; lock: string | null }>(
        as(player),
        "SELECT quest_id, lock FROM member_event_quests($1)",
        [event],
      )
    ).find((row) => row.quest_id === quest)?.lock;
  const playQuiz = async (player: string, quest: string, choice: string) => {
    await query(as(player), "SELECT quiz_start($1)", [quest]);
    await query(as(player), "SELECT quiz_next($1)", [quest]);
    await query(as(player), "SELECT quiz_answer($1, 'q1', $2)", [quest, choice]);
  };

  describe("the gates", () => {
    it("holds an in-order category's quests one after another, skipping a closed one", async () => {
      const event = await newEvent();
      const chain = await newCategory(event, { order: "in_order" });
      const [first, second, third] = [
        await newQuest(event, chain),
        await newQuest(event, chain),
        await newQuest(event, chain),
      ];
      const { player } = await member(event);
      expect(await refusal(code(player, third ?? ""))).toBe("QN403:order_locked");
      expect(await lockOf(player, event, second ?? "")).toBe("order_locked");
      await code(player, first ?? "");
      expect(await lockOf(player, event, second ?? "")).toBeNull();
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
        second,
      ]);
      expect(await code(player, third ?? "")).toMatchObject({ score: "20" });
    });

    it("lets any order take quests as they come", async () => {
      const event = await newEvent();
      const open = await newCategory(event);
      await newQuest(event, open);
      const last = await newQuest(event, open);
      const { player } = await member(event);
      expect(await code(player, last)).toMatchObject({ score: "10" });
    });

    it("blocks the next in-order quest behind a pending submission", async () => {
      const event = await newEvent();
      const chain = await newCategory(event, { order: "in_order" });
      const sent = await newQuest(event, chain, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      const after = await newQuest(event, chain);
      const { player } = await member(event);
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
        [player],
      );
      await query(as(player), "SELECT * FROM submit_quest($1, 'Hi', '1.0', $2)", [
        sent,
        randomUUID(),
      ]);
      expect(await refusal(code(player, after))).toBe("QN403:order_locked");
    });

    it("keeps a category shut until it opens", async () => {
      const event = await newEvent();
      const later = await newCategory(event, {
        opensAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const quest = await newQuest(event, later);
      const { player } = await member(event);
      expect(await refusal(code(player, quest))).toBe("QN403:category_not_started");
      await owner("UPDATE category SET opens_at = now() - interval '1 minute' WHERE id = $1", [
        later,
      ]);
      expect(await code(player, quest)).toMatchObject({ score: "10" });
    });

    it("unlocks a category after another is cleared, by a zero-right quiz too", async () => {
      const event = await newEvent();
      const one = await newCategory(event);
      const quiz = await newQuest(event, one, { type: "quiz", config: QUIZ });
      const two = await newCategory(event, { unlockAfter: one });
      const quest = await newQuest(event, two);
      const { player } = await member(event);
      expect(await refusal(code(player, quest))).toBe("QN403:category_locked");
      await playQuiz(player, quiz, "w");
      expect(await code(player, quest)).toMatchObject({ score: "10" });
    });

    it("counts an unlock category the player is outside the audience of as met", async () => {
      const event = await newEvent();
      const vip = await newCategory(event);
      await newQuest(event, vip);
      await owner(
        "UPDATE category SET audience_kind = 'tag', audience_values = '{vip}' WHERE id = $1",
        [vip],
      );
      const next = await newCategory(event, { unlockAfter: vip });
      const quest = await newQuest(event, next);
      const { player } = await member(event);
      expect(await code(player, quest)).toMatchObject({ score: "10" });
    });

    it("lets an owner's manual award pass every gate, and gates the station", async () => {
      const event = await newEvent();
      const later = await newCategory(event, {
        order: "in_order",
        opensAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await newQuest(event, later);
      const second = await newQuest(event, later, { type: "scan_qr", config: {} });
      await owner("UPDATE quest SET verification = '{quest_qr,my_qr}' WHERE id = $1", [second]);
      const { player, enrollment } = await member(event);
      const operator = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{scan_quests}')",
        [ids.orgA, event, operator.player],
      );
      expect(
        await refusal(
          query(as(operator.player), "SELECT * FROM operator_complete_quest($1, $2, 1, $3)", [
            second,
            player,
            randomUUID(),
          ]),
        ),
      ).toBe("QN403:category_not_started");
      await award(event, enrollment, second);
      expect(await standing(enrollment)).toMatchObject({ score: "10" });
    });

    it("refuses a cycle and a self unlock, and a delete of a category another unlocks after", async () => {
      const event = await newEvent();
      const one = await newCategory(event);
      const two = await newCategory(event, { unlockAfter: one });
      const three = await newCategory(event, { unlockAfter: two });
      await expect(
        owner("UPDATE category SET unlock_after = $2 WHERE id = $1", [one, three]),
      ).rejects.toMatchObject({ code: "CU422" });
      await expect(
        owner("UPDATE category SET unlock_after = id WHERE id = $1", [one]),
      ).rejects.toMatchObject({ code: "CU422" });
      await expect(owner("DELETE FROM category WHERE id = $1", [two])).rejects.toMatchObject({
        code: "23503",
      });
    });
  });

  describe("the bonus", () => {
    it("pays once on the last quest, beside the quest's points, and not with no bonus set", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 50 });
      const first = await newQuest(event, group, { cap: 2 });
      const last = await newQuest(event, group);
      await newQuest(event, group).then((hidden) =>
        owner("UPDATE quest SET visible = false WHERE id = $1", [hidden]),
      );
      const { player, enrollment } = await member(event);
      await code(player, first);
      expect(await bonuses(enrollment)).toEqual([]);
      const key = randomUUID();
      expect(await code(player, last, key)).toMatchObject({ score: "70", balance: "70" });
      expect(await bonuses(enrollment)).toEqual([
        { score_delta: "50", balance_delta: "50", actor: "system" },
      ]);
      await code(player, last, key);
      await code(player, first);
      expect(await bonuses(enrollment)).toHaveLength(1);
      expect(await standing(enrollment)).toEqual({ score: "80", balance: "80" });
      expect(
        await query(as(player), "SELECT points, name_en FROM own_bonus($1)", [
          (
            await owner<{ id: string }>(
              "SELECT id FROM quest_completion WHERE enrollment_id = $1 AND quest_id = $2",
              [enrollment, last],
            )
          )[0]?.id,
        ]),
      ).toEqual([{ points: "50", name_en: "Chapter" }]);

      const plain = await newCategory(event);
      const only = await newQuest(event, plain);
      const other = await member(event);
      await code(other.player, only);
      expect(await bonuses(other.enrollment)).toEqual([]);
    });

    it("moves the score only once the shop has closed", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 40 });
      const quest = await newQuest(event, group, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
        points: 100,
      });
      const { player, enrollment } = await member(event);
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
        [player],
      );
      const [sent] = await query<{ submission_id: string }>(
        as(player),
        "SELECT * FROM submit_quest($1, 'Hi', '1.0', $2)",
        [quest, randomUUID()],
      );
      await owner(
        `UPDATE event SET status = 'ended', ends_at = now() - interval '5 days', starts_at = now() - interval '6 days',
                          shop_days_after = 1 WHERE id = $1`,
        [event],
      );
      await query(
        team(),
        "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
        [event, sent?.submission_id, randomUUID(), randomUUID()],
      );
      expect(await bonuses(enrollment)).toEqual([
        { score_delta: "40", balance_delta: "0", actor: "system" },
      ]);
      expect(await standing(enrollment)).toEqual({ score: "140", balance: "0" });
    });

    it("pays on a zero-right quiz finish, marks the ranking, and reads it back by the attempt", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 30 });
      const quiz = await newQuest(event, group, { type: "quiz", config: QUIZ });
      const { player, enrollment } = await member(event);
      await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      await playQuiz(player, quiz, "w");
      expect(await bonuses(enrollment)).toEqual([
        { score_delta: "30", balance_delta: "30", actor: "system" },
      ]);
      expect(await query(as(player), "SELECT points FROM own_category_bonus($1)", [quiz])).toEqual([
        { points: "30" },
      ]);
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
    });

    it("pays nothing when a zero-right quiz finishes for a player who may not be paid", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 30 });
      const quiz = await newQuest(event, group, { type: "quiz", config: QUIZ });
      const { player, enrollment } = await member(event);
      await query(as(player), "SELECT quiz_start($1)", [quiz]);
      await query(as(player), "SELECT quiz_next($1)", [quiz]);
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 minute' WHERE id = $1",
        [event],
      );
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      for (let i = 0; i < 5; i += 1) {
        await query({}, "SELECT finish_one_due_quiz()");
      }
      expect(
        await owner("SELECT status FROM quiz_attempt WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([{ status: "finished" }]);
      expect(await bonuses(enrollment)).toEqual([]);
    });

    it("pays one bonus for two parallel last completions", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const a = await newQuest(event, group);
      const b = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      await Promise.all([code(player, a), code(player, b)]);
      expect(await bonuses(enrollment)).toHaveLength(1);
      expect(await standing(enrollment)).toMatchObject({ score: "45" });
    });

    it("pays nothing when a later hide or delete leaves the category done", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const a = await newQuest(event, group);
      const b = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      await code(player, a);
      await owner("UPDATE quest SET visible = false WHERE id = $1", [b]);
      expect(await bonuses(enrollment)).toEqual([]);
    });

    it("keeps a closed undone quest against the strict done", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 25 });
      const a = await newQuest(event, group);
      const b = await newQuest(event, group);
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [b]);
      const { player, enrollment } = await member(event);
      await code(player, a);
      expect(await bonuses(enrollment)).toEqual([]);
    });
  });

  describe("removal", () => {
    it("leaves the bonus when a quest is removed, and removes the bonus on its own, never paid again", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 50 });
      const quest = await newQuest(event, group, { cap: 2 });
      const { player, enrollment } = await member(event);
      await code(player, quest);
      const [credit] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [enrollment],
      );
      await remove(event, credit?.id ?? "");
      expect(await standing(enrollment)).toEqual({ score: "50", balance: "50" });
      const [bonus] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'",
        [enrollment],
      );
      const listed = await query<{
        id: string;
        kind: string;
        removable: boolean;
        title_en: string;
      }>(team(), "SELECT id, kind, removable, title_en FROM member_ledger($1, $2, NULL, 50)", [
        event,
        enrollment,
      ]);
      expect(listed.find((line) => line.kind === "bonus")).toMatchObject({
        removable: true,
        title_en: "Chapter",
      });
      await remove(event, bonus?.id ?? "");
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      await code(player, quest);
      expect(await bonuses(enrollment)).toHaveLength(1);
      expect(
        await owner(
          `SELECT x.delta FROM xp_entry x JOIN ledger_entry l ON l.id = x.ledger_entry_id
           WHERE l.enrollment_id = $1 AND l.category_id IS NOT NULL`,
          [enrollment],
        ),
      ).toEqual([]);
    });
  });

  describe("the player's read", () => {
    it("shows each category's rules, the bonus earned and each quest's lock", async () => {
      const event = await newEvent();
      const one = await newCategory(event, { bonus: 20 });
      const first = await newQuest(event, one);
      const two = await newCategory(event, { unlockAfter: one, order: "in_order" });
      const locked = await newQuest(event, two);
      const { player } = await member(event);
      await code(player, first);
      const rows = await query<Row>(
        as(player),
        `SELECT quest_id, order_mode, unlock_after, unlock_after_name_en, completion_bonus, bonus_earned, lock
         FROM member_event_quests($1)`,
        [event],
      );
      expect(rows).toEqual([
        {
          quest_id: first,
          order_mode: "any",
          unlock_after: null,
          unlock_after_name_en: null,
          completion_bonus: 20,
          bonus_earned: "20",
          lock: null,
        },
        {
          quest_id: locked,
          order_mode: "in_order",
          unlock_after: one,
          unlock_after_name_en: "Chapter",
          completion_bonus: 0,
          bonus_earned: "0",
          lock: null,
        },
      ]);
    });
  });

  describe("rehearsal and erasure", () => {
    it("counts the bonus among a rehearsal's points and wipes it", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ABCD-EFGH')",
        [event, ids.orgA],
      );
      const group = await newCategory(event, { bonus: 15 });
      const quest = await newQuest(event, group);
      const { player } = await member(event, "rehearsal");
      await code(player, quest);
      const [card] = await query<{ points: string }>(
        team(),
        "SELECT points FROM rehearsal_card($1)",
        [event],
      );
      expect(card?.points).toBe("25");
      const [wiped] = await owner<{ counts: { points: number } }>(
        "SELECT wipe_rehearsal($1, 'go_live', NULL) AS counts",
        [event],
      );
      expect(wiped?.counts.points).toBe(25);
      expect(await owner("SELECT 1 FROM category_bonus WHERE event_id = $1", [event])).toEqual([]);
    });

    it("deletes an erased account's bonus rows and keeps the ledger", async () => {
      const event = await newEvent();
      const group = await newCategory(event, { bonus: 15 });
      const quest = await newQuest(event, group);
      const { player, enrollment } = await member(event);
      await code(player, quest);
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [player, enrollment]);
      expect(
        await owner("SELECT 1 FROM category_bonus WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([]);
      expect(await bonuses(enrollment)).toHaveLength(1);
    });
  });

  describe("closed doors", () => {
    it("keeps the table and the internal helpers away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM category_bonus",
        "SELECT pay_category_bonus(NULL::enrollment, gen_random_uuid(), NULL)",
        "SELECT category_lock(NULL::quest, gen_random_uuid())",
        "SELECT category_done(gen_random_uuid(), gen_random_uuid())",
        "SELECT quest_open_check(NULL::quest, NULL::enrollment, false)",
      ]) {
        await expect(query(team(), sql), sql).rejects.toMatchObject({ code: "42501" });
      }
    });
  });
});
