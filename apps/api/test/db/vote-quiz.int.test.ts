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
type Paid = {
  completion_id: string;
  points: string;
  score: string;
  balance: string;
  replayed: boolean;
};
type Quiz = {
  status: string;
  total: number;
  points_each: number;
  timer_seconds: number | null;
  right_count: number;
  earned: string;
  completion_id: string | null;
  current: Row | null;
  answered: Row[];
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

const text = (en: string) => ({ en });
const as = (player: string): RequestContext => ({ playerId: player });
const VOTE = {
  options: [
    { id: "a", text: text("Robots") },
    { id: "b", text: text("Space") },
    { id: "c", text: text("Oceans") },
  ],
};
/** Three questions; the right choice of each is "r". */
const quizConfig = (timerSeconds: number | null = null, count = 3) => ({
  questions: Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    text: text(`Question ${i + 1}`),
    choices: [
      { id: "r", text: text("Right") },
      { id: "w", text: text("Wrong") },
    ],
    right: "r",
  })),
  timerSeconds,
});

/**
 * Vote and quiz quests in the database (T-302, migration 0041, ADR-190 to ADR-195): one vote paid as a completion,
 * the quiz served one question at a time on the server's clock, one try, payment once at the end, the sweep, the
 * re-checks, the locks on a played quest's structure, erasure and the rehearsal wipe, and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("vote and quiz quests (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let ownerB = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
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

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Quiz Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `VQZ${counter}`, status],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, type: "vote" | "quiz", config: object, points = 10) => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, $3, 'Play', $4, $5) RETURNING id`,
      [event, category?.id, type, points, JSON.stringify(config)],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`vq_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player?.id, via],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  const vote = async (player: string, quest: string, option: string, key: string = randomUUID()) =>
    (
      await query<Paid>(as(player), "SELECT * FROM vote_quest($1, $2, $3)", [quest, option, key])
    )[0] as Paid;
  const start = async (player: string, quest: string) =>
    (await query<{ id: string }>(as(player), "SELECT quiz_start($1) AS id", [quest]))[0]?.id;
  const next = async (player: string, quest: string) =>
    (await query<{ status: string }>(as(player), "SELECT quiz_next($1) AS status", [quest]))[0]
      ?.status;
  const answer = async (player: string, quest: string, question: string, choice: string) =>
    (
      await query<{ replayed: boolean }>(as(player), "SELECT quiz_answer($1, $2, $3) AS replayed", [
        quest,
        question,
        choice,
      ])
    )[0]?.replayed;
  const quiz = async (player: string, quest: string) =>
    (await query<Quiz>(as(player), "SELECT * FROM member_quiz($1)", [quest]))[0] as Quiz;
  /** Plays the whole quiz: `choices[i]` for question i+1. */
  const play = async (player: string, quest: string, choices: string[]) => {
    await start(player, quest);
    for (const [i, choice] of choices.entries()) {
      await next(player, quest);
      await answer(player, quest, `q${i + 1}`, choice);
    }
  };
  const standing = async (enrollment: string) =>
    (
      await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];
  const completions = async (enrollment: string) =>
    owner<{ method: string; idempotency_key: string }>(
      "SELECT method, idempotency_key FROM quest_completion WHERE enrollment_id = $1",
      [enrollment],
    );
  const attemptOf = async (enrollment: string) =>
    (
      await owner<{ id: string; status: string; swept: boolean; right_count: number }>(
        "SELECT id, status, swept, right_count FROM quiz_attempt WHERE enrollment_id = $1",
        [enrollment],
      )
    )[0];
  const backdate = async (enrollment: string, position: number, seconds: number) =>
    owner(
      `UPDATE quiz_answer a SET served_at = now() - make_interval(secs => $3)
       FROM quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = $1 AND a.position = $2`,
      [enrollment, position, seconds],
    );
  const sweep = async () =>
    (await query<{ outcome: string | null }>({}, "SELECT finish_one_due_quiz() AS outcome"))[0]
      ?.outcome;
  /** Finishes whatever earlier tests left due, so a sweep test sees only its own attempts. */
  const drain = async () => {
    while ((await sweep()) !== null) {
      // keep sweeping
    }
  };

  describe("voting", () => {
    it("pays one vote as a completion, replays its key, and refuses a second vote", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "vote", VOTE, 25);
      const { player, enrollment } = await member(event);
      const key = randomUUID();
      const first = await vote(player, quest, "b", key);
      expect(first).toMatchObject({ points: "25", score: "25", balance: "25", replayed: false });
      expect(await vote(player, quest, "b", key)).toEqual({ ...first, replayed: true });
      expect(await refusal(vote(player, quest, "c", key))).toBe("QK422");
      expect(await refusal(vote(player, quest, "c"))).toBe("QD409:1");
      expect(await completions(enrollment)).toEqual([{ method: "vote", idempotency_key: key }]);
      expect(
        await query(as(player), "SELECT option_id, mine FROM member_vote($1)", [quest]),
      ).toEqual([
        { option_id: "a", mine: false },
        { option_id: "b", mine: true },
        { option_id: "c", mine: false },
      ]);
    });

    it("refuses an unknown option, another type, a reserved key and every closed door", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "vote", VOTE);
      const other = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      expect(await refusal(vote(player, quest, "zz"))).toBe("VO422");
      expect(await refusal(vote(player, other, "a"))).toBe("QT422:vote");
      expect(await refusal(vote(player, quest, "a", "quiz:1"))).toBe("QK422");
      expect(await refusal(vote(randomUUID(), quest, "a"))).toBe("QC404");
      await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [
        quest,
      ]);
      expect(await refusal(vote(player, quest, "a"))).toBe("QN403:ended");
      await owner("UPDATE quest SET closes_at = NULL WHERE id = $1", [quest]);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [enrollment]);
      expect(await refusal(vote(player, quest, "a"))).toBe("QC403:banned");
    });

    it("refuses an operator who may not play", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "vote", VOTE);
      const { player } = await member(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play) VALUES ($1, $2, $3, '{review}', false)",
        [ids.orgA, event, player],
      );
      expect(await refusal(vote(player, quest, "a"))).toBe("QP403");
    });

    it("shows each option's count to the event's team only", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "vote", VOTE);
      for (const option of ["a", "b", "b"]) {
        await vote((await member(event)).player, quest, option);
      }
      expect(
        await query(teamA(), "SELECT option_id, votes FROM quest_vote_counts($1, $2)", [
          event,
          quest,
        ]),
      ).toEqual([
        { option_id: "a", votes: "1" },
        { option_id: "b", votes: "2" },
        { option_id: "c", votes: "0" },
      ]);
      expect(
        await refusal(query(teamB(), "SELECT * FROM quest_vote_counts($1, $2)", [event, quest])),
      ).toBe("AN404");
      expect(
        await query({ playerId: randomUUID() }, "SELECT * FROM member_vote($1)", [quest]),
      ).toEqual([]);
    });
  });

  describe("quiz: serving and one try", () => {
    it("serves in order, never ahead, and never moves a deadline", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(30));
      const { player } = await member(event);
      expect(await quiz(player, quest)).toMatchObject({
        status: "none",
        total: 3,
        timer_seconds: 30,
      });
      const attempt = await start(player, quest);
      expect(await start(player, quest)).toBe(attempt);
      expect(await next(player, quest)).toBe("open");
      const first = (await quiz(player, quest)).current;
      expect(first).toMatchObject({ position: 1, id: "q1" });
      expect(JSON.stringify(first)).not.toContain('"right"');
      expect(await next(player, quest)).toBe("open");
      expect((await quiz(player, quest)).current).toEqual(first);
      expect(await refusal(answer(player, quest, "q2", "r"))).toBe("QA409:not_served");
      expect(await refusal(answer(player, quest, "q9", "r"))).toBe("QO422");
      expect(await refusal(answer(player, quest, "q1", "x"))).toBe("QO422");
    });

    it("takes one try, replays the same choice, and shows the right answer after", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player } = await member(event);
      await start(player, quest);
      await next(player, quest);
      expect(await answer(player, quest, "q1", "w")).toBe(false);
      expect(await answer(player, quest, "q1", "w")).toBe(true);
      expect(await refusal(answer(player, quest, "q1", "r"))).toBe("QA409:answered");
      const seen = await quiz(player, quest);
      expect(seen.current).toBeNull();
      expect(seen.answered).toEqual([
        expect.objectContaining({
          id: "q1",
          choiceId: "w",
          rightChoiceId: "r",
          right: false,
          closed: false,
        }),
      ]);
    });

    it("keeps one answer when two arrive at once", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      const outcomes = await Promise.all(
        ["r", "w"].map((choice) => refusal(answer(player, quest, "q1", choice))),
      );
      expect(outcomes.toSorted()).toEqual(["QA409:answered", "none"]);
      expect(
        await owner(
          `SELECT count(*)::int AS n FROM quiz_answer a JOIN quiz_attempt t ON t.id = a.attempt_id
           WHERE t.enrollment_id = $1 AND a.answered_at IS NOT NULL`,
          [enrollment],
        ),
      ).toEqual([{ n: 1 }]);
    });
  });

  describe("quiz: the timer", () => {
    it("accepts an answer inside the grace, refuses one after it, and closes the question with no points", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(10));
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      await backdate(enrollment, 1, 11);
      expect(await answer(player, quest, "q1", "r")).toBe(false);
      await next(player, quest);
      await backdate(enrollment, 2, 13);
      expect(await refusal(answer(player, quest, "q2", "r"))).toBe("QA409:closed");
      const seen = await quiz(player, quest);
      expect(seen.current).toBeNull();
      expect(seen.answered[1]).toMatchObject({
        id: "q2",
        closed: true,
        rightChoiceId: "r",
        right: false,
      });
      expect(
        await owner(
          `SELECT a.closed FROM quiz_answer a JOIN quiz_attempt t ON t.id = a.attempt_id
           WHERE t.enrollment_id = $1 AND a.position = 2`,
          [enrollment],
        ),
      ).toEqual([{ closed: false }]);
      expect(await next(player, quest)).toBe("open");
      expect((await quiz(player, quest)).current).toMatchObject({ id: "q3" });
      expect(seen.right_count).toBe(1);
    });

    it("closes an overdue last question, finishes the attempt and pays", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(10, 2));
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      await answer(player, quest, "q1", "r");
      await next(player, quest);
      await backdate(enrollment, 2, 20);
      expect(await next(player, quest)).toBe("paid");
      expect(await quiz(player, quest)).toMatchObject({
        status: "finished",
        right_count: 1,
        earned: "10",
      });
      expect(await standing(enrollment)).toEqual({ score: "10", balance: "10" });
    });
  });

  describe("quiz: payment", () => {
    it("pays right answers × the points frozen at start, once, with XP", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(), 10);
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await owner("UPDATE quest SET points = 999 WHERE id = $1", [quest]);
      await play(player, quest, ["r", "w", "r"]);
      const attempt = await attemptOf(enrollment);
      expect(attempt).toMatchObject({ status: "finished", right_count: 2, swept: false });
      expect(await completions(enrollment)).toEqual([
        { method: "quiz", idempotency_key: `quiz:${attempt?.id}` },
      ]);
      expect(await standing(enrollment)).toEqual({ score: "20", balance: "20" });
      const [xp] = await owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [
        player,
      ]);
      expect(Number(xp?.xp)).toBeGreaterThan(0);
      expect(await answer(player, quest, "q3", "r")).toBe(true);
      expect(await quiz(player, quest)).toMatchObject({
        completion_id: expect.any(String),
        earned: "20",
      });
      expect(await refusal(start(player, quest))).toBe("none");
    });

    it("pays nothing for no right answers, and the quest still shows as done", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await play(player, quest, ["w", "w", "w"]);
      expect(await attemptOf(enrollment)).toMatchObject({ status: "finished", right_count: 0 });
      expect(await completions(enrollment)).toEqual([]);
      expect(
        await query(
          as(player),
          "SELECT done, earned FROM member_event_quests($1) WHERE quest_id = $2",
          [event, quest],
        ),
      ).toEqual([{ done: 1, earned: "0" }]);
    });

    it("refuses a manual award while the quiz is in play, so the quest pays once", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(null, 1));
      const { player, enrollment } = await member(event);
      await start(player, quest);
      const award = () =>
        query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
          event,
          enrollment,
          quest,
          randomUUID(),
          randomUUID(),
        ]);
      expect(await refusal(award())).toBe("QD409:1");
      await next(player, quest);
      await answer(player, quest, "q1", "r");
      expect(await completions(enrollment)).toHaveLength(1);
      expect(await refusal(award())).toBe("QD409:1");
    });

    it("refuses a start once the quest was completed by a manual award", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await query(teamA(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event,
        enrollment,
        quest,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await refusal(start(player, quest))).toBe("QD409:1");
    });
  });

  describe("quiz: re-checks and the sweep", () => {
    it("voids the attempt of a player banned from the event and refuses their answer", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [enrollment]);
      expect(await attemptOf(enrollment)).toMatchObject({ status: "void" });
      expect(await refusal(answer(player, quest, "q1", "r"))).toBe("QC403:banned");
      expect(await refusal(next(player, quest))).toBe("QC403:banned");
    });

    it("pays an abandoned attempt once the quest closes, as the system, without a burst flag", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      await answer(player, quest, "q1", "r");
      await drain();
      expect(await sweep()).toBeNull();
      await owner("UPDATE quest SET closes_at = now() - interval '1 second' WHERE id = $1", [
        quest,
      ]);
      expect(await query(as(player), "SELECT finish_one_due_quiz() AS outcome")).toEqual([
        { outcome: null },
      ]);
      expect(await sweep()).toBe("paid");
      expect(await attemptOf(enrollment)).toMatchObject({ status: "finished", swept: true });
      expect(await standing(enrollment)).toEqual({ score: "10", balance: "10" });
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
      expect(
        await owner(
          "SELECT system_paid('quiz', idempotency_key) AS swept FROM quest_completion WHERE enrollment_id = $1",
          [enrollment],
        ),
      ).toEqual([{ swept: true }]);
      expect(await sweep()).toBeNull();
    });

    it("voids an abandoned attempt of a player banned from the platform", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      await answer(player, quest, "q1", "r");
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [player]);
      await drain();
      await owner("UPDATE quest SET closes_at = now() - interval '1 second' WHERE id = $1", [
        quest,
      ]);
      expect(await sweep()).toBe("void");
      expect(await completions(enrollment)).toEqual([]);
    });

    it("finishes an attempt whose overdue last question was never closed, and one whose event ended", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(10, 1));
      const { player, enrollment } = await member(event);
      await start(player, quest);
      await next(player, quest);
      await backdate(enrollment, 1, 30);
      await drain();
      expect(await attemptOf(enrollment)).toMatchObject({ status: "finished", right_count: 0 });
      const ended = await newEvent();
      const other = await newQuest(ended, "quiz", quizConfig());
      const late = await member(ended);
      await play(late.player, other, ["r"]);
      await owner("UPDATE event SET ends_at = now() - interval '1 second' WHERE id = $1", [ended]);
      await drain();
      expect(await standing(late.enrollment)).toMatchObject({ score: "10" });
    });

    it("voids an attempt whose finishing fails, with an audit entry, and sweeps the next one", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const bad = await member(event);
      const good = await member(event);
      for (const one of [bad, good]) {
        await start(one.player, quest);
        await next(one.player, quest);
        await answer(one.player, quest, "q1", "r");
      }
      await drain();
      const broken = (await attemptOf(bad.enrollment))?.id ?? "";
      await owner(
        `CREATE FUNCTION test_fail_quiz() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.idempotency_key = 'quiz:${broken}' THEN RAISE EXCEPTION 'broken'; END IF;
           RETURN NEW;
         END $$`,
      );
      await owner(
        "CREATE TRIGGER test_fail_quiz BEFORE INSERT ON quest_completion FOR EACH ROW EXECUTE FUNCTION test_fail_quiz()",
      );
      try {
        await owner("UPDATE quest SET closes_at = now() - interval '1 second' WHERE id = $1", [
          quest,
        ]);
        expect(await sweep()).toBe("void");
        expect(await sweep()).toBe("paid");
        expect(await sweep()).toBeNull();
      } finally {
        await owner("DROP TRIGGER test_fail_quiz ON quest_completion");
        await owner("DROP FUNCTION test_fail_quiz()");
      }
      expect(await attemptOf(bad.enrollment)).toMatchObject({ status: "void", swept: true });
      expect(await completions(bad.enrollment)).toEqual([]);
      expect(await standing(good.enrollment)).toEqual({ score: "10", balance: "10" });
      expect(
        await owner(
          "SELECT actor_type, target_type, after FROM audit_log WHERE action = 'event.quiz_voided' AND target_id = $1",
          [broken],
        ),
      ).toEqual([{ actor_type: "system", target_type: "quiz_attempt", after: { error: "P0001" } }]);
    });

    it("finishes the event's open quizzes when the owner confirms the results", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await play(player, quest, ["r"]);
      await owner(
        "UPDATE event SET status = 'ended', starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1",
        [event],
      );
      const confirm = (expected: string[]) =>
        query<{ outcome: string }>(teamA(), "SELECT confirm_results($1, $2, $3) AS outcome", [
          event,
          expected,
          randomUUID(),
        ]);
      expect(await confirm([])).toEqual([{ outcome: "results_changed" }]);
      expect(await attemptOf(enrollment)).toMatchObject({ status: "finished", swept: true });
      expect(await confirm([enrollment])).toEqual([{ outcome: "confirmed" }]);
    });
  });

  describe("reserved keys", () => {
    it("refuses a `quiz:` key for a completion and a submission", async () => {
      const event = await newEvent();
      const { player } = await member(event);
      const quest = await newQuest(event, "quiz", quizConfig());
      expect(
        await refusal(
          query(as(player), "SELECT * FROM complete_quest($1, 'code', NULL, 'X', 'quiz:1', NULL)", [
            quest,
          ]),
        ),
      ).toBe("QK422");
      expect(
        await refusal(
          query(as(player), "SELECT * FROM submit_quest($1, 'Hi', '1.0', 'quiz:1')", [quest]),
        ),
      ).toBe("QK422");
    });
  });

  describe("a played quest's structure", () => {
    it("locks option ids after the first vote, while text may change", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "vote", VOTE);
      await owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
        quest,
        JSON.stringify({ options: VOTE.options.slice(0, 2) }),
      ]);
      await vote((await member(event)).player, quest, "a");
      const renamed = { options: [{ id: "a", text: text("Robotics") }, VOTE.options[1]] };
      await owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
        quest,
        JSON.stringify(renamed),
      ]);
      await expect(
        owner("UPDATE quest SET type_config = $2 WHERE id = $1", [quest, JSON.stringify(VOTE)]),
      ).rejects.toMatchObject({ code: "QL409" });
    });

    it("locks right answers and the timer after the first start", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "quiz", quizConfig(30));
      await start((await member(event)).player, quest);
      const config = quizConfig(30);
      const edited = { ...config, questions: config.questions.map((q) => ({ ...q, right: "w" })) };
      for (const changed of [edited, quizConfig(60)]) {
        await expect(
          owner("UPDATE quest SET type_config = $2 WHERE id = $1", [
            quest,
            JSON.stringify(changed),
          ]),
        ).rejects.toMatchObject({ code: "QL409" });
      }
      const retitled = {
        ...config,
        questions: config.questions.map((q) => ({ ...q, text: text("Better wording") })),
      };
      await owner("UPDATE quest SET type_config = $2, points = 50 WHERE id = $1", [
        quest,
        JSON.stringify(retitled),
      ]);
    });

    it("holds one try per player and the shapes in the database", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, "vote", VOTE);
      await expect(
        owner("UPDATE quest SET repeat_cap = 2 WHERE id = $1", [quest]),
      ).rejects.toMatchObject({
        code: "23514",
      });
      await expect(newQuest(event, "vote", { options: [VOTE.options[0]] })).rejects.toMatchObject({
        code: "23514",
      });
      await expect(newQuest(event, "quiz", quizConfig(3))).rejects.toMatchObject({ code: "23514" });
      await expect(newQuest(event, "quiz", quizConfig(12.5))).rejects.toMatchObject({
        code: "23514",
      });
      await expect(newQuest(event, "quiz", { questions: [] })).rejects.toMatchObject({
        code: "23514",
      });
    });
  });

  describe("erasure and rehearsal", () => {
    it("deletes a deleted account's votes and quiz answers and keeps the attempt", async () => {
      const event = await newEvent();
      const ballot = await newQuest(event, "vote", VOTE);
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event);
      await vote(player, ballot, "a");
      await play(player, quest, ["r", "r", "r"]);
      await owner("SELECT erase_rows($1, $2, NULL)", [player, [enrollment]]);
      expect(
        await owner("SELECT 1 FROM quest_vote WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([]);
      expect(
        await owner(
          "SELECT 1 FROM quiz_answer a JOIN quiz_attempt t ON t.id = a.attempt_id WHERE t.enrollment_id = $1",
          [enrollment],
        ),
      ).toEqual([]);
      expect(await attemptOf(enrollment)).toMatchObject({ status: "finished", right_count: 3 });
    });

    it("erases a rehearsal account's votes and quizzes with the rehearsal, and counts them", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'QZVT-REHR')",
        [event, ids.orgA],
      );
      const ballot = await newQuest(event, "vote", VOTE);
      const quest = await newQuest(event, "quiz", quizConfig());
      const { player, enrollment } = await member(event, "rehearsal");
      await vote(player, ballot, "a");
      await play(player, quest, ["r", "w", "r"]);
      const [wiped] = await owner<{ counts: Row }>(
        "SELECT wipe_rehearsal($1, 'go_live', $2) AS counts",
        [event, randomUUID()],
      );
      expect(wiped?.counts).toMatchObject({ votes: 1, quizzes: 1, completions: 2 });
      expect(await attemptOf(enrollment)).toBeUndefined();
    });
  });

  describe("closed doors", () => {
    it("keeps the tables and the internal helpers away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM quest_vote",
        "SELECT * FROM quiz_attempt",
        "SELECT * FROM quiz_answer",
        "SELECT pay_completion(NULL::enrollment, NULL, 0, 'quiz', 'k', NULL, NULL)",
        "SELECT finish_quiz(NULL::quiz_attempt)",
        "SELECT play_enter(NULL::quest, 'quiz')",
        "SELECT quiz_locked(NULL::quest)",
        "SELECT quiz_due(NULL::quiz_attempt)",
        "SELECT system_paid('quiz', 'quiz:1')",
        "SELECT quest_structure('vote', '{}')",
        "SELECT quiz_overdue(now(), 1)",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
