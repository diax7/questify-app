import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";

const GUIDELINES = "1.0";
/** A gate needs no setup, and its refusal changes nothing to check. */
const nothing = async () => async () => undefined;
const SUBMISSION_CONFIG = JSON.stringify({
  accepts: ["text"],
  autoApprove: false,
  resubmit: false,
});

/**
 * The repair mark for the seats that move points by hand (migration 0095): `mark_ranking_repair` marks for the system,
 * an enrolled player, the event's organizer seat (inside the member's event limit) and the event's operators, and for
 * nobody else. The doors that run as a team member or an operator (a manual award, a submission review) leave the
 * mark, so a rehearsal board and an ended event's board are rebuilt too.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "the repair mark for team seats (database)",
  () => {
    let f: PushFixture;
    let live: string;
    let ownerB: string;
    beforeAll(async () => {
      f = await pushFixture();
      live = await f.newEvent({ phase: "live" });
      ownerB = await addMember(f.db.owner, f.ids.orgB, "owner");
    });
    afterAll(async () => {
      await f.close();
    });

    const marked = async (event: string) =>
      (await f.count("ranking_repair WHERE event_id = $1", [event])) === 1;
    const clear = (event: string) =>
      f.owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
    const mark = (context: RequestContext, event: string) =>
      f.run(context, "SELECT mark_ranking_repair($1)", [event]);
    /** Whether a call by `context` leaves the event marked. */
    const marksFor = async (context: RequestContext, event: string) => {
      await clear(event);
      await mark(context, event);
      return marked(event);
    };
    const operator = async (event: string, abilities: string[]) => {
      const who = await f.newPlayer();
      await f.owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1`,
        [event, who, abilities],
      );
      return who;
    };
    const award = (context: RequestContext, event: string, enrollment: string, staff: boolean) =>
      staff
        ? f.run(context, "SELECT * FROM staff_award($1, $2, NULL, 5, 'Helped', $3, $4)", [
            event,
            enrollment,
            randomUUID(),
            randomUUID(),
          ])
        : f.run(context, "SELECT * FROM operator_award($1, $2, NULL, 5, 'Helped', $3)", [
            event,
            enrollment,
            randomUUID(),
          ]);
    const submit = async (event: string, via: string | null) => {
      const player = await f.newPlayer();
      await f.owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'community_guidelines', $2, 'submission')`,
        [player, GUIDELINES],
      );
      await f.join(event, player, via);
      const [quest] = await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       SELECT $1, id, 'submission', 'Tell us', 20, 1, $2 FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
        [event, SUBMISSION_CONFIG],
      );
      const [sent] = await f.run<{ submission_id: string }>(
        { playerId: player },
        "SELECT * FROM submit_quest($1, 'My answer', $2, $3)",
        [quest?.id, GUIDELINES, randomUUID()],
      );
      return sent?.submission_id ?? "";
    };
    const endEvent = (event: string) =>
      f.owner(
        `UPDATE event SET status = 'ended', starts_at = now() - interval '2 days',
                        ends_at = now() - interval '1 day' WHERE id = $1`,
        [event],
      );

    describe("who may mark an event", () => {
      it("lets the organizer seat mark it, inside the member's event limit", async () => {
        const other = await f.newEvent({ phase: "live" });
        const limitedOut = await addMember(f.db.owner, f.ids.orgA, "editor", [other]);
        const limitedIn = await addMember(f.db.owner, f.ids.orgA, "editor", [live]);
        expect(await marksFor(f.team(), live)).toBe(true);
        expect(await marksFor(f.team(limitedIn), live)).toBe(true);
        expect(await marksFor(f.team(limitedOut), live)).toBe(false);
      });

      it("lets an operator of the event mark it, and no operator of another event", async () => {
        const here = await operator(live, ["award"]);
        const elsewhere = await operator(await f.newEvent({ phase: "live" }), ["award"]);
        expect(await marksFor({ playerId: here }, live)).toBe(true);
        expect(await marksFor({ playerId: elsewhere }, live)).toBe(false);
      });

      it("marks nothing for another organizer's team, a forged seat, or a player of another event", async () => {
        const stranger = await f.newPlayer();
        await f.join(await f.newEvent({ phase: "live" }), stranger);
        const teamOfB: RequestContext = { organizerId: f.ids.orgB, staffUserId: ownerB };
        const forged: RequestContext = { organizerId: f.ids.orgA, staffUserId: ownerB };
        expect(await marksFor(teamOfB, live)).toBe(false);
        expect(await marksFor(forged, live)).toBe(false);
        expect(await marksFor({ playerId: stranger }, live)).toBe(false);
        expect(await marksFor({ playerId: await f.newPlayer() }, live)).toBe(false);
      });
    });

    /** A kiosk paired to `event` (a device seat of its organizer). */
    const pairKiosk = async (event: string) => {
      const [kiosk] = await f.owner<{ id: string }>(
        `WITH q AS (
           INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
           SELECT $1, id, 'enter_code', 'Kiosk', 10, '{"code": "ABC"}' FROM category WHERE event_id = $1 LIMIT 1
           RETURNING id, event_id
         )
         INSERT INTO paired_device (organizer_id, event_id, kind, quest_id, label, secret_hash, paired_by_staff,
                                    activated_at)
         SELECT e.organizer_id, e.id, 'kiosk', q.id, 'Hall', $2, $3, now() FROM q JOIN event e ON e.id = q.event_id
         RETURNING paired_device.id`,
        [event, randomBytes(32), f.team().staffUserId],
      );
      return kiosk?.id ?? "";
    };

    describe("a device seat (migration 0190)", () => {
      it("marks nothing for a paired kiosk or an unknown device, and the empty context still marks", async () => {
        const kiosk = await pairKiosk(live);
        expect(await marksFor({ deviceId: kiosk }, live)).toBe(false);
        expect(await marksFor({ deviceId: randomUUID() }, live)).toBe(false);
        expect(await marksFor({}, live)).toBe(true);
      });
    });

    // The system gates' table below (migration 0191).
    type Gate = Readonly<{
      /** Makes the empty context's answer differ from the refusal; returns a check that a refusal changed nothing. */
      prepare: () => Promise<() => Promise<void>>;
      call: (context: RequestContext) => Promise<unknown>;
      refused: unknown;
    }>;
    const rows =
      (sql: string, values: () => Promise<unknown[]> = async () => [live]) =>
      async (context: RequestContext) =>
        f.run(context, sql, await values());
    const value = (sql: string) => async (context: RequestContext) =>
      (await f.run<{ v: unknown }>(context, sql))[0]?.v;
    const code = (sql: string) => (context: RequestContext) => sqlstate(f.run(context, sql));

    const played = async () => {
      await f.play(live, await f.newPlayer());
      return async () => undefined;
    };
    const today = async () =>
      (
        await f.owner<{ day: string }>(
          "SELECT event_day(now(), e)::text AS day FROM event e WHERE e.id = $1",
          [live],
        )
      )[0]?.day;
    const newQuest = async (type: string, config: string, closesAt: string | null) =>
      (
        await f.owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, closes_at)
           SELECT $1, id, $2, 'Gate', 10, $3, now() + $4::interval
           FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
          [live, type, config, closesAt],
        )
      )[0]?.id;
    const stillOpen = (table: string, id: string | undefined) => async () => {
      expect(await f.count(`${table} WHERE id = $1 AND status = 'open'`, [id])).toBe(1);
    };

    /**
     * Migration 0191: `ranking_system()` itself refuses a device seat, so every gate that asks it (0015, 0035, 0050,
     * 0053, 0098, 0144) answers a paired kiosk and a forged device id as it answers any other seat, and the system's
     * empty context still passes. Each gate is set up so that the empty context's answer differs from the refusal.
     */
    describe("a device seat at the system gates (migration 0191)", () => {
      const gates: ReadonlyArray<readonly [string, Gate]> = [
        [
          "claim_ranking_repairs (0015)",
          {
            prepare: async () => {
              await f.owner(
                "INSERT INTO ranking_repair (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING",
                [live],
              );
              return async () => expect(await marked(live)).toBe(true);
            },
            call: rows("SELECT claim_ranking_repairs(100) AS v", async () => []),
            refused: [],
          },
        ],
        [
          "live_ranking_events (0015)",
          {
            prepare: nothing,
            call: rows("SELECT live_ranking_events() AS v", async () => []),
            refused: [],
          },
        ],
        [
          "ranking_entries (0015)",
          { prepare: played, call: rows("SELECT * FROM ranking_entries($1)"), refused: [] },
        ],
        [
          "ranking_today (0035)",
          { prepare: nothing, call: rows("SELECT * FROM ranking_today($1)"), refused: [] },
        ],
        [
          "ranking_day_entries (0035)",
          {
            prepare: played,
            call: rows("SELECT * FROM ranking_day_entries($1, $2::date)", async () => [
              live,
              await today(),
            ]),
            refused: [],
          },
        ],
        [
          "finish_one_due_quiz (0098)",
          {
            prepare: async () => {
              const enrollment = await f.join(live, await f.newPlayer());
              const quest = await newQuest("scan_qr", "{}", "1 minute");
              const [attempt] = await f.owner<{ id: string }>(
                `INSERT INTO quiz_attempt (organizer_id, event_id, enrollment_id, quest_id, points_each,
                                           question_count)
                 SELECT organizer_id, id, $2, $3, 5, 1 FROM event WHERE id = $1 RETURNING id`,
                [live, enrollment, quest],
              );
              // Due: its quest has closed.
              await f.owner(
                "UPDATE quest SET closes_at = now() - interval '1 second' WHERE id = $1",
                [quest],
              );
              return stillOpen("quiz_attempt", attempt?.id);
            },
            call: value("SELECT finish_one_due_quiz() AS v"),
            refused: null,
          },
        ],
        [
          "close_one_due_round (0050)",
          {
            prepare: async () => {
              const enrollment = await f.join(live, await f.newPlayer());
              const quest = await newQuest(
                "game",
                JSON.stringify({
                  game: "memory_match",
                  level: "easy",
                  attempts: 1,
                  cooldownMinutes: null,
                }),
                null,
              );
              const [round] = await f.owner<{ id: string }>(
                `INSERT INTO game_round (organizer_id, event_id, enrollment_id, quest_id, game, level, seed, params,
                                         points, issue_key, engine_version, issued_at, deadline_at)
                 SELECT organizer_id, id, $2, $3, 'memory_match', 'easy', 1, '{}', 10, 'gate', 1,
                        now() - interval '20 minutes', now() - interval '1 second'
                 FROM event WHERE id = $1 RETURNING id`,
                [live, enrollment, quest],
              );
              return stillOpen("game_round", round?.id);
            },
            call: value("SELECT close_one_due_round() AS v"),
            refused: null,
          },
        ],
        [
          "community_system_only, through community_tick_goals (0053)",
          { prepare: nothing, call: code("SELECT community_tick_goals()"), refused: "CS403" },
        ],
        [
          "community_system_only, through community_health (0053)",
          { prepare: nothing, call: code("SELECT community_health()"), refused: "CS403" },
        ],
        [
          "review_demo_tick (0144)",
          { prepare: nothing, call: code("SELECT review_demo_tick()"), refused: "RD403" },
        ],
      ];

      it.each(gates)(
        "%s refuses a paired kiosk and a forged device, and passes the empty context",
        async (_name, gate) => {
          const kiosk = await pairKiosk(live);
          const unchanged = await gate.prepare();
          for (const deviceId of [kiosk, randomUUID()]) {
            expect(await gate.call({ deviceId }), deviceId).toEqual(gate.refused);
            await unchanged();
          }
          expect(await gate.call({})).not.toEqual(gate.refused);
        },
      );
    });

    describe("a manual award", () => {
      const cases = [
        ["a live board", "live", null],
        ["a rehearsal board", "scheduled", "rehearsal"],
      ] as const;

      it.each(cases)("by the team marks %s", async (_name, phase, via) => {
        const event = await f.newEvent({ phase });
        const enrollment = await f.join(event, await f.newPlayer(), via);
        await clear(event);
        await award(f.team(), event, enrollment, true);
        expect(await marked(event)).toBe(true);
      });

      it.each(cases)("by an operator marks %s", async (_name, phase, via) => {
        const event = await f.newEvent({ phase });
        const enrollment = await f.join(event, await f.newPlayer(), via);
        const who = await operator(event, ["award"]);
        await clear(event);
        await award({ playerId: who }, event, enrollment, false);
        expect(await marked(event)).toBe(true);
      });
    });

    describe("a submission review", () => {
      const cases = [
        ["a live board", "live", null, false],
        ["a rehearsal board", "scheduled", "rehearsal", false],
        ["an ended event's board", "live", null, true],
      ] as const;

      it.each(cases)("approved by the team marks %s", async (_name, phase, via, ended) => {
        const event = await f.newEvent({ phase });
        const submission = await submit(event, via);
        if (ended) await endEvent(event);
        await clear(event);
        await f.run(
          f.team(),
          "SELECT * FROM staff_review_submission($1, $2, 'approve', NULL, $3, $4)",
          [event, submission, randomUUID(), randomUUID()],
        );
        expect(await marked(event)).toBe(true);
      });

      it.each(cases)("approved by a reviewer marks %s", async (_name, phase, via, ended) => {
        const event = await f.newEvent({ phase });
        const submission = await submit(event, via);
        if (ended) await endEvent(event);
        const who = await operator(event, ["review"]);
        await clear(event);
        await f.run(
          { playerId: who },
          "SELECT * FROM operator_review_submission($1, $2, 'approve', NULL, $3)",
          [event, submission, randomUUID()],
        );
        expect(await marked(event)).toBe(true);
      });
    });
  },
);
