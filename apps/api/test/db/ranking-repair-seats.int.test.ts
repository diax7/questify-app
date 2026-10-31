import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

const GUIDELINES = "1.0";
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
