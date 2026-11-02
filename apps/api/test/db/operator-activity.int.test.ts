import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Station = {
  questId: string;
  titleEn: string | null;
  titleAr: string | null;
  scans: number;
  lastAt: string;
};
type Row = {
  id: string;
  username: string;
  scansHour: number;
  scans: number;
  awards: number;
  handOvers: number;
  handled: number;
  lastAt: string | null;
  lastAction: string | null;
  stations: Station[];
};
type Recent = {
  at: string;
  action: string;
  operatorId: string;
  username: string;
  questId: string | null;
  titleEn: string | null;
};
type Activity = {
  asOf: string;
  operators: Row[];
  recent: Recent[];
  briefings: { id: string; titleEn: string; bodyEn: string; recipients: number }[];
};
type Sent = { id: string; recipients: number; replayed: boolean };
type Draft = Record<string, string | undefined>;

const GOOD: Draft = {
  titleAr: "تغيير البوابة",
  titleEn: "Gate change",
  bodyAr: "البوابة 3 مغلقة. استخدموا البوابة 1.",
  bodyEn: "Gate 3 is closed. Use gate 1.",
};

/** A call's SQLSTATE and detail ("PE409:event_closed"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/**
 * Operator activity and the staff briefing in the database (T-617, migration 0111, ADR-402): one read of what each
 * operator of an event did today and last, for the event's own team, and a briefing that writes one personal notice per
 * current operator, once per Idempotency-Key, inside its own rate limit.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("operator activity (database)", () => {
  let f: PushFixture;
  let outsider: string | undefined;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const organizerOf = async (event: string): Promise<string | undefined> =>
    (
      await f.owner<{ organizer_id: string }>("SELECT organizer_id FROM event WHERE id = $1", [
        event,
      ])
    )[0]?.organizer_id;
  const activity = async (
    event: string,
    options: Readonly<{ recent?: number; seat?: RequestContext }> = {},
  ): Promise<Activity> =>
    (
      await f.run<{ r: Activity }>(
        options.seat ?? f.team(),
        "SELECT operator_activity($1, $2) AS r",
        [event, options.recent ?? 5],
      )
    )[0]?.r as Activity;
  const send = (
    event: string,
    options: Readonly<{ draft?: Draft; key?: string; seat?: RequestContext }> = {},
  ) =>
    f.run<Sent>(
      options.seat ?? f.team(),
      "SELECT * FROM staff_briefing_send($1, $2::jsonb, $3, $4)",
      [event, JSON.stringify(options.draft ?? GOOD), options.key ?? randomUUID(), randomUUID()],
    );
  const noticesOf = (event: string) =>
    f.owner<{
      id: string;
      player_id: string;
      kind: string;
      audience: string;
      refs: Record<string, unknown>;
      params: Record<string, Record<string, string>>;
      expires_at: Date;
    }>(
      "SELECT id, player_id, kind, audience, refs, params, expires_at FROM notice WHERE event_id = $1 AND kind = 'staff_briefing' ORDER BY id",
      [event],
    );
  const outsiderOwner = async (): Promise<string> =>
    (outsider ??= await addMember(f.db.owner, f.ids.orgB, "owner"));

  /** A player who staffs the event; the assignment's id comes back with the player. */
  const operator = async (event: string, options: Readonly<{ canPlay?: boolean }> = {}) => {
    const who = await f.newPlayer();
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, $4) RETURNING id`,
      [await organizerOf(event), event, who, options.canPlay ?? false],
    );
    return { who, assignment: row?.id ?? "", username: await f.usernameOf(who) };
  };
  const station = async (event: string, title: string) => {
    const [row] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', $2, $2, 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [event, title],
    );
    return row?.id ?? "";
  };
  let occurrence = 0;
  /** One station scan by `op` at `at`: the completion and the ledger entry, as the engine writes them. */
  const scan = async (
    event: string,
    enrollment: string,
    quest: string,
    op: string,
    at: Date = new Date(),
  ) => {
    occurrence += 1;
    const [done] = await f.owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, 'my_qr', $6, $7) RETURNING id`,
      [await organizerOf(event), event, enrollment, quest, occurrence, randomUUID(), at],
    );
    await f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor, operator_id, created_at)
       VALUES ($1, $2, $3, 'quest', 10, 10, $4, $5, 'operator', $6, $7)`,
      [await organizerOf(event), event, enrollment, done?.id, quest, op, at],
    );
  };
  const award = async (event: string, enrollment: string, op: string, at: Date = new Date()) =>
    f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 operator_id, created_at)
       VALUES ($1, $2, $3, 'award', 5, 5, 'operator', $4, $5)`,
      [await organizerOf(event), event, enrollment, op, at],
    );
  const handOver = async (event: string, enrollment: string, op: string, at: Date = new Date()) => {
    const [reward] = await f.owner<{ id: string }>(
      "INSERT INTO reward (event_id, kind, name_en, name_ar, price, stock_total) VALUES ($1, 'item', 'Cap', 'قبعة', 5, 99) RETURNING id",
      [event],
    );
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key,
                               reserved_until, status, ended_at, ended_by, operator_id)
       VALUES ($1, $2, $3, $4, 5, $5, now() + interval '1 hour', 'handed_over', now(), 'handover', $6) RETURNING id`,
      [await organizerOf(event), event, enrollment, reward?.id, randomUUID(), op],
    );
    await f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 redemption_id, actor, operator_id, created_at)
       VALUES ($1, $2, $3, 'handover', 0, 0, $4, 'operator', $5, $6)`,
      [await organizerOf(event), event, enrollment, made?.id, op, at],
    );
  };
  const review = async (event: string, enrollment: string, quest: string, op: string, at: Date) =>
    f.owner(
      `INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, reason,
                               reviewed_by_operator, review_key, reviewed_at, idempotency_key)
       VALUES ($1, $2, $3, $4, 'text', 'My answer', 10, 'rejected', 'Off topic', $5, $6, $7, $8)`,
      [await organizerOf(event), event, enrollment, quest, op, randomUUID(), at, randomUUID()],
    );
  const answer = async (event: string, enrollment: string, player: string, op: string, at: Date) =>
    f.owner(
      `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, status, outcome,
                           closed_at, answer_key, answered_by_operator, idempotency_key)
       VALUES ($1, $2, $3, $4, 'question', 'Where is the desk', 'closed', 'solved', $5, $6, $7, $8)`,
      [player, await organizerOf(event), event, enrollment, at, randomUUID(), op, randomUUID()],
    );
  /** A live event with a player to serve. */
  const liveEvent = async () => {
    const event = await f.newEvent({ phase: "live" });
    const player = await f.newPlayer();
    return { event, player, enrollment: await f.join(event, player) };
  };

  // ------------------------------------------------------------------ the activity
  describe("the activity read", () => {
    it("is empty for an event with no operators", async () => {
      const { event } = await liveEvent();
      const answered = await activity(event);
      expect(answered).toMatchObject({ operators: [], recent: [], briefings: [] });
      expect(new Date(answered.asOf).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("shows an operator who did nothing as quiet, with no last action", async () => {
      const { event } = await liveEvent();
      const idle = await operator(event);
      expect((await activity(event)).operators).toEqual([
        {
          id: idle.assignment,
          username: idle.username,
          scansHour: 0,
          scans: 0,
          awards: 0,
          handOvers: 0,
          handled: 0,
          lastAt: null,
          lastAction: null,
          stations: [],
        },
      ]);
    });

    it("counts scans in the last hour and today, awards and hand-overs, and names the last action", async () => {
      const { event, enrollment } = await liveEvent();
      const busy = await operator(event);
      const gate = await station(event, "Gate");
      const booth = await station(event, "Booth");
      await scan(event, enrollment, gate, busy.who, ago(90));
      await scan(event, enrollment, gate, busy.who, ago(40));
      await scan(event, enrollment, gate, busy.who, ago(10));
      await scan(event, enrollment, booth, busy.who, ago(5));
      await award(event, enrollment, busy.who, ago(3));
      await handOver(event, enrollment, busy.who, ago(1));
      const [row] = (await activity(event)).operators;
      expect(row).toMatchObject({
        id: busy.assignment,
        username: busy.username,
        scansHour: 3,
        scans: 4,
        awards: 1,
        handOvers: 1,
        handled: 0,
        lastAction: "hand_over",
      });
      expect(Math.abs(new Date(row?.lastAt as string).getTime() - ago(1).getTime())).toBeLessThan(
        5_000,
      );
      expect(row?.stations.map((s) => [s.titleEn, s.scans])).toEqual([
        ["Gate", 3],
        ["Booth", 1],
      ]);
      expect(row?.stations[0]).toMatchObject({ questId: gate, titleAr: "Gate" });
    });

    it("leaves the last-hour count out of a scan 30 minutes quiet but keeps it in the last activity", async () => {
      const { event, enrollment } = await liveEvent();
      const op = await operator(event);
      const gate = await station(event, "Gate");
      await scan(event, enrollment, gate, op.who, ago(45));
      const [row] = (await activity(event)).operators;
      expect(row).toMatchObject({ scansHour: 1, scans: 1, lastAction: "scan" });
      expect(Date.now() - new Date(row?.lastAt as string).getTime()).toBeGreaterThan(44 * 60_000);
    });

    it("counts only the event's day, and still shows an earlier action as the last", async () => {
      const { event, enrollment } = await liveEvent();
      const op = await operator(event);
      const gate = await station(event, "Gate");
      await scan(event, enrollment, gate, op.who, ago(3 * 24 * 60));
      const [row] = (await activity(event)).operators;
      expect(row).toMatchObject({ scansHour: 0, scans: 0, lastAction: "scan", stations: [] });
      expect(row?.lastAt).not.toBeNull();
    });

    it("counts a review and a help answer as handled and as the last action", async () => {
      const { event, enrollment, player } = await liveEvent();
      const moderator = await operator(event);
      const gate = await station(event, "Gate");
      await review(event, enrollment, gate, moderator.who, ago(20));
      await answer(event, enrollment, player, moderator.who, ago(2));
      const [row] = (await activity(event)).operators;
      expect(row).toMatchObject({ scans: 0, handled: 2, lastAction: "answer" });
      const recent = (await activity(event)).recent;
      expect(recent.map((r) => r.action)).toEqual(["answer", "review"]);
    });

    it("keeps every operator and every event apart", async () => {
      const first = await liveEvent();
      const second = await liveEvent();
      const a = await operator(first.event);
      const b = await operator(second.event);
      const gate = await station(first.event, "Gate");
      const other = await station(second.event, "Other");
      await scan(first.event, first.enrollment, gate, a.who, ago(2));
      await scan(second.event, second.enrollment, other, b.who, ago(1));
      const mine = await activity(first.event);
      expect(mine.operators.map((o) => o.username)).toEqual([a.username]);
      expect(mine.operators[0]?.scans).toBe(1);
      expect(mine.recent.map((r) => r.username)).toEqual([a.username]);
      // The same player staffing a second event does not carry its numbers across.
      const [extra] = await f.owner<{ id: string }>(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id`,
        [await organizerOf(second.event), second.event, a.who],
      );
      expect(extra?.id).toBeDefined();
      const there = (await activity(second.event)).operators.find((o) => o.username === a.username);
      expect(there).toMatchObject({ scans: 0, lastAt: null });
    });

    it("lists the most recently active operator first, quiet ones last by name", async () => {
      const { event, enrollment } = await liveEvent();
      const early = await operator(event);
      const late = await operator(event);
      const quiet = await operator(event);
      const gate = await station(event, "Gate");
      await scan(event, enrollment, gate, early.who, ago(30));
      await scan(event, enrollment, gate, late.who, ago(2));
      const names = (await activity(event)).operators.map((o) => o.username);
      expect(names).toEqual([late.username, early.username, quiet.username]);
    });

    it("drops a removed operator", async () => {
      const { event, enrollment } = await liveEvent();
      const gone = await operator(event);
      const gate = await station(event, "Gate");
      await scan(event, enrollment, gate, gone.who, ago(2));
      await f.owner("DELETE FROM staff_assignment WHERE id = $1", [gone.assignment]);
      expect(await activity(event)).toMatchObject({ operators: [], recent: [] });
    });

    it("returns the latest actions newest first, within the limit asked for (1 to 50)", async () => {
      const { event, enrollment } = await liveEvent();
      const one = await operator(event);
      const two = await operator(event);
      const gate = await station(event, "Gate");
      for (let i = 0; i < 8; i += 1) {
        await scan(event, enrollment, gate, i % 2 === 0 ? one.who : two.who, ago(20 - i));
      }
      const five = (await activity(event)).recent;
      expect(five).toHaveLength(5);
      expect(five.map((r) => r.at)).toEqual(
        five
          .map((r) => r.at)
          .toSorted()
          .toReversed(),
      );
      expect(five[0]).toMatchObject({ action: "scan", questId: gate, titleEn: "Gate" });
      expect(five[0]?.username).toBe(two.username);
      expect(await activity(event, { recent: 0 }).then((a) => a.recent)).toHaveLength(1);
      expect(await activity(event, { recent: 8 }).then((a) => a.recent)).toHaveLength(8);
      expect(await activity(event, { recent: 1000 }).then((a) => a.recent)).toHaveLength(8);
    });

    it("names the five kinds of ledger action and no others", async () => {
      const [row] = await f.owner<{ kinds: (string | null)[] }>(
        `SELECT array_agg(operator_action_of(k) ORDER BY k) AS kinds
         FROM unnest(ARRAY['quest', 'session', 'award', 'handover', 'redeem_return', 'welcome']) k`,
      );
      expect(row?.kinds).toEqual(["award", "hand_over", "scan", "cancel", "check_in", null]);
    });

    it("carries usernames and counts only, never a player an operator served", async () => {
      const { event, enrollment, player } = await liveEvent();
      const op = await operator(event);
      const gate = await station(event, "Gate");
      await scan(event, enrollment, gate, op.who, ago(2));
      const text = JSON.stringify(await activity(event));
      expect(text).not.toContain(await f.usernameOf(player));
      expect(text).not.toContain(player);
      expect(text).not.toContain(enrollment);
    });

    it("reads the operator's ledger rows by the new index", async () => {
      const { event } = await liveEvent();
      await f.owner("BEGIN");
      try {
        await f.owner("SET LOCAL enable_seqscan = off");
        const plan = await f.owner<Record<string, unknown>>(
          `EXPLAIN SELECT count(*) FROM ledger_entry l
           WHERE l.event_id = $1 AND l.operator_id = gen_random_uuid() AND l.created_at >= now() - interval '1 day'`,
          [event],
        );
        expect(plan.map((line) => String(line["QUERY PLAN"])).join(" ")).toMatch(
          /ledger_entry_operator_event_idx/,
        );
      } finally {
        await f.owner("ROLLBACK");
      }
    });
  });

  // ------------------------------------------------------------------ who may read and send
  describe("roles", () => {
    it("lets an owner and an editor read and send, and refuses everyone else", async () => {
      const { event } = await liveEvent();
      await operator(event);
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      expect((await activity(event, { seat: f.team(editor) })).operators).toHaveLength(1);
      expect((await send(event, { seat: f.team(editor) }))[0]?.recipients).toBe(1);
      const outsideOwner = await outsiderOwner();
      for (const seat of [
        f.team(outsideOwner, f.ids.orgB),
        { playerId: await f.newPlayer() },
        {},
      ] as RequestContext[]) {
        expect(await refusal(activity(event, { seat })), "read").toMatch(/^(AN404|42501)$/);
        expect(await refusal(send(event, { seat })), "send").toMatch(/^(AN404|42501)$/);
      }
      const elsewhere = await f.newEvent({ phase: "live" });
      const limited = f.team(await addMember(f.db.owner, f.ids.orgA, "editor", [elsewhere]));
      expect(await refusal(activity(event, { seat: limited }))).toBe("AN404");
      expect(await refusal(send(event, { seat: limited }))).toBe("AN404");
    });

    it("is not reachable by an operator's own seat", async () => {
      const { event } = await liveEvent();
      const op = await operator(event);
      expect(await refusal(activity(event, { seat: { playerId: op.who } }))).toBe("AN404");
      expect(await refusal(send(event, { seat: { playerId: op.who } }))).toBe("AN404");
    });
  });

  // ------------------------------------------------------------------ the briefing
  describe("the staff briefing", () => {
    beforeEach(async () => {
      await f.drain();
    });
    it("is a personal kind with no topic, six hours, for the event's operators", async () => {
      const [row] = await f.owner<Record<string, unknown>>(
        "SELECT class, topic, membership, before_start, priority, ttl::text AS ttl FROM notice_kind WHERE kind = 'staff_briefing'",
      );
      expect(row).toEqual({
        class: "personal",
        topic: null,
        membership: "staff",
        before_start: false,
        priority: 0,
        ttl: "06:00:00",
      });
    });

    it("writes one personal notice per current operator, with the frozen text, and nobody else", async () => {
      const { event, enrollment } = await liveEvent();
      const first = await operator(event);
      const second = await operator(event, { canPlay: true });
      const other = await liveEvent();
      await operator(other.event);
      const [made] = await send(event);
      expect(made).toMatchObject({ recipients: 2, replayed: false });
      const notices = await noticesOf(event);
      expect(notices.map((n) => n.player_id).toSorted()).toEqual(
        [first.who, second.who].toSorted(),
      );
      expect(notices.every((n) => n.audience === "player")).toBe(true);
      expect(notices[0]?.refs).toEqual({ briefing: made?.id });
      expect(notices[0]?.params).toMatchObject({
        title: { ar: GOOD["titleAr"], en: GOOD["titleEn"] },
        body: { ar: GOOD["bodyAr"], en: GOOD["bodyEn"] },
      });
      expect((await noticesOf(other.event)).length).toBe(0);
      expect(notices.some((n) => n.player_id === enrollment)).toBe(false);
      const until = (notices[0]?.expires_at.getTime() ?? 0) - Date.now();
      expect(Math.abs(until - 6 * 3_600_000)).toBeLessThan(60_000);
    });

    it("tells operators only: never a player, a rehearsal account, a removed or a suspended operator", async () => {
      const { event, player } = await liveEvent();
      const kept = await operator(event);
      const removed = await operator(event);
      const suspended = await operator(event);
      await f.owner("DELETE FROM staff_assignment WHERE id = $1", [removed.assignment]);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [suspended.who]);
      const [made] = await send(event);
      expect(made?.recipients).toBe(1);
      expect((await noticesOf(event)).map((n) => n.player_id)).toEqual([kept.who]);
      await f.fanOut();
      const told = await f.owner<{ player_id: string }>(
        `SELECT c.player_id FROM notification c JOIN notice n ON n.id = c.notice_id WHERE n.event_id = $1`,
        [event],
      );
      expect(told.map((row) => row.player_id)).toEqual([kept.who]);
      expect(told.some((row) => row.player_id === player)).toBe(false);
    });

    it("writes a center row for an operator who is not enrolled and pushes it to their phone", async () => {
      const { event } = await liveEvent();
      const phone = await f.playerWithPhone();
      await f.owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [await organizerOf(event), event, phone.who],
      );
      const [made] = await send(event);
      expect(made?.recipients).toBe(1);
      await f.fanOut();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual([phone.who]);
      const sends = await f.sends(notice?.id ?? null);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({ target: "apns:production", state: "queued" });
      const claimed = await f.claim(["apns:production"], 10);
      expect(claimed.filter((c) => c.kind === "staff_briefing")).toHaveLength(1);
    });

    it("is not a mutable topic: an operator who muted every topic is still pushed", async () => {
      const { event } = await liveEvent();
      const phone = await f.playerWithPhone();
      await f.owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [await organizerOf(event), event, phone.who],
      );
      for (const topic of ["announcements", "rank", "community", "reminders"]) {
        await f.owner(
          "INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [phone.who, topic],
        );
      }
      await send(event);
      await f.fanOut();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual([phone.who]);
      expect(await f.sends(notice?.id ?? null)).toHaveLength(1);
    });

    it("skips the push of an operator removed after the briefing was written, and writes no center row", async () => {
      const { event } = await liveEvent();
      const phone = await f.playerWithPhone();
      const [assignment] = await f.owner<{ id: string }>(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [await organizerOf(event), event, phone.who],
      );
      await send(event);
      await f.fanOut();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual([phone.who]);
      await f.owner("DELETE FROM staff_assignment WHERE id = $1", [assignment?.id]);
      const claimed = await f.claim(["apns:production"], 10);
      expect(claimed.filter((c) => c.kind === "staff_briefing")).toHaveLength(0);
      const skipped = await f.sends(notice?.id ?? null);
      expect(skipped[0]).toMatchObject({ state: "skipped", code: "not_member" });

      const later = await liveEvent();
      const gone = await f.playerWithPhone();
      const [kept] = await f.owner<{ id: string }>(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [await organizerOf(later.event), later.event, gone.who],
      );
      await send(later.event);
      await f.owner("DELETE FROM staff_assignment WHERE id = $1", [kept?.id]);
      await f.fanOut();
      const [second] = await noticesOf(later.event);
      expect(await f.recipients(second?.id ?? null)).toEqual([]);
    });

    it("answers a repeated key with the first result, writes nothing and leaves the rate alone", async () => {
      const { event } = await liveEvent();
      await operator(event);
      const key = randomUUID();
      const [first] = await send(event, { key });
      const [again] = await send(event, { key });
      expect(again).toEqual({ id: first?.id, recipients: 1, replayed: true });
      expect(await noticesOf(event)).toHaveLength(1);
      expect(await f.count("staff_briefing WHERE event_id = $1", [event])).toBe(1);
    });

    it("limits an event to 3 briefings an hour and 10 a day, and counts a window not a clock hour", async () => {
      const { event } = await liveEvent();
      await operator(event);
      await send(event);
      await send(event);
      await send(event);
      expect(await refusal(send(event))).toBe("PL429:hour");
      await f.owner(
        "UPDATE staff_briefing SET created_at = now() - interval '2 hours' WHERE event_id = $1",
        [event],
      );
      expect((await send(event))[0]?.replayed).toBe(false);
      for (let i = 0; i < 6; i += 1) {
        await f.owner(
          `INSERT INTO staff_briefing (organizer_id, event_id, title_ar, title_en, body_ar, body_en, press, recipients,
                                       created_by, created_at)
           VALUES ($1, $2, 'ا', 'a', 'ا', 'a', $3, 1, $4, now() - interval '3 hours')`,
          [await organizerOf(event), event, randomUUID().replaceAll("-", "").repeat(2), f.ownerA],
        );
      }
      expect(await refusal(send(event))).toBe("PL429:day");
    });

    it("sends before the event starts and while it is live, and refuses an ended or archived event", async () => {
      for (const phase of ["scheduled", "live"] as const) {
        const event = await f.newEvent({ phase });
        await operator(event);
        expect((await send(event))[0]?.recipients, phase).toBe(1);
      }
      for (const phase of ["ended", "archived"] as const) {
        const event = await f.newEvent({ phase });
        await operator(event);
        expect(await refusal(send(event)), phase).toBe("PE409:event_closed");
        expect(await noticesOf(event)).toHaveLength(0);
      }
    });

    it("refuses when no operator can receive it, and writes nothing", async () => {
      const { event } = await liveEvent();
      expect(await refusal(send(event))).toBe("PT409:nobody");
      const suspended = await operator(event);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [suspended.who]);
      expect(await refusal(send(event))).toBe("PT409:nobody");
      expect(await f.count("staff_briefing WHERE event_id = $1", [event])).toBe(0);
      expect(await noticesOf(event)).toHaveLength(0);
    });

    it("refuses a missing key and every bad field, each named", async () => {
      const { event } = await liveEvent();
      await operator(event);
      expect(await refusal(send(event, { key: "" }))).toBe("PK400");
      const long = "x".repeat(141);
      const cases: Draft[] = [
        { ...GOOD, titleAr: "" },
        { ...GOOD, titleEn: undefined },
        { ...GOOD, bodyAr: long },
        { ...GOOD, bodyEn: long },
        { ...GOOD, titleEn: "x".repeat(61) },
        { ...GOOD, bodyEn: "line\nbreak" },
      ];
      for (const draft of cases) {
        expect(await refusal(send(event, { draft })), JSON.stringify(draft)).toMatch(/^PA422:/);
      }
      expect(await noticesOf(event)).toHaveLength(0);
    });

    it("audits the count and never the text", async () => {
      const { event } = await liveEvent();
      await operator(event);
      const [made] = await send(event);
      const [row] = await f.owner<{
        action: string;
        target_id: string;
        after: Record<string, unknown>;
      }>(
        "SELECT action, target_id, after FROM audit_log WHERE event_id = $1 AND action = 'staff.briefing'",
        [event],
      );
      expect(row).toEqual({
        action: "staff.briefing",
        target_id: made?.id,
        after: { recipients: 1 },
      });
      expect(JSON.stringify(row)).not.toContain(GOOD["bodyEn"] as string);
    });

    it("lists the last five briefings for the team, newest first, with how many were told", async () => {
      const { event } = await liveEvent();
      await operator(event);
      for (let i = 0; i < 6; i += 1) {
        await send(event, { draft: { ...GOOD, titleEn: `Notice ${i}` } });
        await f.owner(
          "UPDATE staff_briefing SET created_at = now() - make_interval(hours => $2) WHERE event_id = $1 AND title_en = $3",
          [event, 6 - i, `Notice ${i}`],
        );
      }
      const { briefings } = await activity(event);
      expect(briefings.map((b) => b.titleEn)).toEqual([
        "Notice 5",
        "Notice 4",
        "Notice 3",
        "Notice 2",
        "Notice 1",
      ]);
      expect(briefings[0]).toMatchObject({ bodyEn: GOOD["bodyEn"], recipients: 1 });
    });

    it("keeps the briefing table closed to the API role", async () => {
      await expect(
        f.run({ organizerId: f.ids.orgA, staffUserId: f.ownerA }, "SELECT * FROM staff_briefing"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
