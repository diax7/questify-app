import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

const as = (player: string): RequestContext => ({ playerId: player });

/** A call's SQLSTATE and detail, or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

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
const VOTE = {
  options: [
    { id: "a", text: { en: "Robots" } },
    { id: "b", text: { en: "Space" } },
  ],
};

/**
 * Pausing a quest and skipping a broken step in the database (T-603b, migration 0097, ADR-386): a pause refuses every
 * start door with QN403 `paused` while work already started finishes and pays; a skip frees the steps after it, the
 * category's bonus and a category unlocked after it; both are doors for the event's owner or editor only, idempotent
 * and audited, and the go-live wipe clears them.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("pause and skip (database)", () => {
  let f: QuestifyFixture;
  let counter = 0;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const category = async (event: string, order = "in_order", extra: object = {}) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, order_mode, completion_bonus, unlock_after, position)
         VALUES ($1, 'Chain', $2, $3, $4, $5) RETURNING id`,
        [
          event,
          order,
          (extra as { bonus?: number }).bonus ?? 0,
          (extra as { after?: string }).after ?? null,
          (counter += 1),
        ],
      )
    )[0]?.id ?? "";
  const quest = async (
    event: string,
    group: string,
    options: { type?: string; config?: object; points?: number; cap?: number } = {},
  ) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, position, visible)
         VALUES ($1, $2, $3, 'Step', $4, $5, $6, $7, true) RETURNING id`,
        [
          event,
          group,
          options.type ?? "enter_code",
          options.points ?? 10,
          options.cap ?? 1,
          JSON.stringify(options.config ?? { code: "ABC" }),
          (counter += 1),
        ],
      )
    )[0]?.id ?? "";
  const member = async (event: string) => {
    const player = await f.newPlayer();
    return { player, enrollment: await f.join(event, player) };
  };
  const code = (player: string, target: string, key: string = randomUUID()) =>
    f.asPlayer<{ completion_id: string; score: string; replayed: boolean }>(
      player,
      "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
      [target, key],
    );
  const pause = (event: string, target: string, paused = true, seat = f.team()) =>
    f.run<{ r: { paused: boolean; changed: boolean } }>(
      seat,
      "SELECT set_quest_paused($1, $2, $3, $4) AS r",
      [event, target, paused, randomUUID()],
    );
  const skip = (event: string, target: string, skipped = true, seat = f.team()) =>
    f.run<{ r: { skipped: boolean; changed: boolean } }>(
      seat,
      "SELECT set_step_skipped($1, $2, $3, $4) AS r",
      [event, target, skipped, randomUUID()],
    );
  const audits = async (target: string) =>
    (
      await f.owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id",
        [target],
      )
    ).map((row) => row.action);
  const lockOf = async (player: string, event: string, target: string) =>
    (
      await f.asPlayer<{ quest_id: string; lock: string | null; paused: boolean }>(
        player,
        "SELECT quest_id, lock, paused FROM member_event_quests($1)",
        [event],
      )
    ).find((row) => row.quest_id === target);
  const staffAward = (event: string, enrollment: string, target: string) =>
    f.run(f.team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
      event,
      enrollment,
      target,
      randomUUID(),
      randomUUID(),
    ]);

  describe("pause", () => {
    it("refuses every kind of start with QN403 paused, and resume reopens", async () => {
      const event = await f.newEvent({ phase: "live" });
      const group = await category(event, "any");
      const typed = await quest(event, group);
      const sent = await quest(event, group, {
        type: "submission",
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      const quiz = await quest(event, group, { type: "quiz", config: QUIZ });
      const vote = await quest(event, group, { type: "vote", config: VOTE });
      const { player, enrollment } = await member(event);
      await f.owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
        [player],
      );
      for (const target of [typed, sent, quiz, vote]) await pause(event, target);
      expect(await refusal(code(player, typed))).toBe("QN403:paused");
      expect(await refusal(staffAward(event, enrollment, typed))).toBe("QN403:paused");
      expect(
        await refusal(
          f.asPlayer(player, "SELECT * FROM submit_quest($1, 'Hi', '1.0', $2)", [
            sent,
            randomUUID(),
          ]),
        ),
      ).toBe("QN403:paused");
      expect(await refusal(f.asPlayer(player, "SELECT quiz_start($1)", [quiz]))).toBe(
        "QN403:paused",
      );
      expect(
        await refusal(
          f.asPlayer(player, "SELECT * FROM vote_quest($1, $2, $3)", [vote, ["a"], randomUUID()]),
        ),
      ).toBe("QN403:paused");
      expect(await lockOf(player, event, typed)).toMatchObject({ paused: true });
      await pause(event, typed, false);
      expect(await lockOf(player, event, typed)).toMatchObject({ paused: false });
      expect((await code(player, typed))[0]).toMatchObject({ score: "10" });
    });

    it("lets work started before the pause finish and pay: an approval and a quiz", async () => {
      const event = await f.newEvent({ phase: "live" });
      const group = await category(event, "any");
      const sent = await quest(event, group, {
        type: "submission",
        points: 7,
        config: { accepts: ["text"], autoApprove: false, resubmit: false },
      });
      const quiz = await quest(event, group, { type: "quiz", config: QUIZ, points: 5 });
      const { player, enrollment } = await member(event);
      await f.owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
        [player],
      );
      const [made] = await f.asPlayer<{ submission_id: string }>(
        player,
        "SELECT * FROM submit_quest($1, 'Hi', '1.0', $2)",
        [sent, randomUUID()],
      );
      await f.asPlayer(player, "SELECT quiz_start($1)", [quiz]);
      await f.asPlayer(player, "SELECT quiz_next($1)", [quiz]);
      await pause(event, sent);
      await pause(event, quiz);
      await f.run(
        f.team(),
        "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
        [event, made?.submission_id, randomUUID(), randomUUID()],
      );
      await f.asPlayer(player, "SELECT quiz_answer($1, 'q1', 'r')", [quiz]);
      const [standing] = await f.owner<{ score: string }>(
        "SELECT score FROM enrollment WHERE id = $1",
        [enrollment],
      );
      expect(Number(standing?.score)).toBeGreaterThan(7);
    });

    it("replays a paid key while paused and writes nothing on the same state twice", async () => {
      const event = await f.newEvent({ phase: "live" });
      const group = await category(event, "any");
      const typed = await quest(event, group, { cap: 3 });
      const { player } = await member(event);
      const key = randomUUID();
      await code(player, typed, key);
      expect((await pause(event, typed))[0]?.r).toEqual({ paused: true, changed: true });
      expect((await pause(event, typed))[0]?.r).toEqual({ paused: true, changed: false });
      expect((await code(player, typed, key))[0]).toMatchObject({ replayed: true });
      expect(await refusal(code(player, typed))).toBe("QN403:paused");
      expect((await pause(event, typed, false))[0]?.r).toEqual({ paused: false, changed: true });
      expect((await pause(event, typed, false))[0]?.r).toEqual({ paused: false, changed: false });
      expect(await audits(typed)).toEqual(["quest.pause", "quest.resume"]);
    });

    it("lets a scan already in flight pay; the pause waits for it and the next scan is refused", async () => {
      const event = await f.newEvent({ phase: "live" });
      const group = await category(event, "any");
      const typed = await quest(event, group, { cap: 3 });
      const { player } = await member(event);
      const key = randomUUID();
      const raced = await f.crossed(
        {
          context: as(player),
          sql: "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
          values: [typed, key],
        },
        {
          context: f.team(),
          sql: "SELECT set_quest_paused($1, $2, true, $3) AS r",
          values: [event, typed, randomUUID()],
        },
      );
      expect(raced.waited).toBe(true);
      expect(raced.first).toMatchObject({ score: "10" });
      expect(raced.second).toMatchObject({ r: { paused: true, changed: true } });
      expect(await refusal(code(player, typed))).toBe("QN403:paused");
      expect((await code(player, typed, key))[0]).toMatchObject({ replayed: true });
    });

    it("refuses an ended event, a quest of another event, an editor of another event and a player", async () => {
      const event = await f.newEvent({ phase: "live" });
      const other = await f.newEvent({ phase: "live" });
      const group = await category(event, "any");
      const typed = await quest(event, group);
      expect(await refusal(pause(other, typed))).toBe("AQ404");
      const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [other]);
      expect(
        await refusal(pause(event, typed, true, { organizerId: f.ids.orgA, staffUserId: limited })),
      ).toBe("AN404");
      const { player } = await member(event);
      expect(
        await refusal(
          f.asPlayer(player, "SELECT set_quest_paused($1, $2, true, $3)", [
            event,
            typed,
            randomUUID(),
          ]),
        ),
      ).toBe("AN404");
      const ended = await f.newEvent({ phase: "ended" });
      const late = await quest(ended, await category(ended, "any"));
      expect(await refusal(pause(ended, late))).toBe("QE409:event_closed");
    });

    it("lets an editor pause, and the go-live wipe clears a rehearsal pause and skip", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      const group = await category(event);
      const first = await quest(event, group);
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      await pause(event, first, true, { organizerId: f.ids.orgA, staffUserId: editor });
      await skip(event, first);
      await f.owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, $3)",
        [event, f.ids.orgA, "QKRS-TWXY"],
      );
      await f.owner("SELECT wipe_rehearsal($1, 'go_live', NULL)", [event]);
      const [row] = await f.owner<{ paused_at: Date | null; skipped_at: Date | null }>(
        "SELECT paused_at, skipped_at FROM quest WHERE id = $1",
        [first],
      );
      expect(row).toEqual({ paused_at: null, skipped_at: null });
      expect(await audits(first)).toEqual(["quest.pause", "quest.skip"]);
    });
  });

  describe("skip", () => {
    it("frees the next in-order step, and restoring it holds the player again", async () => {
      const event = await f.newEvent({ phase: "live" });
      const chain = await category(event);
      const [first, second, third] = [
        await quest(event, chain),
        await quest(event, chain),
        await quest(event, chain),
      ];
      const { player } = await member(event);
      expect(await refusal(code(player, second))).toBe("QN403:order_locked");
      await skip(event, first);
      expect((await code(player, second))[0]).toMatchObject({ score: "10" });
      const [done] = await f.run<{ behind: number }>(
        f.team(),
        "SELECT behind FROM control_done($1) WHERE quest_id = $2",
        [event, first],
      );
      expect(done?.behind).toBe(1);
      await skip(event, first, false);
      expect((await lockOf(player, event, third))?.lock).toBe("order_locked");
      expect((await code(player, first))[0]).toMatchObject({ score: "20" });
      expect((await code(player, third))[0]).toMatchObject({ score: "30" });
    });

    it("pays the category bonus without the skipped step and opens a category unlocked after it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const chain = await category(event, "in_order", { bonus: 50 });
      const first = await quest(event, chain);
      const second = await quest(event, chain);
      const later = await category(event, "any", { after: chain });
      const next = await quest(event, later);
      const { player, enrollment } = await member(event);
      await code(player, first);
      expect(await refusal(code(player, next))).toBe("QN403:category_locked");
      await skip(event, second);
      expect((await code(player, next))[0]).toMatchObject({ score: "20" });
      const third = await quest(event, chain);
      await code(player, third);
      const bonus = await f.owner<{ score_delta: string }>(
        "SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'bonus'",
        [enrollment],
      );
      expect(bonus.map((row) => row.score_delta)).toEqual(["50"]);
    });

    it("refuses an any-order quest, a flash quest and a live poll with SP422", async () => {
      const event = await f.newEvent({ phase: "live" });
      const open = await quest(event, await category(event, "any"));
      const chain = await category(event);
      const flash = (
        await f.owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, flash, visible)
           VALUES ($1, $2, 'enter_code', 'Flash', 5, '{"code":"ABC"}', true, false) RETURNING id`,
          [event, chain],
        )
      )[0]?.id;
      const poll = await quest(event, chain, {
        type: "vote",
        config: { ...VOTE, live: { choices: "one", results: "after_vote", minutes: 5 } },
      });
      for (const target of [open, flash ?? "", poll]) {
        expect(await refusal(skip(event, target))).toBe("SP422:not_in_order");
      }
    });

    it("clears the skip when the quest moves, or its category switches to any order", async () => {
      const event = await f.newEvent({ phase: "live" });
      const chain = await category(event);
      const elsewhere = await category(event);
      const moved = await quest(event, chain);
      const stays = await quest(event, chain);
      await skip(event, moved);
      await skip(event, stays);
      await f.run(f.team(), "UPDATE quest SET category_id = $2 WHERE id = $1", [moved, elsewhere]);
      await f.run(f.team(), "UPDATE category SET order_mode = 'any' WHERE id = $1", [chain]);
      const rows = await f.owner<{ skipped_at: Date | null }>(
        "SELECT skipped_at FROM quest WHERE id = ANY ($1)",
        [[moved, stays]],
      );
      expect(rows.map((row) => row.skipped_at)).toEqual([null, null]);
    });
  });
});
