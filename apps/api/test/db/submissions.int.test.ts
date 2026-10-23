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
type Sent = {
  submission_id: string;
  status: string;
  points: number;
  completion_id: string | null;
  score: string;
  balance: string;
  replayed: boolean;
};
type Reviewed = { submission_id: string; status: string; points: number; replayed: boolean };
type QuestOptions = {
  autoApprove?: boolean;
  resubmit?: boolean;
  repeatCap?: number;
  points?: number;
};

const GUIDELINES = "1.0";

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

/**
 * Submission quests in the database (T-301, migration 0040, ADR-184, ADR-187 to ADR-189): pending points outside the
 * ledger, one approval paying once at the frozen amount, rejections that add nothing, resubmission and the cap, the
 * auto-approve path, removal through both doors, the approval re-checks and what closes pending ones, the rehearsal
 * wipe, burst flags, the word lists, and the closed doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("submission quests (database)", () => {
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
    await db.owner.query(
      "INSERT INTO username_word (word, match, language) VALUES ('qxbad', 'word', 'en'), ('خبيث', 'part', 'ar')",
    );
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

  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Sub Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `SUBF${counter}`, status],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, options: QuestOptions = {}): Promise<string> => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event],
    );
    const config = {
      accepts: ["text"],
      autoApprove: options.autoApprove ?? false,
      resubmit: options.resubmit ?? false,
    };
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, 'submission', 'Tell us', $3, $4, $5) RETURNING id`,
      [event, category?.id, options.points ?? 150, options.repeatCap ?? 1, JSON.stringify(config)],
    );
    return quest?.id ?? "";
  };
  const newPlayer = async (accepted = true): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`sub_player_${counter}`],
    );
    if (accepted) {
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', $2, 'submission')`,
        [player?.id, GUIDELINES],
      );
    }
    return player?.id ?? "";
  };
  const enroll = async (player: string, event: string, via = "code"): Promise<string> => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [ids.orgA, event, player, via],
    );
    return made?.id ?? "";
  };
  const member = async (event: string) => {
    const player = await newPlayer();
    return { player, enrollment: await enroll(player, event) };
  };
  const send = async (
    player: string,
    quest: string,
    body = "My answer",
    key: string = randomUUID(),
  ) =>
    (
      await query<Sent>({ playerId: player }, "SELECT * FROM submit_quest($1, $2, $3, $4)", [
        quest,
        body,
        GUIDELINES,
        key,
      ])
    )[0] as Sent;
  const review = async (
    event: string,
    submission: string,
    decision: "approve" | "reject",
    reason: string | null = null,
    key = randomUUID(),
  ) =>
    (
      await query<Reviewed>(
        teamA(),
        "SELECT * FROM staff_review_submission($1, $2, $3, $4, $5, $6)",
        [event, submission, decision, reason, key, randomUUID()],
      )
    )[0] as Reviewed;
  const standing = async (enrollment: string) =>
    (
      await owner<{ score: string; balance: string }>(
        "SELECT score, balance FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];
  const statusOf = async (submission: string) =>
    (
      await owner<{ status: string; reason: string | null; reason_system: boolean }>(
        "SELECT status, reason, reason_system FROM submission WHERE id = $1",
        [submission],
      )
    )[0];
  const xpOf = async (player: string) =>
    (await owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]?.xp;
  const operator = async (event: string, abilities = ["review"]) => {
    const player = await newPlayer();
    await owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)`,
      [ids.orgA, event, player, abilities],
    );
    return player;
  };

  describe("sending", () => {
    it("holds the points pending: nothing in score, balance, XP or the ledger", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player, enrollment } = await member(event);
      const sent = await send(player, quest, "  Hello  ");
      expect(sent).toMatchObject({
        status: "pending",
        points: 150,
        completion_id: null,
        replayed: false,
      });
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      expect(await xpOf(player)).toBe("0");
      expect(
        await owner("SELECT count(*)::int AS n FROM ledger_entry WHERE enrollment_id = $1", [
          enrollment,
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await owner("SELECT body FROM submission WHERE id = $1", [sent.submission_id]),
      ).toEqual([{ body: "Hello" }]);
    });

    it("replays a key with the first answer, and refuses it for other text", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const key = randomUUID();
      const first = await send(player, quest, "One", key);
      expect(await send(player, quest, "One", key)).toMatchObject({
        submission_id: first.submission_id,
        replayed: true,
      });
      expect(await refusal(send(player, quest, "Two", key))).toBe("QK422");
      expect(await refusal(send(player, quest, "One", "sub:1"))).toBe("QK422");
    });

    it("keeps one pending per quest and counts pending against the cap", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeatCap: 2 });
      const { player } = await member(event);
      const first = await send(player, quest);
      expect(await refusal(send(player, quest))).toBe("SP409");
      await review(event, first.submission_id, "approve");
      const second = await send(player, quest);
      await review(event, second.submission_id, "approve");
      expect(await refusal(send(player, quest))).toBe("QD409:2");
    });

    it("needs the guidelines accepted, an open submission quest, and clean text", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const fresh = await newPlayer(false);
      await enroll(fresh, event);
      expect(await refusal(send(fresh, quest))).toBe("SG403");
      const { player } = await member(event);
      expect(await refusal(send(player, quest, "   "))).toBe("SV422:empty");
      expect(await refusal(send(player, quest, "x".repeat(1001)))).toBe("SV422:too_long");
      expect(await refusal(send(player, quest, "bad‮word"))).toBe("SV422:characters");
      expect(await refusal(send(player, quest, "bell\u0007"))).toBe("SV422:characters");
      const [code] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, category_id, 'enter_code', 'Code', 10, '{"code": "ABCD"}' FROM quest WHERE id = $2 RETURNING id`,
        [event, quest],
      );
      expect(await refusal(send(player, code?.id ?? ""))).toBe("SQ422");
      await owner(
        "UPDATE quest SET closes_at = now() - interval '1 minute', opens_at = NULL WHERE id = $1",
        [quest],
      );
      expect(await refusal(send(player, quest))).toBe("QN403:ended");
      const stranger = await newPlayer();
      expect(await refusal(send(stranger, quest))).toBe("QC404");
    });

    it("refuses photos and video in the quest's config, at the database too", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      await expect(
        owner(`UPDATE quest SET type_config = '{"accepts": ["text", "photo"]}' WHERE id = $1`, [
          quest,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("marks text with a listed word (whole word or part, Arabic or English) without blocking it", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeatCap: 5, autoApprove: true });
      const { player } = await member(event);
      const marked = async (body: string) => {
        const sent = await send(player, quest, body);
        return (
          await owner<{ marked: boolean }>("SELECT marked FROM submission WHERE id = $1", [
            sent.submission_id,
          ])
        )[0]?.marked;
      };
      expect(await marked("hello, QXBAD!")).toBe(true);
      expect(await marked("قالها الخبيثون")).toBe(true);
      expect(await marked("a qxbadge is fine")).toBe(false);
      expect(await marked("كلام طيب")).toBe(false);
    });
  });

  describe("reviewing", () => {
    it("approves once at the frozen amount, with XP and a completion under the fixed key", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player, enrollment } = await member(event);
      const sent = await send(player, quest);
      await owner("UPDATE quest SET points = 999 WHERE id = $1", [quest]);
      const key = randomUUID();
      expect(await review(event, sent.submission_id, "approve", null, key)).toMatchObject({
        status: "approved",
        points: 150,
        replayed: false,
      });
      expect(await review(event, sent.submission_id, "approve", null, key)).toMatchObject({
        replayed: true,
      });
      expect(await refusal(review(event, sent.submission_id, "reject", "late", key))).toBe("SK422");
      expect(await refusal(review(event, sent.submission_id, "approve"))).toBe("SR409:approved");
      expect(await standing(enrollment)).toEqual({ score: "150", balance: "150" });
      expect(await xpOf(player)).toBe("100");
      expect(
        await owner(
          "SELECT method, idempotency_key FROM quest_completion WHERE enrollment_id = $1",
          [enrollment],
        ),
      ).toEqual([{ method: "submission", idempotency_key: `sub:${sent.submission_id}` }]);
      expect(
        await owner("SELECT action FROM audit_log WHERE target_id = $1", [sent.submission_id]),
      ).toEqual([{ action: "event.submission_approved" }]);
    });

    it("pays once when two reviewers approve at the same moment", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player, enrollment } = await member(event);
      const sent = await send(player, quest);
      const clients = [
        new Client({ connectionString: db.appUrl }),
        new Client({ connectionString: db.appUrl }),
      ];
      await Promise.all(clients.map((client) => client.connect()));
      try {
        const outcomes = await Promise.all(
          clients.map((client) =>
            refusal(
              withRequestContext(client, teamA(), () =>
                client.query(
                  "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
                  [event, sent.submission_id, randomUUID(), randomUUID()],
                ),
              ),
            ),
          ),
        );
        expect(outcomes.toSorted()).toEqual(["SR409:approved", "none"]);
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      expect(await standing(enrollment)).toEqual({ score: "150", balance: "150" });
    });

    it("rejects only with a reason and adds nothing; resubmit decides what follows", async () => {
      const event = await newEvent();
      const closedQuest = await newQuest(event);
      const openQuest = await newQuest(event, { resubmit: true });
      const { player, enrollment } = await member(event);
      const first = await send(player, closedQuest);
      expect(await refusal(review(event, first.submission_id, "reject", null))).toBe("AR400");
      expect(await refusal(review(event, first.submission_id, "reject", "  "))).toBe("AR400");
      await review(event, first.submission_id, "reject", "Off topic");
      expect(await statusOf(first.submission_id)).toEqual({
        status: "rejected",
        reason: "Off topic",
        reason_system: false,
      });
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      expect(await refusal(send(player, closedQuest))).toBe("QD409:closed");
      const again = await send(player, openQuest);
      await review(event, again.submission_id, "reject", "Blurry wording");
      expect(await send(player, openQuest)).toMatchObject({ status: "pending" });
    });

    it("lets an operator with review approve inside their quests, never their own or with the ability off", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const { player } = await member(event);
      const sent = await send(player, quest);
      const off = await operator(event, ["award"]);
      const asOperator = (who: string, id: string) =>
        query(
          { playerId: who },
          "SELECT * FROM operator_review_submission($1, $2, 'approve', NULL, $3)",
          [event, id, randomUUID()],
        );
      expect(await refusal(asOperator(off, sent.submission_id))).toBe("OA403");
      expect(await refusal(asOperator(player, sent.submission_id))).toBe("OP403");
      const limited = await operator(event);
      await owner(
        `INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id)
         SELECT id, event_id, $2 FROM staff_assignment WHERE player_id = $1`,
        [limited, other],
      );
      expect(await refusal(asOperator(limited, sent.submission_id))).toBe("OS403");
      expect(
        await query({ playerId: limited }, "SELECT id FROM operator_submissions($1, NULL, 50)", [
          event,
        ]),
      ).toEqual([]);
      const reviewer = await operator(event);
      await owner("UPDATE staff_assignment SET can_play = true WHERE player_id = $1", [reviewer]);
      await enroll(reviewer, event);
      const own = await send(reviewer, quest);
      expect(await refusal(asOperator(reviewer, own.submission_id))).toBe("SS403");
      expect(
        (
          await query<{ id: string }>(
            { playerId: reviewer },
            "SELECT id FROM operator_submissions($1, NULL, 50)",
            [event],
          )
        ).map((row) => row.id),
      ).toEqual([sent.submission_id]);
      await expect(asOperator(reviewer, sent.submission_id)).resolves.toHaveLength(1);
      expect(
        await owner("SELECT actor, operator_id FROM ledger_entry WHERE quest_id = $1", [quest]),
      ).toEqual([{ actor: "operator", operator_id: reviewer }]);
    });

    it("keeps another organizer's team out", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const sent = await send(player, quest);
      const teamB = { organizerId: ids.orgB, staffUserId: ownerB };
      expect(
        await refusal(
          query(teamB, "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)", [
            event,
            sent.submission_id,
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toBe("AN404");
      expect(
        await refusal(
          query(teamB, "SELECT * FROM event_submissions($1, 'pending', NULL, 50)", [event]),
        ),
      ).toBe("AN404");
      expect(await refusal(review(ids.eventA, sent.submission_id, "approve"))).toBe("SN404");
    });
  });

  describe("approval re-checks", () => {
    it.each(["banned", "removed", "left"])(
      "closes pending ones with a system reason when the player becomes %s, and refuses to approve them",
      async (status) => {
        const event = await newEvent();
        const quest = await newQuest(event, { resubmit: false });
        const { player, enrollment } = await member(event);
        const sent = await send(player, quest);
        await owner("UPDATE enrollment SET status = $2 WHERE id = $1", [enrollment, status]);
        expect(await statusOf(sent.submission_id)).toEqual({
          status: "rejected",
          reason: "left_event",
          reason_system: true,
        });
        expect(await refusal(review(event, sent.submission_id, "approve"))).toBe("SR409:rejected");
        await owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [enrollment]);
        expect(await send(player, quest)).toMatchObject({ status: "pending" });
      },
    );

    it("refuses approval once the event is archived (SE409), and closes nothing by itself", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const sent = await send(player, quest);
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      expect(await refusal(review(event, sent.submission_id, "approve"))).toBe("SE409");
      expect(await statusOf(sent.submission_id)).toMatchObject({ status: "pending" });
    });

    it("adds score only once the shop has closed after the event (FR-1710)", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player, enrollment } = await member(event);
      const sent = await send(player, quest);
      await owner(
        `UPDATE event SET status = 'ended', ends_at = now() - interval '5 days', starts_at = now() - interval '6 days',
                          shop_days_after = 1 WHERE id = $1`,
        [event],
      );
      await review(event, sent.submission_id, "approve");
      expect(await standing(enrollment)).toEqual({ score: "150", balance: "0" });
    });

    it("clears the text on account deletion and closes what waits", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeatCap: 2, autoApprove: false });
      const { player, enrollment } = await member(event);
      const done = await send(player, quest, "First");
      await review(event, done.submission_id, "approve");
      const waiting = await send(player, quest, "Second");
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [player, enrollment]);
      expect(
        await owner(
          "SELECT status, body, reason, erased_at IS NOT NULL AS erased FROM submission WHERE enrollment_id = $1 ORDER BY id",
          [enrollment],
        ),
      ).toEqual([
        { status: "approved", body: null, reason: null, erased: true },
        { status: "rejected", body: null, reason: "left_event", erased: true },
      ]);
      expect(await statusOf(waiting.submission_id)).toMatchObject({ reason_system: true });
    });
  });

  describe("auto-approve and removal", () => {
    it("pays at once, stays unseen in the queue, and is removable through remove_submission", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { autoApprove: true });
      const { player, enrollment } = await member(event);
      const sent = await send(player, quest);
      expect(sent).toMatchObject({ status: "approved", score: "150", balance: "150" });
      const unseen = await query<{ id: string }>(
        teamA(),
        "SELECT id FROM event_submissions($1, 'unseen', NULL, 50)",
        [event],
      );
      expect(unseen.map((row) => row.id)).toEqual([sent.submission_id]);
      expect(
        await query(teamA(), "SELECT mark_submissions_seen($1, ARRAY[$2]::bigint[]) AS n", [
          event,
          sent.submission_id,
        ]),
      ).toEqual([{ n: 1 }]);
      expect(
        await query(teamA(), "SELECT id FROM event_submissions($1, 'unseen', NULL, 50)", [event]),
      ).toEqual([]);
      const key = randomUUID();
      const remove = () =>
        query(teamA(), "SELECT * FROM remove_submission($1, $2, 'Spam', $3, $4)", [
          event,
          sent.submission_id,
          key,
          randomUUID(),
        ]);
      await remove();
      expect(await remove()).toMatchObject([{ replayed: true }]);
      expect(await statusOf(sent.submission_id)).toEqual({
        status: "removed",
        reason: "Spam",
        reason_system: false,
      });
      expect(await standing(enrollment)).toEqual({ score: "0", balance: "0" });
      expect(await xpOf(player)).toBe("0");
      expect(
        await owner(
          "SELECT kind, score_delta FROM ledger_entry WHERE enrollment_id = $1 ORDER BY id",
          [enrollment],
        ),
      ).toEqual([
        { kind: "quest", score_delta: "150" },
        { kind: "removal", score_delta: "-150" },
      ]);
      expect(
        await refusal(
          query(teamA(), "SELECT * FROM remove_submission($1, $2, 'Again', $3, $4)", [
            event,
            sent.submission_id,
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toBe("SR409:removed");
    });

    it("marks the submission removed when its entry is removed through remove_award", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const sent = await send(player, quest);
      await review(event, sent.submission_id, "approve");
      const [entry] = await owner<{ id: string }>(
        "SELECT l.id FROM ledger_entry l JOIN submission s ON s.completion_id = l.completion_id WHERE s.id = $1",
        [sent.submission_id],
      );
      await query(teamA(), "SELECT * FROM remove_award($1, $2, 'Copied', $3, $4)", [
        event,
        entry?.id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await statusOf(sent.submission_id)).toMatchObject({
        status: "removed",
        reason: "Copied",
      });
    });

    it("refuses removing a pending submission", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      const sent = await send(player, quest);
      expect(
        await refusal(
          query(teamA(), "SELECT * FROM remove_submission($1, $2, 'No', $3, $4)", [
            event,
            sent.submission_id,
            randomUUID(),
            randomUUID(),
          ]),
        ),
      ).toBe("SR409:pending");
    });
  });

  describe("flags, rehearsal and quests", () => {
    it("raises no burst for fast approvals, but auto-approved bursts still count", async () => {
      const event = await newEvent();
      const reviewed = await newQuest(event, { repeatCap: 12 });
      const auto = await newQuest(event, { repeatCap: 12, autoApprove: true });
      const first = await member(event);
      for (let i = 0; i < 11; i += 1) {
        const sent = await send(first.player, reviewed, `Answer ${i}`);
        await review(event, sent.submission_id, "approve");
      }
      expect(
        await owner("SELECT count(*)::int AS n FROM flag WHERE enrollment_id = $1", [
          first.enrollment,
        ]),
      ).toEqual([{ n: 0 }]);
      const second = await member(event);
      for (let i = 0; i < 10; i += 1) {
        await send(second.player, auto, `Answer ${i}`);
      }
      expect(
        await owner("SELECT kind FROM flag WHERE enrollment_id = $1", [second.enrollment]),
      ).toEqual([{ kind: "burst" }]);
    });

    it("erases a rehearsal account's submissions with the rehearsal", async () => {
      const event = await newEvent("draft");
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'ABCD-EFGH')",
        [event, ids.orgA],
      );
      const quest = await newQuest(event, { repeatCap: 2 });
      const player = await newPlayer();
      const enrollment = await enroll(player, event, "rehearsal");
      const sent = await send(player, quest);
      await review(event, sent.submission_id, "approve");
      await send(player, quest);
      await owner("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      expect(
        await owner("SELECT count(*)::int AS n FROM submission WHERE enrollment_id = $1", [
          enrollment,
        ]),
      ).toEqual([{ n: 0 }]);
    });

    it("keeps a quest with submissions from being deleted", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const { player } = await member(event);
      await send(player, quest);
      await expect(owner("DELETE FROM quest WHERE id = $1", [quest])).rejects.toMatchObject({
        code: "23503",
        table: "submission",
      });
    });
  });

  describe("reading", () => {
    it("shows a player only their own submissions", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { resubmit: true });
      const me = await member(event);
      const other = await member(event);
      const mine = await send(me.player, quest, "Mine");
      await send(other.player, quest, "Theirs");
      await review(event, mine.submission_id, "reject", "Try again");
      expect(
        await query(
          { playerId: me.player },
          "SELECT id, status, body, reason, resubmit FROM own_submissions($1)",
          [event],
        ),
      ).toEqual([
        {
          id: mine.submission_id,
          status: "rejected",
          body: "Mine",
          reason: "Try again",
          resubmit: true,
        },
      ]);
      expect(
        await query({ playerId: randomUUID() }, "SELECT * FROM own_submissions($1)", [event]),
      ).toEqual([]);
    });

    it("pages the team's queue: pending oldest first, done newest first", async () => {
      const event = await newEvent();
      const quest = await newQuest(event, { repeatCap: 1 });
      const players = [await member(event), await member(event), await member(event)];
      const sent = [];
      for (const one of players) {
        sent.push(await send(one.player, quest));
      }
      const page = await query<{ id: string }>(
        teamA(),
        "SELECT id FROM event_submissions($1, 'pending', NULL, 2)",
        [event],
      );
      expect(page.map((row) => row.id)).toEqual([sent[0]?.submission_id, sent[1]?.submission_id]);
      const next = await query<{ id: string }>(
        teamA(),
        "SELECT id FROM event_submissions($1, 'pending', $2, 2)",
        [event, sent[1]?.submission_id],
      );
      expect(next.map((row) => row.id)).toEqual([sent[2]?.submission_id]);
      await review(event, sent[0]?.submission_id ?? "", "approve");
      await review(event, sent[2]?.submission_id ?? "", "reject", "No");
      const done = await query<{ id: string }>(
        teamA(),
        "SELECT id FROM event_submissions($1, 'done', NULL, 10)",
        [event],
      );
      expect(done.map((row) => row.id)).toEqual([sent[2]?.submission_id, sent[0]?.submission_id]);
    });
  });

  describe("closed doors", () => {
    it("keeps the table and the internal helpers away from the API role", async () => {
      for (const sql of [
        "SELECT * FROM submission",
        "INSERT INTO submission (organizer_id) VALUES (gen_random_uuid())",
        "SELECT text_marked('x')",
        "SELECT clean_submission_text('x')",
        "SELECT reviewer_paid('submission', 'sub:1')",
        "SELECT operator_reviews_quest(gen_random_uuid(), gen_random_uuid(), gen_random_uuid())",
        "SELECT review_operator(gen_random_uuid())",
        "SELECT * FROM queue_rows(gen_random_uuid(), 'pending', NULL, 1, NULL)",
        "SELECT pay_submission(NULL::submission, NULL, NULL)",
      ]) {
        await expect(db.app.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });
  });
});
