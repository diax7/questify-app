import { randomUUID } from "node:crypto";
import { REF_VALUE } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushMessageOf, type ClaimedSend } from "#src/push/message";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type NoticeRow = {
  kind: string;
  event_id: string | null;
  refs: Record<string, unknown>;
  params: Record<string, unknown>;
  dedupe: string;
  expires_at: Date;
};

const MINUTE = 60_000;

/**
 * The owed personal pushes in the database (T-501d, migration 0077; plan docs/plans/2026-10-28-t-501d-personal-pushes.md):
 * each producer writes one notice through notice_create, once and only once, to the right player and no one else; a
 * broken kind never rolls a door back; the due scans; the text is the fixed template and the payload ids only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("personal pushes (database)", () => {
  let f: PushFixture;
  let admin = "";
  beforeAll(async () => {
    f = await pushFixture();
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('push-desk@questify.test', 'h', 'admin')
       RETURNING id`,
    );
    admin = made?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const adminSeat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  const noticesOf = (player: string) =>
    f.owner<NoticeRow>(
      `SELECT kind, event_id, refs, params, dedupe, expires_at FROM notice WHERE player_id = $1 ORDER BY id`,
      [player],
    );
  const kindsOf = async (player: string) => (await noticesOf(player)).map((row) => row.kind);
  const centerOf = async (player: string) =>
    (
      await f.owner<{ kind: string }>(
        `SELECT nt.kind FROM notification c JOIN notice nt ON nt.id = c.notice_id WHERE c.player_id = $1 ORDER BY c.id`,
        [player],
      )
    ).map((row) => row.kind);

  const withoutKind = <T>(kind: string, work: () => Promise<T>) => f.withoutKind(kind, work);

  // ------------------------------------------------------------------ join decisions
  const request = async (
    event: string,
    options: Readonly<{ via?: string; waitlisted?: boolean }> = {},
  ) => {
    const who = await f.playerWithPhone();
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, status, joined_via, waitlisted)
       SELECT organizer_id, id, $2, 'pending', $3, $4 FROM event WHERE id = $1 RETURNING id`,
      [event, who.who, options.via ?? "code", options.waitlisted ?? false],
    );
    return { ...who, enrollment: row?.id ?? "" };
  };
  const decide = async (event: string, enrollment: string, accept: boolean) =>
    (
      await f.run<{ outcome: string }>(
        f.team(),
        "SELECT decide_join_request($1, $2, $3, $4) AS outcome",
        [event, enrollment, accept, randomUUID()],
      )
    )[0]?.outcome;
  const acceptAll = async (event: string) =>
    (
      await f.run<{ outcome: string; accepted: number; remaining: number }>(
        f.team(),
        "SELECT * FROM accept_all_join_requests($1, $2)",
        [event, randomUUID()],
      )
    )[0];

  /** `n` pending requests on the event, written straight in. */
  const pendingRequests = (event: string, n: number) =>
    f.owner(
      `WITH p AS (INSERT INTO player (username) SELECT 'cap_' || $2 || '_' || g FROM generate_series(1, $3) g
                  RETURNING id)
       INSERT INTO enrollment (organizer_id, event_id, player_id, status) SELECT e.organizer_id, e.id, p.id, 'pending'
       FROM p CROSS JOIN event e WHERE e.id = $1`,
      [event, randomUUID().slice(0, 8), n],
    );

  describe("the join decision (FR-1819)", () => {
    it("accept, decline, a waiting-list release and a later accept: one notice per decision, none on a retry", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      const accepted = await request(event);
      const turned = await request(event);
      const listed = await request(event, { waitlisted: true });
      expect(await decide(event, accepted.enrollment, true)).toBe("accepted");
      expect(await decide(event, accepted.enrollment, true)).toBe("unchanged");
      expect(await decide(event, turned.enrollment, false)).toBe("declined");
      expect(await decide(event, listed.enrollment, true)).toBe("accepted");
      expect(await kindsOf(accepted.who)).toEqual(["join_accepted"]);
      expect(await kindsOf(listed.who)).toEqual(["join_accepted"]);
      expect(await decide(event, turned.enrollment, true)).toBe("accepted");
      expect(await kindsOf(turned.who)).toEqual(["join_declined", "join_accepted"]);
      const [notice] = await noticesOf(accepted.who);
      expect(notice).toMatchObject({ event_id: event, refs: {} });
      expect(notice?.params).toEqual({
        event: { ar: "فعالية", en: expect.stringMatching(/^Event \d+$/) },
      });
      expect(notice?.expires_at.getTime()).toBeLessThanOrEqual(
        Date.now() + 24 * 60 * MINUTE + MINUTE,
      );
      await f.fanOut();
      expect(await centerOf(accepted.who)).toEqual(["join_accepted"]);
      expect(await centerOf(turned.who)).toEqual(["join_declined", "join_accepted"]);
    });

    it("accept-all: one notice for each of 300 requests, and none for a rehearsal account", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      const tag = randomUUID().slice(0, 8);
      await f.owner(
        `WITH p AS (INSERT INTO player (username) SELECT 'aa_' || $2 || '_' || g FROM generate_series(1, 300) g
                    RETURNING id)
         INSERT INTO enrollment (organizer_id, event_id, player_id, status) SELECT e.organizer_id, e.id, p.id, 'pending'
         FROM p CROSS JOIN event e WHERE e.id = $1`,
        [event, tag],
      );
      const rehearsing = await request(event, { via: "rehearsal" });
      expect(await acceptAll(event)).toMatchObject({ outcome: "done", accepted: 300 });
      expect(await f.count("notice WHERE event_id = $1 AND kind = 'join_accepted'", [event])).toBe(
        300,
      );
      await f.owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [
        rehearsing.enrollment,
      ]);
      expect(await kindsOf(rehearsing.who)).toEqual([]);
    });

    it("made an operator (pending → active, operator) gives none; neither does the player's own invited re-join", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      const operator = await request(event);
      await f.owner(
        "UPDATE enrollment SET status = 'active', joined_via = 'operator' WHERE id = $1",
        [operator.enrollment],
      );
      expect(await kindsOf(operator.who)).toEqual([]);
      const returning = await request(event);
      expect(await decide(event, returning.enrollment, false)).toBe("declined");
      await f.owner(
        `INSERT INTO event_guest (organizer_id, event_id, kind, value)
         SELECT e.organizer_id, e.id, 'email', c.email FROM event e, player_contact c WHERE e.id = $1 AND c.player_id = $2`,
        [event, returning.who],
      );
      const [code] = await f.owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      const [joined] = await f.run<{ outcome: string; status: string }>(
        { playerId: returning.who },
        "SELECT * FROM join_event($1, 'code', '0.2', '{}'::jsonb, false)",
        [code?.join_code],
      );
      expect(joined).toMatchObject({ outcome: "joined", status: "active" });
      expect(await kindsOf(returning.who)).toEqual(["join_declined"]);
    });

    it("never reaches a player who left after the decision or was erased", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      const left = await request(event);
      const erased = await request(event);
      await decide(event, left.enrollment, true);
      await decide(event, erased.enrollment, true);
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
      expect(await f.erase(erased.who)).toBe("erased");
      expect(await kindsOf(erased.who)).toEqual([]);
      await f.fanOut();
      expect(await centerOf(left.who)).toEqual([]);
      expect(await centerOf(erased.who)).toEqual([]);
    });

    it("an acceptance before the start (a scheduled private event) gives the notice and its center row", async () => {
      const event = await f.newEvent({ phase: "scheduled", access: "private" });
      const early = await request(event);
      expect(await decide(event, early.enrollment, true)).toBe("accepted");
      expect(await kindsOf(early.who)).toEqual(["join_accepted"]);
      await f.fanOut();
      expect(await centerOf(early.who)).toEqual(["join_accepted"]);
      expect((await f.sends()).filter((row) => row.device_id === early.deviceId)).toHaveLength(1);
    });

    it("accept-all takes at most 1,000 a call: 1,001 requests give (1000, 1), then (1, 0), one notice each", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      await pendingRequests(event, 1001);
      expect(await acceptAll(event)).toEqual({ outcome: "done", accepted: 1000, remaining: 1 });
      expect(await acceptAll(event)).toEqual({ outcome: "done", accepted: 1, remaining: 0 });
      expect(await f.count("notice WHERE event_id = $1 AND kind = 'join_accepted'", [event])).toBe(
        1001,
      );
    });

    it("accept-all takes at most 250 a call on a hard-limited event: 300 requests give (250, 50), then (50, 0)", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      await f.owner(
        "UPDATE event SET player_limit_mode = 'hard', player_limit = 1000 WHERE id = $1",
        [event],
      );
      await pendingRequests(event, 300);
      expect(await acceptAll(event)).toEqual({ outcome: "done", accepted: 250, remaining: 50 });
      expect(await acceptAll(event)).toEqual({ outcome: "done", accepted: 50, remaining: 0 });
      expect(await f.count("enrollment WHERE event_id = $1 AND status = 'active'", [event])).toBe(
        300,
      );
    });

    it("a broken kind cannot roll back the door: decide and accept-all commit with no notice", async () => {
      const event = await f.newEvent({ phase: "live", access: "private" });
      const one = await request(event);
      const two = await request(event);
      await withoutKind("join_accepted", async () => {
        expect(await decide(event, one.enrollment, true)).toBe("accepted");
        expect(await acceptAll(event)).toMatchObject({ outcome: "done", accepted: 1 });
      });
      expect(
        await f.count("enrollment WHERE id = ANY($1) AND status = 'active'", [
          [one.enrollment, two.enrollment],
        ]),
      ).toBe(2);
      expect(await kindsOf(one.who)).toEqual([]);
      expect(await kindsOf(two.who)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ help-desk answers
  const member = async (event: string) => {
    const who = await f.playerWithPhone();
    return { ...who, enrollment: await f.join(event, who.who) };
  };
  const ticket = async (event: string, player: string, enrollment: string) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
         SELECT $2, organizer_id, id, $3, 'question', 'My secret question', $4 FROM event WHERE id = $1 RETURNING id`,
        [event, player, enrollment, randomUUID()],
      )
    )[0]?.id ?? "";
  const staffAnswer = (event: string, id: string, reply: string | null, key = randomUUID()) =>
    f.run<{ outcome: string; replayed: boolean }>(
      f.team(),
      "SELECT * FROM staff_answer_ticket($1, $2, $3, $4, $5)",
      [event, id, reply, key, randomUUID()],
    );

  describe("the help-desk answer (FR-1101)", () => {
    it("one notice per closed ticket, by team and outcome; none on escalation, send-back or a replay", async () => {
      const event = await f.newEvent({ phase: "live" });
      const asker = await member(event);
      const answered = await ticket(event, asker.who, asker.enrollment);
      const key = randomUUID();
      await staffAnswer(event, answered, "Secret reply", key);
      expect((await staffAnswer(event, answered, "Secret reply", key))[0]?.replayed).toBe(true);
      const solved = await ticket(event, asker.who, asker.enrollment);
      const operator = await f.newPlayer();
      await f.owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) SELECT organizer_id, id, $2, '{help_desk}' FROM event WHERE id = $1",
        [event, operator],
      );
      await f.run(
        { playerId: operator },
        "SELECT * FROM operator_answer_ticket($1, $2, NULL, $3)",
        [event, solved, randomUUID()],
      );
      const escalated = await ticket(event, asker.who, asker.enrollment);
      await f.run(f.team(), "SELECT * FROM staff_escalate_ticket($1, $2, 'Please help', $3)", [
        event,
        escalated,
        randomUUID(),
      ]);
      await f.run(adminSeat(), "SELECT * FROM admin_return_ticket($1, 'Yours', $2)", [
        escalated,
        randomUUID(),
      ]);
      expect(await kindsOf(asker.who)).toEqual(["help_answered", "help_solved"]);
      await f.run(f.team(), "SELECT * FROM staff_escalate_ticket($1, $2, 'Again', $3)", [
        event,
        escalated,
        randomUUID(),
      ]);
      await f.run(adminSeat(), "SELECT * FROM admin_answer_ticket($1, 'Fixed', $2, $3)", [
        escalated,
        randomUUID(),
        randomUUID(),
      ]);
      const notices = await noticesOf(asker.who);
      expect(notices.map((row) => row.kind)).toEqual([
        "help_answered",
        "help_solved",
        "help_answered_questify",
      ]);
      expect(notices.map((row) => row.dedupe)).toEqual(
        [answered, solved, escalated].map((id) => `ticket:${id}`),
      );
      for (const row of notices) {
        expect(row.refs).toEqual({ ticket: Number(row.dedupe.split(":")[1]) });
        expect(Object.keys(row.params)).toEqual(["event"]);
        expect(JSON.stringify(row.params)).not.toMatch(/secret|Fixed|Please help/i);
      }
    });

    it("answers a request outside an event as Questify, and reaches a member who left (their own request)", async () => {
      const outside = await f.playerWithPhone();
      const [platform] = await f.owner<{ id: string }>(
        `INSERT INTO ticket (player_id, kind, queue, body, idempotency_key, app_version, platform, os_version)
         VALUES ($1, 'app_problem', 'questify', 'The map is blank', $2, '1.4.0', 'ios', '18.1') RETURNING id`,
        [outside.who, randomUUID()],
      );
      await f.run(adminSeat(), "SELECT * FROM admin_answer_ticket($1, NULL, $2, $3)", [
        platform?.id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await noticesOf(outside.who)).toMatchObject([
        { kind: "help_solved", event_id: null, params: {} },
      ]);
      const event = await f.newEvent({ phase: "live" });
      const left = await member(event);
      const asked = await ticket(event, left.who, left.enrollment);
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
      await staffAnswer(event, asked, "Reply");
      await f.fanOut();
      expect(await centerOf(outside.who)).toEqual(["help_solved"]);
      expect(await centerOf(left.who)).toEqual(["help_answered"]);
    });

    it("never reaches an erased or a banned account", async () => {
      const event = await f.newEvent({ phase: "live" });
      const erased = await member(event);
      const banned = await member(event);
      await staffAnswer(event, await ticket(event, erased.who, erased.enrollment), "Reply");
      await staffAnswer(event, await ticket(event, banned.who, banned.enrollment), "Reply");
      expect(await f.erase(erased.who)).toBe("erased");
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned.who]);
      await f.fanOut();
      expect(await kindsOf(erased.who)).toEqual([]);
      expect(await centerOf(erased.who)).toEqual([]);
      expect(await centerOf(banned.who)).toEqual([]);
    });

    it("a broken kind cannot roll back the answer", async () => {
      const event = await f.newEvent({ phase: "live" });
      const asker = await member(event);
      const id = await ticket(event, asker.who, asker.enrollment);
      await withoutKind("help_answered", async () => {
        expect((await staffAnswer(event, id, "Reply"))[0]).toMatchObject({ outcome: "answered" });
      });
      expect(await f.count("ticket WHERE id = $1 AND status = 'closed'", [id])).toBe(1);
      expect(await kindsOf(asker.who)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ the prize at the reveal
  const prize = (event: string, rank: number, name: string) =>
    f.owner(
      `INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en, name_ar) VALUES ($1, $2, $2, 'item', $3, 'كأس')`,
      [event, rank, name],
    );
  const podium = async () => {
    const event = await f.newEvent();
    const places = [];
    for (const quests of [4, 3, 2, 1]) {
      const who = await f.playerWithPhone();
      places.push({ ...who, enrollment: await f.play(event, who.who, quests) });
    }
    await prize(event, 1, "Gold");
    await prize(event, 2, "Silver");
    await prize(event, 3, "Bronze");
    expect(await f.confirm(event)).toBe("confirmed");
    return { event, places };
  };

  describe("the prize at the reveal (FR-1718)", () => {
    it("one notice per prize place naming the prize and the deadline; none to a winner who left or was removed", async () => {
      const { event, places } = await podium();
      const [first, second, third, fourth] = places;
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [second?.enrollment]);
      await f.owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [third?.enrollment]);
      expect(await f.reveal(event)).toBe("revealed");
      expect(await f.reveal(event)).toBe("replayed");
      const [result] = await f.owner<{ claim_until: Date; redemption_id: string }>(
        `SELECT r.claim_until, x.redemption_id FROM event_result r JOIN result_place x ON x.event_id = r.event_id
         WHERE r.event_id = $1 AND x.rank = 1`,
        [event],
      );
      const notices = await noticesOf(first?.who ?? "");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        kind: "rank_prize",
        dedupe: `rank_prize:${event}:1`,
        refs: { redemption: result?.redemption_id },
      });
      expect(notices[0]?.params["reward"]).toEqual({ ar: "كأس", en: "Gold" });
      expect(new Date(String(notices[0]?.params["date"])).getTime()).toBe(
        result?.claim_until.getTime(),
      );
      expect(notices[0]?.params["time"]).toEqual(notices[0]?.params["date"]);
      expect(notices[0]?.expires_at.getTime()).toBeLessThanOrEqual(
        result?.claim_until.getTime() ?? 0,
      );
      for (const other of [second, third, fourth])
        expect(await kindsOf(other?.who ?? "")).toEqual([]);
      await f.fanOut();
      expect(await centerOf(first?.who ?? "")).toEqual(["rank_prize"]);
    });

    it("a broken kind cannot roll back the reveal", async () => {
      const { event, places } = await podium();
      await withoutKind("rank_prize", async () => {
        expect(await f.reveal(event)).toBe("revealed");
      });
      expect(
        await f.count("result_place WHERE event_id = $1 AND redemption_id IS NOT NULL", [event]),
      ).toBe(3);
      for (const place of places) expect(await kindsOf(place.who)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ the submission decision
  const submissionQuest = async (event: string, autoApprove = false) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, repeat_cap, type_config)
         SELECT $1, c.id, 'submission', 'Tell us', 'أخبرنا', 7919, 1, $2::jsonb FROM category c WHERE c.event_id = $1 LIMIT 1
         RETURNING id`,
        [event, JSON.stringify({ accepts: ["text"], autoApprove, resubmit: false })],
      )
    )[0]?.id ?? "";
  const submitter = async (event: string) => {
    const who = await member(event);
    await f.owner(
      `INSERT INTO player_acceptance (player_id, document, version, method) VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
      [who.who],
    );
    return who;
  };
  const submit = async (player: string, quest: string) =>
    (
      await f.run<{ submission_id: string; status: string }>(
        { playerId: player },
        "SELECT * FROM submit_quest($1, 'My private answer', '1.0', $2)",
        [quest, randomUUID()],
      )
    )[0];
  const review = (
    event: string,
    id: string,
    decision: string,
    reason: string | null,
    key = randomUUID(),
  ) =>
    f.run<{ status: string; replayed: boolean }>(
      f.team(),
      "SELECT * FROM staff_review_submission($1, $2, $3, $4, $5, $6)",
      [event, id, decision, reason, key, randomUUID()],
    );

  describe("the submission decision (FR-1101)", () => {
    it("a reviewer's approval and rejection, once each, naming the quest and never the reason", async () => {
      const event = await f.newEvent({ phase: "live" });
      const quest = await submissionQuest(event);
      const approved = await submitter(event);
      const rejected = await submitter(event);
      const one = await submit(approved.who, quest);
      const two = await submit(rejected.who, quest);
      const key = randomUUID();
      await review(event, one?.submission_id ?? "", "approve", null, key);
      expect(
        (await review(event, one?.submission_id ?? "", "approve", null, key))[0]?.replayed,
      ).toBe(true);
      const operator = await f.newPlayer();
      await f.owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) SELECT organizer_id, id, $2, '{review}' FROM event WHERE id = $1",
        [event, operator],
      );
      await f.run(
        { playerId: operator },
        "SELECT * FROM operator_review_submission($1, $2, 'reject', 'Too short reason', $3)",
        [event, two?.submission_id, randomUUID()],
      );
      const [yes] = await noticesOf(approved.who);
      const [no] = await noticesOf(rejected.who);
      expect(await kindsOf(approved.who)).toEqual(["submission_approved"]);
      expect(await kindsOf(rejected.who)).toEqual(["submission_rejected"]);
      expect(yes).toMatchObject({
        refs: { quest, submission: Number(one?.submission_id) },
        dedupe: `submission:${one?.submission_id}:approved`,
      });
      expect(no?.refs).toEqual({ quest, submission: Number(two?.submission_id) });
      expect(no?.dedupe).toBe(`submission:${two?.submission_id}:rejected`);
      expect(no?.params).toMatchObject({ quest: { ar: "أخبرنا", en: "Tell us" } });
      expect(Object.keys(no?.params ?? {}).toSorted()).toEqual(["event", "quest"]);
      expect(JSON.stringify(no?.params)).not.toMatch(/7919|Too short|private answer/);
      await f.fanOut();
      expect(await centerOf(rejected.who)).toEqual(["submission_rejected"]);
    });

    it("gives none for an auto-approval, the system's rejection on leaving, or a removal", async () => {
      const event = await f.newEvent({ phase: "live" });
      const auto = await submitter(event);
      expect((await submit(auto.who, await submissionQuest(event, true)))?.status).toBe("approved");
      const leaving = await submitter(event);
      const quest = await submissionQuest(event);
      await submit(leaving.who, quest);
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [leaving.enrollment]);
      expect(
        await f.count("submission WHERE enrollment_id = $1 AND status = 'rejected'", [
          leaving.enrollment,
        ]),
      ).toBe(1);
      const removed = await submitter(event);
      const sent = await submit(removed.who, quest);
      await review(event, sent?.submission_id ?? "", "approve", null);
      await f.run(f.team(), "SELECT * FROM remove_submission($1, $2, 'Copied', $3, $4)", [
        event,
        sent?.submission_id,
        randomUUID(),
        randomUUID(),
      ]);
      expect(await kindsOf(auto.who)).toEqual([]);
      expect(await kindsOf(leaving.who)).toEqual([]);
      expect(await kindsOf(removed.who)).toEqual(["submission_approved"]);
    });

    it("a broken kind cannot roll back the review", async () => {
      const event = await f.newEvent({ phase: "live" });
      const who = await submitter(event);
      const sent = await submit(who.who, await submissionQuest(event));
      await withoutKind("submission_rejected", async () => {
        expect((await review(event, sent?.submission_id ?? "", "reject", "No"))[0]?.status).toBe(
          "rejected",
        );
      });
      expect(await kindsOf(who.who)).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ reservations: the due scans
  const due = () =>
    f.one<{ ready: number; ending: number; more: boolean }>(f.system, "SELECT push_due() AS r");
  const deskEvent = async (hours: string | null) => {
    const event = await f.newEvent({ phase: "live" });
    await f.owner(`UPDATE event SET desk_hours = ${hours ?? "NULL"} WHERE id = $1`, [event]);
    const [reward] = await f.owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, name_ar, price, stock_total) VALUES ($1, 'item', 'Cap', 'قبعة', 5, 99) RETURNING id",
      [event],
    );
    return { event, reward: reward?.id ?? "" };
  };
  const hold = async (
    desk: Readonly<{ event: string; reward: string }>,
    made: string,
    until: string,
    options: Readonly<{ via?: string | null; collecting?: boolean }> = {},
  ) => {
    const who = await f.playerWithPhone();
    const enrollment = await f.join(desk.event, who.who, options.via ?? null);
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until,
                               created_at, collect_until)
       SELECT organizer_id, id, $2, $3, 5, $4, now() + $6::interval, now() + $5::interval,
              CASE WHEN $7 THEN now() + interval '3 minutes' END
       FROM event WHERE id = $1 RETURNING id`,
      [desk.event, enrollment, desk.reward, randomUUID(), made, until, options.collecting ?? false],
    );
    return { ...who, enrollment, redemption: row?.id ?? "" };
  };
  const OPEN_NOW =
    "tstzmultirange(tstzrange(now() - interval '1 day', now() - interval '23 hours'), tstzrange(now() - interval '5 minutes', now() + interval '2 hours'))";

  describe("reservations: ready at the desk and ending (FR-1101, ADR-353)", () => {
    it("ready at the opening for a reservation made before it, once; none made inside the window, closed, no hours, rehearsal or left", async () => {
      const open = await deskEvent(OPEN_NOW);
      const waited = await hold(open, "-1 hour", "25 minutes");
      const inside = await hold(open, "-1 minute", "25 minutes");
      const rehearsing = await hold(open, "-1 hour", "25 minutes", { via: "rehearsal" });
      const left = await hold(open, "-1 hour", "25 minutes");
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left.enrollment]);
      const closed = await hold(
        await deskEvent(
          "tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))",
        ),
        "-1 hour",
        "2 hours",
      );
      const always = await hold(await deskEvent(null), "-1 hour", "25 minutes");
      await due();
      await due();
      const notices = await noticesOf(waited.who);
      expect(notices).toMatchObject([
        {
          kind: "reward_ready",
          dedupe: `reward_ready:${waited.redemption}`,
          refs: { redemption: waited.redemption },
        },
      ]);
      expect(notices[0]?.params).toMatchObject({ reward: { ar: "قبعة", en: "Cap" } });
      for (const none of [inside, rehearsing, left, closed, always])
        expect(await kindsOf(none.who)).toEqual([]);
      await f.fanOut();
      expect(await centerOf(waited.who)).toEqual(["reward_ready"]);
    });

    it("ending 15 minutes before the end of a hold longer than 30 minutes while the desk can still be reached, once", async () => {
      const always = await deskEvent(null);
      const ending = await hold(always, "-2 hours", "10 minutes");
      const short = await hold(always, "-10 minutes", "10 minutes");
      const collecting = await hold(always, "-2 hours", "10 minutes", { collecting: true });
      const later = await hold(always, "-2 hours", "20 minutes");
      const unreachable = await hold(
        await deskEvent(
          "tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))",
        ),
        "-2 hours",
        "10 minutes",
      );
      const shortSinceOpening = await hold(
        await deskEvent(
          "tstzmultirange(tstzrange(now() - interval '15 minutes', now() + interval '2 hours'))",
        ),
        "-10 hours",
        "10 minutes",
      );
      const longSinceOpening = await hold(
        await deskEvent(
          "tstzmultirange(tstzrange(now() - interval '40 minutes', now() + interval '2 hours'))",
        ),
        "-10 hours",
        "10 minutes",
      );
      await due();
      await due();
      expect(await kindsOf(ending.who)).toEqual(["reward_ending"]);
      // A desk that opened after the reservation also told it was ready, at that opening.
      expect(await kindsOf(longSinceOpening.who)).toEqual(["reward_ready", "reward_ending"]);
      for (const one of [ending, longSinceOpening]) {
        const notices = (await noticesOf(one.who)).filter((row) => row.kind === "reward_ending");
        const [until] = await f.owner<{ reserved_until: Date }>(
          "SELECT reserved_until FROM redemption WHERE id = $1",
          [one.redemption],
        );
        expect(new Date(String(notices[0]?.params["time"])).getTime()).toBe(
          until?.reserved_until.getTime(),
        );
        expect(notices[0]?.expires_at.getTime()).toBeLessThanOrEqual(
          until?.reserved_until.getTime() ?? 0,
        );
      }
      for (const none of [short, collecting, later, unreachable])
        expect(await kindsOf(none.who)).toEqual([]);
      expect(await kindsOf(shortSinceOpening.who)).toEqual(["reward_ready"]);
    });

    it("runs in the system seat only, and a broken kind writes nothing and raises nothing", async () => {
      const always = await deskEvent(null);
      const ending = await hold(always, "-2 hours", "10 minutes");
      for (const seat of [{ playerId: ending.who }, f.team(), adminSeat()]) {
        expect(await sqlstate(f.run(seat, "SELECT push_due()"))).toBe("PN403");
      }
      await withoutKind("reward_ending", async () => {
        expect(await sqlstate(due())).toBe("none");
      });
      expect(await kindsOf(ending.who)).toEqual([]);
      expect(
        await f.count("redemption WHERE id = $1 AND status = 'reserved'", [ending.redemption]),
      ).toBe(1);
    });
  });

  // ------------------------------------------------------------------ what leaves the server
  describe("the text and the payload (ADR-346)", () => {
    it("is the fixed template in the device's language, with ids only in the payload", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live", access: "private" });
      const asker = await request(event);
      await decide(event, asker.enrollment, true);
      await staffAnswer(event, await ticket(event, asker.who, asker.enrollment), "Secret reply");
      const quest = await submissionQuest(event);
      await f.owner(
        `INSERT INTO player_acceptance (player_id, document, version, method) VALUES ($1, 'community_guidelines', '1.0', 'submission')`,
        [asker.who],
      );
      const sent = await submit(asker.who, quest);
      await review(event, sent?.submission_id ?? "", "reject", "Too short reason");
      await f.fanOut();
      const claimed = (await f.claim()) as unknown as ClaimedSend[];
      const mine = claimed.filter((row) => row.token === asker.token);
      const messages = mine.map((row) => pushMessageOf(row));
      expect(messages.map((message) => [message?.title, message?.body])).toEqual([
        ["فعالية", "قُبل طلب انضمامك."],
        ["فعالية", "ردّ عليك فريق الفعالية."],
        ["فعالية", "لم تُقبل إجابتك في «أخبرنا». يمكنك فتحها لمعرفة السبب."],
      ]);
      for (const message of messages) {
        expect(Object.keys(message?.data ?? {})).toEqual(["n", "k", "e", "r"]);
        for (const value of Object.values(
          JSON.parse(message?.data["r"] ?? "{}") as Record<string, string>,
        )) {
          expect(value).toMatch(REF_VALUE);
        }
        const shown = [message?.title, message?.body, JSON.stringify(message?.data)].join(" ");
        expect(shown).not.toMatch(/Secret|secret|7919|Too short|private answer/);
      }
    });
  });
});
