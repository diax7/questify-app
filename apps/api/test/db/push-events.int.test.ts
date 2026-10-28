import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { REF_VALUE } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushMessageOf, type ClaimedSend } from "#src/push/message";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type NoticeRow = {
  id: string;
  kind: string;
  refs: Record<string, unknown>;
  params: Record<string, unknown>;
  dedupe: string;
  expires_at: Date;
};
type Member = Readonly<{ who: string; enrollment: string; token: string; deviceId: string }>;
type Due = Readonly<Record<string, number | boolean>>;

const fiveMinutesAgo = () => new Date(Date.now() - 5 * 60_000);

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rehearsalCode = () => {
  const letters = Array.from({ length: 8 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
};
const LIVE_POLL = {
  options: [
    { id: "a", text: { en: "Robots" } },
    { id: "b", text: { en: "Space" } },
  ],
  live: { choices: "one", results: "after_vote", minutes: 10 },
};

/**
 * The owed event pushes in the database (T-501e, migration 0078; plan docs/plans/2026-10-28-t-501e-event-pushes.md):
 * each producer writes one notice through notice_create, once and only once, reaching the right members and no one
 * else; a broken kind never rolls a door back; the due scans and their markers; what moved is checked again at sending;
 * the start's time in the event's zone; the text is the fixed template and the payload ids only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event pushes (database)", () => {
  let f: PushFixture;
  let admin = "";
  beforeAll(async () => {
    f = await pushFixture();
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('push-events@questify.test', 'h', 'admin')
       RETURNING id`,
    );
    admin = made?.id ?? "";
  });
  afterAll(async () => {
    await f.close();
  });

  const adminSeat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  const due = () => f.one<Due>(f.system, "SELECT push_due() AS r");
  const noticesOf = (event: string, kind: string) =>
    f.owner<NoticeRow>(
      `SELECT id, kind, refs, params, dedupe, expires_at FROM notice WHERE event_id = $1 AND kind = $2 ORDER BY id`,
      [event, kind],
    );
  const onlyNotice = async (event: string, kind: string) => {
    const rows = await noticesOf(event, kind);
    expect(rows, kind).toHaveLength(1);
    return rows[0] as NoticeRow;
  };
  const recipients = async (notice: NoticeRow | undefined) => f.recipients(notice?.id ?? null);

  /** A member with a phone: active unless `status` says otherwise, joined by code unless `via` says otherwise. */
  const member = async (
    event: string,
    options: Readonly<{ via?: string; status?: string }> = {},
  ): Promise<Member> => {
    const phone = await f.playerWithPhone();
    const enrollment = await f.join(event, phone.who, options.via ?? "code");
    if (options.status !== undefined) {
      await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [
        enrollment,
        options.status,
      ]);
    }
    return { who: phone.who, enrollment, token: phone.token, deviceId: phone.deviceId };
  };
  /** Everyone an event push must never reach, beside one real member who should get it. */
  const crowd = async (event: string) => {
    const real = await member(event);
    const left = await member(event, { status: "left" });
    const banned = await member(event, { status: "banned" });
    const pending = await member(event, { status: "pending" });
    const rehearsing = await member(event, { via: "rehearsal" });
    const operator = await member(event);
    await f.owner(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play)
       SELECT organizer_id, id, $2, false FROM event WHERE id = $1`,
      [event, operator.who],
    );
    const barred = await member(event);
    await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [barred.who]);
    const erased = await member(event);
    expect(await f.erase(erased.who)).toBe("erased");
    return { real, others: [left, banned, pending, rehearsing, operator, barred, erased] };
  };
  const category = async (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en, name_ar) VALUES ($1, 'Main stage', 'المسرح') RETURNING id",
      [event],
    );
    for (const [column, value] of Object.entries(fields)) {
      await f.owner(`UPDATE category SET ${column} = $2 WHERE id = $1`, [made?.id, value]);
    }
    return made?.id ?? "";
  };
  const quest = async (
    event: string,
    fields: Readonly<{
      category?: string;
      flash?: boolean;
      visible?: boolean;
      opens?: string | null;
      closes?: string | null;
      type?: string;
      config?: object;
    }> = {},
  ) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, flash, visible, opens_at, closes_at,
                          type_config)
       VALUES ($1, $2, $3, 'Find the falcon', 'ابحث عن الصقر', 10, $4, $5, now() + $6::interval, now() + $7::interval,
               $8) RETURNING id`,
      [
        event,
        fields.category ?? (await category(event)),
        fields.type ?? "scan_qr",
        fields.flash ?? false,
        fields.visible ?? true,
        fields.opens ?? null,
        fields.closes ?? null,
        JSON.stringify(fields.config ?? {}),
      ],
    );
    return made?.id ?? "";
  };
  const launch = (event: string, target: string) =>
    f.run<{ opens_at: Date; closes_at: Date; replayed: boolean }>(
      f.team(),
      "SELECT * FROM launch_flash($1, $2, 10, $3)",
      [event, target, randomUUID()],
    );
  const sendPoll = (event: string, target: string) =>
    f.run<{ replayed: boolean }>(f.team(), "SELECT * FROM send_poll($1, $2, $3)", [
      event,
      target,
      randomUUID(),
    ]);
  const saveBoost = async (event: string, target: string, starts: Date | null = null) =>
    (
      await f.run<{ id: string }>(f.team(), "SELECT save_boost($1, NULL, $2, $3, 30, $4) AS id", [
        event,
        target,
        starts,
        randomUUID(),
      ])
    )[0]?.id ?? "";
  const openRehearsal = (event: string) =>
    f.owner(
      `INSERT INTO event_rehearsal (event_id, organizer_id, code)
       SELECT id, organizer_id, $2 FROM event WHERE id = $1`,
      [event, rehearsalCode()],
    );
  /** The claim's answer for one member's device: the send's state and code after a claim. */
  const sendOf = async (notice: NoticeRow | undefined, who: Member) =>
    (await f.sends(notice?.id ?? null)).find((row) => row.device_id === who.deviceId);
  const claimAll = async () => {
    await f.claim();
  };

  /** A points goal of 100 that began 10 minutes ago, with milestones at 30 and 60. */
  const goal = async (event: string) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
       SELECT organizer_id, id, 'Light the tower', 'points', 100, date_trunc('milliseconds', now()) - interval '10 minutes',
              now() + interval '1 hour' FROM event WHERE id = $1 RETURNING id`,
      [event],
    );
    const steps = await f.owner<{ id: string; threshold: string }>(
      `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward)
       VALUES ($1, $2, 30, false, 'nothing'), ($1, $2, 60, false, 'nothing'), ($1, $2, 100, true, 'nothing')
       RETURNING id, threshold`,
      [event, made?.id],
    );
    const stepAt = (threshold: number) =>
      steps.find((row) => Number(row.threshold) === threshold)?.id ?? "";
    return { goal: made?.id ?? "", stepAt };
  };
  const settle = (target: string) =>
    f.run<{ s: string }>(f.system, "SELECT settle_goal($1, true) AS s", [target]);

  /** A scheduled event starting in 30 minutes, in the zone given. */
  const soon = async (zone = "Asia/Riyadh") => {
    const event = await f.newEvent({ phase: "scheduled" });
    await f.owner(
      "UPDATE event SET starts_at = date_trunc('milliseconds', now()) + interval '30 minutes', timezone = $2 WHERE id = $1",
      [event, zone],
    );
    return event;
  };

  // ------------------------------------------------------------------ a flash quest
  describe("a flash quest (FR-1102, T-307)", () => {
    it("Launch: one notice naming the quest until it closes, to the members who may play and no one else", async () => {
      const event = await f.newEvent({ phase: "live" });
      const { real, others } = await crowd(event);
      // Another organizer's member, in another organizer's live event: never reached (cross-tenant).
      const elsewhere = await member(await f.newEvent({ phase: "live", organizer: f.ids.orgB }));
      const flash = await quest(event, { flash: true, visible: false });
      const [launched] = await launch(event, flash);
      expect((await launch(event, flash))[0]?.replayed).toBe(true);
      const notice = await onlyNotice(event, "flash_quest");
      expect(notice).toMatchObject({
        refs: { quest: flash },
        params: { quest: { ar: "ابحث عن الصقر", en: "Find the falcon" } },
      });
      expect(notice.dedupe).toMatch(new RegExp(`^flash:${flash}:[0-9]{16}$`));
      expect(notice.expires_at.getTime()).toBeLessThanOrEqual(launched?.closes_at.getTime() ?? 0);
      await f.fanOut();
      expect(await recipients(notice)).toEqual([real.who]);
      for (const one of [...others, elsewhere]) expect(await sendOf(notice, one)).toBeUndefined();
      expect(await due()).toMatchObject({ flash: 0 });
    });

    it("a hidden category's flash quest reaches only the members who found it", async () => {
      const event = await f.newEvent({ phase: "live" });
      const hidden = await category(event, { hidden: true });
      const found = await member(event);
      await member(event);
      await f.owner(
        `INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
         SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1`,
        [event, found.enrollment, hidden],
      );
      await launch(event, await quest(event, { category: hidden, flash: true, visible: false }));
      await f.fanOut();
      expect(await recipients(await onlyNotice(event, "flash_quest"))).toEqual([found.who]);
    });

    it("scheduled: the scan writes one notice at its opening, never before and never twice; moved later, it is skipped", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const one = await member(event);
      const flash = await quest(event, { flash: true, opens: "1 hour", closes: "2 hours" });
      await due();
      expect(await noticesOf(event, "flash_quest")).toEqual([]);
      await f.owner(
        "UPDATE quest SET opens_at = now() - interval '1 minute', closes_at = now() + interval '20 minutes' WHERE id = $1",
        [flash],
      );
      expect(await due()).toMatchObject({ flash: 1, more: false });
      expect(await due()).toMatchObject({ flash: 0 });
      const notice = await onlyNotice(event, "flash_quest");
      await f.fanOut();
      expect(await recipients(notice)).toEqual([one.who]);
      await f.owner(
        "UPDATE quest SET opens_at = now() + interval '1 hour', closes_at = now() + interval '2 hours' WHERE id = $1",
        [flash],
      );
      await claimAll();
      expect(await sendOf(notice, one)).toMatchObject({ state: "skipped", code: "not_visible" });
    });

    it("a rehearsal launch reaches rehearsal accounts only, and a second launch is a second notice", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      await openRehearsal(event);
      const rehearsing = await member(event, { via: "rehearsal" });
      await member(event);
      const flash = await quest(event, { flash: true, visible: false });
      await launch(event, flash);
      await f.fanOut();
      expect(await recipients(await onlyNotice(event, "flash_quest"))).toEqual([rehearsing.who]);
      await f.owner(
        "UPDATE quest SET visible = false, opens_at = NULL, closes_at = NULL, flash_launched_at = NULL WHERE id = $1",
        [flash],
      );
      await launch(event, flash);
      const both = await noticesOf(event, "flash_quest");
      expect(both).toHaveLength(2);
      expect(both[0]?.dedupe).not.toBe(both[1]?.dedupe);
    });
  });

  // ------------------------------------------------------------------ a boost
  describe("a boost (FR-1102, T-307)", () => {
    it("saved to start now: one notice at once naming the category until it ends; a real boost never reaches a rehearsal account", async () => {
      const event = await f.newEvent({ phase: "live" });
      const { real, others } = await crowd(event);
      const stage = await category(event);
      const boost = await saveBoost(event, stage);
      const notice = await onlyNotice(event, "boost_start");
      expect(notice).toMatchObject({
        refs: { boost, category: stage },
        params: { category: { ar: "المسرح", en: "Main stage" } },
        dedupe: `boost:${boost}`,
      });
      const [saved] = await f.owner<{ ends_at: Date }>("SELECT ends_at FROM boost WHERE id = $1", [
        boost,
      ]);
      expect(notice.expires_at.getTime()).toBeLessThanOrEqual(saved?.ends_at.getTime() ?? 0);
      await due();
      expect(await noticesOf(event, "boost_start")).toHaveLength(1);
      await f.fanOut();
      expect(await recipients(notice)).toEqual([real.who]);
      for (const one of others) expect(await sendOf(notice, one)).toBeUndefined();
    });

    it("starting later: the scan writes it at its start, once; a stopped boost's push is skipped", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const one = await member(event);
      const stage = await category(event);
      const [made] = await f.owner<{ id: string }>(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         SELECT organizer_id, id, $2, now() + interval '1 second', now() + interval '30 minutes' FROM event
         WHERE id = $1 RETURNING id`,
        [event, stage],
      );
      expect(await noticesOf(event, "boost_start")).toEqual([]);
      await sleep(1200);
      expect(await due()).toMatchObject({ boost: 1 });
      expect(await due()).toMatchObject({ boost: 0 });
      const notice = await onlyNotice(event, "boost_start");
      await f.fanOut();
      expect(await recipients(notice)).toEqual([one.who]);
      await f.run(f.team(), "SELECT * FROM end_boost($1, $2, $3)", [event, made?.id, randomUUID()]);
      await claimAll();
      expect(await sendOf(notice, one)).toMatchObject({ state: "skipped", code: "not_member" });
    });

    it("a flash quest or a boost in a category not open yet reaches no one; a category moved later skips the push", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const one = await member(event);
      const later = await category(event, { opens_at: new Date(Date.now() + 3_600_000) });
      await launch(event, await quest(event, { category: later, flash: true, visible: false }));
      await saveBoost(event, later);
      await f.fanOut();
      expect(await recipients(await onlyNotice(event, "flash_quest"))).toEqual([]);
      expect(await recipients(await onlyNotice(event, "boost_start"))).toEqual([]);
      const open = await category(event);
      await saveBoost(event, open);
      await f.fanOut();
      const boosted = (await noticesOf(event, "boost_start")).at(-1);
      expect(await recipients(boosted)).toEqual([one.who]);
      await f.owner("UPDATE category SET opens_at = now() + interval '1 hour' WHERE id = $1", [
        open,
      ]);
      await claimAll();
      expect(await sendOf(boosted, one)).toMatchObject({ state: "skipped", code: "not_member" });
    });

    it("a rehearsal boost reaches rehearsal accounts only", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      await openRehearsal(event);
      const rehearsing = await member(event, { via: "rehearsal" });
      await member(event);
      await saveBoost(event, await category(event));
      await f.fanOut();
      expect(await recipients(await onlyNotice(event, "boost_start"))).toEqual([rehearsing.who]);
    });
  });

  // ------------------------------------------------------------------ a live poll
  describe("a live poll (FR-1102, T-306)", () => {
    it("Send: one notice per send, to members who see it and have not voted; a vote after the fan-out skips the push", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const { real, others } = await crowd(event);
      const early = await member(event);
      const late = await member(event);
      const poll = await quest(event, { type: "vote", config: LIVE_POLL, visible: false });
      await sendPoll(event, poll);
      expect((await sendPoll(event, poll))[0]?.replayed).toBe(true);
      const notice = await onlyNotice(event, "poll_sent");
      expect(notice).toMatchObject({ refs: { quest: poll } });
      expect(notice.dedupe).toMatch(new RegExp(`^poll:${poll}:[0-9]{16}$`));
      const vote = (who: Member) =>
        f.run({ playerId: who.who }, "SELECT * FROM vote_quest($1, $2, $3)", [
          poll,
          ["a"],
          randomUUID(),
        ]);
      await vote(early);
      await f.fanOut();
      expect(await recipients(notice)).toEqual([real.who, late.who].toSorted());
      for (const one of others) expect(await sendOf(notice, one)).toBeUndefined();
      await vote(late);
      await claimAll();
      expect(await sendOf(notice, late)).toMatchObject({ state: "skipped", code: "not_member" });
      expect(await sendOf(notice, real)).toMatchObject({ state: "sending" });
    });
  });

  // ------------------------------------------------------------------ a community milestone
  describe("a community milestone (FR-246, T-306b)", () => {
    it("two milestones reached in one settle give one notice, for the higher; the goal gives one more; re-settling adds none", async () => {
      const event = await f.newEvent({ phase: "live" });
      const { real, others } = await crowd(event);
      const made = await goal(event);
      await f.earn(event, real.enrollment, { points: 70, at: fiveMinutesAgo() });
      await settle(made.goal);
      const first = await onlyNotice(event, "community_step");
      expect(first).toMatchObject({
        refs: { goal: made.goal, step: made.stepAt(60) },
        dedupe: `community_step:${made.stepAt(60)}`,
      });
      expect(Object.keys(first.params)).toEqual(["event"]);
      // Counted in the open tail above the settle point the first settle reached.
      await f.earn(event, real.enrollment, { points: 40 });
      await settle(made.goal);
      await settle(made.goal);
      const all = await noticesOf(event, "community_step");
      expect(all.map((row) => row.refs["step"])).toEqual([made.stepAt(60), made.stepAt(100)]);
      await f.fanOut();
      expect(await recipients(all[1])).toEqual([real.who]);
      for (const one of others) expect(await sendOf(all[1], one)).toBeUndefined();
    });

    it("a broken kind cannot roll back the settle: the steps are reached and nothing is written", async () => {
      const event = await f.newEvent({ phase: "live" });
      const who = await member(event);
      const made = await goal(event);
      await f.earn(event, who.enrollment, { points: 100, at: fiveMinutesAgo() });
      await f.withoutKind("community_step", async () => {
        expect((await settle(made.goal))[0]?.s).toBe("reached");
      });
      expect(await f.count("community_reach WHERE event_id = $1", [event])).toBe(3);
      expect(await noticesOf(event, "community_step")).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ a category opening
  describe("a category opening (FR-1102)", () => {
    it("the scan names a category opening after the start to the members who see it, once; never one open from the start, ahead, stale, hidden from them or empty", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE event SET starts_at = now() - interval '1 hour' WHERE id = $1", [
        event,
      ]);
      const { real, others } = await crowd(event);
      const finder = await member(event);
      const opening = async (
        target: string,
        opens: string,
        fields: Readonly<Record<string, unknown>> = {},
      ) => {
        const made = await category(target, fields);
        await f.owner("UPDATE category SET opens_at = now() + $2::interval WHERE id = $1", [
          made,
          opens,
        ]);
        await quest(target, { category: made });
        return made;
      };
      const now = await opening(event, "-1 minute");
      await opening(event, "-90 minutes");
      await opening(event, "1 hour");
      await opening(await f.newEvent({ phase: "live" }), "-3 hours");
      const hidden = await opening(event, "-1 minute", { hidden: true });
      await f.owner(
        `INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
         SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1`,
        [event, finder.enrollment, hidden],
      );
      const empty = await category(event);
      await f.owner("UPDATE category SET opens_at = now() - interval '1 minute' WHERE id = $1", [
        empty,
      ]);
      expect(await due()).toMatchObject({ category: 2 });
      expect(await due()).toMatchObject({ category: 0 });
      const notices = await noticesOf(event, "category_open");
      expect(notices.map((row) => row.refs["category"])).toEqual([now, hidden]);
      expect(notices[0]?.params).toMatchObject({ category: { ar: "المسرح", en: "Main stage" } });
      await f.fanOut();
      expect(await recipients(notices[0])).toEqual([real.who, finder.who].toSorted());
      expect(await recipients(notices[1])).toEqual([finder.who]);
      for (const one of others) expect(await sendOf(notices[0], one)).toBeUndefined();
      await f.owner("UPDATE category SET opens_at = now() + interval '1 hour' WHERE id = $1", [
        now,
      ]);
      await claimAll();
      expect(await sendOf(notices[0], real)).toMatchObject({
        state: "skipped",
        code: "not_member",
      });
      expect(await sendOf(notices[1], finder)).toMatchObject({ state: "sending" });
    });

    it("a category that unlocks after another is never pushed, and an opening notice for one costs no gate check", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      await f.owner("UPDATE event SET starts_at = now() - interval '1 hour' WHERE id = $1", [
        event,
      ]);
      const gate = await category(event);
      const gateQuests: string[] = [];
      for (let i = 0; i < 20; i += 1) gateQuests.push(await quest(event, { category: gate }));
      const cleared = await member(event);
      await f.owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         SELECT e.organizer_id, e.id, $2, q, 1, 'qr', gen_random_uuid()::text FROM event e, unnest($3::uuid[]) q
         WHERE e.id = $1`,
        [event, cleared.enrollment, gateQuests],
      );
      await f.owner(
        `WITH p AS (INSERT INTO player (username) SELECT 'gate_' || $2 || '_' || g FROM generate_series(1, 1500) g
                    RETURNING id)
         INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT e.organizer_id, e.id, p.id
         FROM p CROSS JOIN event e WHERE e.id = $1`,
        [event, randomUUID().slice(0, 8)],
      );
      const gated = await category(event, { unlock_after: gate });
      await f.owner("UPDATE category SET opens_at = now() - interval '1 minute' WHERE id = $1", [
        gated,
      ]);
      await quest(event, { category: gated });
      expect(await due()).toMatchObject({ category: 0 });
      expect(await noticesOf(event, "category_open")).toEqual([]);
      // A notice written before the gate was set (here by hand): one fan-out call of 1,000 checks no gate, writes no row.
      const early = await f.notice("category_open", { event, refs: { category: gated } });
      const started = performance.now();
      await f.fanOut();
      expect(performance.now() - started).toBeLessThan(5000);
      expect(await f.recipients(early)).toEqual([]);
      // An opening pushed before the gate was set: its queued pushes are skipped at the claim without a gate check.
      const open = await category(event);
      await f.owner("UPDATE category SET opens_at = now() - interval '1 minute' WHERE id = $1", [
        open,
      ]);
      await quest(event, { category: open });
      expect(await due()).toMatchObject({ category: 1 });
      await f.fanOut();
      const opening = (await noticesOf(event, "category_open")).at(-1);
      expect(await recipients(opening)).toContain(cleared.who);
      await f.owner("UPDATE category SET unlock_after = $2 WHERE id = $1", [open, gate]);
      const claimed = performance.now();
      await claimAll();
      expect(performance.now() - claimed).toBeLessThan(5000);
      expect(await sendOf(opening, cleared)).toMatchObject({
        state: "skipped",
        code: "not_member",
      });
    });

    it("a moved opening is pushed again only when it moved 15 minutes or more", async () => {
      const event = await f.newEvent({ phase: "live" });
      await member(event);
      const moving = await category(event);
      await quest(event, { category: moving });
      const openAt = (minutes: number) =>
        f.owner("UPDATE category SET opens_at = now() + make_interval(mins => $2) WHERE id = $1", [
          moving,
          minutes,
        ]);
      await openAt(-1);
      expect(await due()).toMatchObject({ category: 1 });
      await openAt(-10);
      expect(await due()).toMatchObject({ category: 0 });
      await openAt(-20);
      expect(await due()).toMatchObject({ category: 1 });
      expect(await noticesOf(event, "category_open")).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------------ the event starting soon
  describe("the event starting soon (FR-1102)", () => {
    it("a scheduled event within the hour: one notice naming its start, real members only; a moved start is skipped and gets its own", async () => {
      await f.drain();
      const event = await soon();
      const { real, others } = await crowd(event);
      const later = await f.newEvent({ phase: "scheduled" });
      await member(later);
      expect(await due()).toMatchObject({ soon: 1 });
      expect(await due()).toMatchObject({ soon: 0 });
      expect(await noticesOf(later, "event_soon")).toEqual([]);
      const notice = await onlyNotice(event, "event_soon");
      const [start] = await f.owner<{ starts_at: Date; micros: string }>(
        "SELECT starts_at, push_instant(starts_at) AS micros FROM event WHERE id = $1",
        [event],
      );
      expect(notice.dedupe).toBe(`event_soon:${event}:${start?.micros}`);
      expect(new Date(String(notice.params["time"])).getTime()).toBe(start?.starts_at.getTime());
      expect(notice.expires_at.getTime()).toBeLessThanOrEqual(start?.starts_at.getTime() ?? 0);
      await f.fanOut();
      expect(await recipients(notice)).toEqual([real.who]);
      for (const one of others) expect(await sendOf(notice, one)).toBeUndefined();
      await f.owner(
        "UPDATE event SET starts_at = starts_at + interval '20 minutes' WHERE id = $1",
        [event],
      );
      await claimAll();
      expect(await sendOf(notice, real)).toMatchObject({ state: "skipped", code: "not_member" });
      expect(await due()).toMatchObject({ soon: 1 });
      expect(await noticesOf(event, "event_soon")).toHaveLength(2);
    });

    it("a start nudged by less than 15 minutes is not pushed again; moved further it is, at most twice", async () => {
      const event = await soon();
      await member(event);
      const startIn = (minutes: number) =>
        f.owner(
          "UPDATE event SET starts_at = date_trunc('milliseconds', now()) + make_interval(mins => $2) WHERE id = $1",
          [event, minutes],
        );
      const pushes = async () => (await noticesOf(event, "event_soon")).length;
      await startIn(2);
      await due();
      await due();
      expect(await pushes()).toBe(1);
      await startIn(10);
      await due();
      expect(await pushes()).toBe(1);
      await startIn(20);
      await due();
      expect(await pushes()).toBe(2);
      await startIn(38);
      await due();
      expect(await pushes()).toBe(3);
      await startIn(56);
      await due();
      expect(await pushes()).toBe(3);
    });

    it("names the start in the event's own zone", async () => {
      await f.drain();
      const shown: Record<string, string> = {};
      for (const zone of ["Asia/Riyadh", "Europe/London"]) {
        const event = await soon(zone);
        const one = await member(event);
        await due();
        await f.fanOut();
        const claimed = (await f.claim()) as unknown as ClaimedSend[];
        const mine = claimed.find((row) => row.token === one.token);
        const [start] = await f.owner<{ starts_at: Date }>(
          "SELECT starts_at FROM event WHERE id = $1",
          [event],
        );
        const local = new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: zone,
        }).format(start?.starts_at);
        const message = mine === undefined ? null : pushMessageOf({ ...mine, language: "en" });
        expect(message?.body, zone).toBe(`The event starts at ${local}.`);
        shown[zone] = local;
      }
      expect(shown["Asia/Riyadh"]).not.toBe(shown["Europe/London"]);
    });

    it("a broken kind cannot roll back the activation, and the scan then writes nothing and raises nothing", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      await f.owner(
        `UPDATE event SET status = 'draft', starts_at = now() + interval '30 minutes', venue_en = 'Hall A'
         WHERE id = $1`,
        [event],
      );
      await member(event);
      await f.withoutKind("event_soon", async () => {
        await f.run(adminSeat(), "SELECT activate_event($1, 'none', NULL, NULL, $2)", [
          event,
          randomUUID(),
        ]);
        expect(await sqlstate(due())).toBe("none");
      });
      expect(await f.count("event WHERE id = $1 AND status = 'scheduled'", [event])).toBe(1);
      expect(await noticesOf(event, "event_soon")).toEqual([]);
      await due();
      expect(await noticesOf(event, "event_soon")).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ the doors and the scans
  describe("a broken kind cannot roll back the door (plan § Review 2)", () => {
    it("Launch, Save boost and Send poll commit with no notice", async () => {
      const event = await f.newEvent({ phase: "live" });
      await member(event);
      const flash = await quest(event, { flash: true, visible: false });
      await f.withoutKind("flash_quest", async () => {
        expect((await launch(event, flash))[0]?.replayed).toBe(false);
      });
      const stage = await category(event);
      const boost = await f.withoutKind("boost_start", () => saveBoost(event, stage));
      const poll = await quest(event, { type: "vote", config: LIVE_POLL, visible: false });
      await f.withoutKind("poll_sent", async () => {
        expect((await sendPoll(event, poll))[0]?.replayed).toBe(false);
      });
      expect(await f.count("quest WHERE id = ANY($1) AND visible", [[flash, poll]])).toBe(2);
      expect(await f.count("boost WHERE id = $1", [boost])).toBe(1);
      expect(await f.count("notice WHERE event_id = $1", [event])).toBe(0);
    });

    it("the scans run in the system seat only; with their kinds missing (flash, boost, opening) they write nothing and raise nothing", async () => {
      const event = await f.newEvent({ phase: "live" });
      await member(event);
      await quest(event, { flash: true, opens: "-1 minute", closes: "20 minutes" });
      const opened = await category(event);
      await f.owner("UPDATE category SET opens_at = now() - interval '1 minute' WHERE id = $1", [
        opened,
      ]);
      await quest(event, { category: opened });
      for (const seat of [f.team(), adminSeat()]) {
        expect(await sqlstate(f.run(seat, "SELECT push_due()"))).toBe("PN403");
      }
      await f.withoutKind("flash_quest", () =>
        f.withoutKind("category_open", () =>
          f.withoutKind("boost_start", async () => {
            // A boost that started while its kind was missing: the trigger and then the scan meet an unknown kind.
            await f.owner(
              `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
               SELECT organizer_id, id, $2, now() - interval '1 minute', now() + interval '30 minutes' FROM event
               WHERE id = $1`,
              [event, opened],
            );
            expect(await due()).toMatchObject({ flash: 0, boost: 0, category: 0, more: false });
          }),
        ),
      );
      expect(await f.count("boost WHERE event_id = $1", [event])).toBe(1);
      expect(await f.count("notice WHERE event_id = $1", [event])).toBe(0);
    });
  });

  // ------------------------------------------------------------------ what leaves the server
  describe("the text and the payload (ADR-346)", () => {
    it("is the fixed template in the device's language, with ids only in the payload", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const one = await member(event);
      const flash = await quest(event, { flash: true, visible: false });
      await launch(event, flash);
      await saveBoost(event, await category(event));
      await sendPoll(
        event,
        await quest(event, { type: "vote", config: LIVE_POLL, visible: false }),
      );
      await f.fanOut();
      const claimed = (await f.claim()) as unknown as ClaimedSend[];
      const messages = claimed
        .filter((row) => row.token === one.token)
        .map((row) => pushMessageOf(row));
      expect(messages.map((message) => [message?.title, message?.body])).toEqual([
        ["فعالية", "مهمة بوقت محدود: «ابحث عن الصقر»"],
        ["فعالية", "نقاط مضاعفة الآن في «المسرح»."],
        ["فعالية", "تصويت مباشر جديد: «ابحث عن الصقر»"],
      ]);
      for (const message of messages) {
        expect(Object.keys(message?.data ?? {})).toEqual(["n", "k", "e", "r"]);
        for (const value of Object.values(
          JSON.parse(message?.data["r"] ?? "{}") as Record<string, string>,
        )) {
          expect(value).toMatch(REF_VALUE);
        }
      }
    });
  });
});
