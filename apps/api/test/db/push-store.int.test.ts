import { randomUUID } from "node:crypto";
import { PUSH_TEMPLATES } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { centerItem } from "#src/push/center";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * The push store in the database (T-501, migration 0076; plan § Review 1, 2, 6 and 7): notice_create's one insert, the
 * fan-out's audience by membership, status and visibility, devices bound to the sign-in, mutes and consent, the center
 * doors, erasure and the cleanup after it, retention.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("push store (database)", () => {
  let f: PushFixture;
  let seededKinds: string[];
  beforeAll(async () => {
    f = await pushFixture();
    seededKinds = (await f.owner<{ kind: string }>("SELECT kind FROM notice_kind")).map(
      (row) => row.kind,
    );
  });
  afterAll(async () => {
    await f.close();
  });

  const member = async (
    event: string,
    options: Readonly<{ via?: string | null; status?: string }> = {},
  ) => {
    const who = await f.playerWithPhone();
    const enrollment = await f.join(event, who.who, options.via ?? null);
    if (options.status !== undefined) {
      await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [
        enrollment,
        options.status,
      ]);
    }
    return { ...who, enrollment };
  };
  const categoryOf = async (event: string) =>
    (
      await f.owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1 LIMIT 1", [event])
    )[0]?.id ?? "";
  const newQuest = async (
    event: string,
    options: Readonly<{
      opens?: string | null;
      closes?: string | null;
      visible?: boolean;
      category?: string;
    }> = {},
  ) => {
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config, opens_at, closes_at)
       VALUES ($1, $2, 'scan_qr', 'Quest', 10, 1, $3, '{}', now() + $4::interval, now() + $5::interval)
       RETURNING id`,
      [
        event,
        options.category ?? (await categoryOf(event)),
        options.visible ?? true,
        options.opens ?? null,
        options.closes ?? null,
      ],
    );
    return quest?.id ?? "";
  };
  const tagVip = async (event: string, player: string) => {
    const [contact] = await f.owner<{ email: string }>(
      "SELECT email FROM player_contact WHERE player_id = $1",
      [player],
    );
    await f.owner(
      `INSERT INTO event_guest (organizer_id, event_id, kind, value, tag)
       SELECT organizer_id, id, 'email', $2, 'vip' FROM event WHERE id = $1`,
      [event, contact?.email],
    );
  };

  /** A trigger that makes every center row of the given notices fail, as a poisoned batch would. */
  const poison = async (ids: readonly (string | null)[]) => {
    const list = ids.map((id) => Number(id)).join(", ");
    await f.owner(
      `CREATE OR REPLACE FUNCTION pg_temp.poison() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.notice_id IN (${list}) THEN RAISE EXCEPTION 'poisoned batch' USING ERRCODE = '22012'; END IF;
         RETURN NEW;
       END $$`,
    );
    await f.owner(
      "CREATE TRIGGER push_poison BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION pg_temp.poison()",
    );
  };
  const cure = () => f.owner("DROP TRIGGER IF EXISTS push_poison ON notification");
  const fanOnce = () => f.one<Record<string, unknown>>(f.system, "SELECT push_fan_out() AS r");
  /** The notice's failure count and its back-off in whole minutes from now. */
  const backOff = async (id: string | null) =>
    (
      await f.owner<{ failures: number; minutes: number | null }>(
        `SELECT fan_failures AS failures,
                round(extract(epoch FROM retry_after - now()) / 60)::int AS minutes
         FROM notice WHERE id = $1`,
        [id],
      )
    )[0];
  /** Brings the notice's back-off to its end, as time passing would. */
  const elapse = (id: string | null) =>
    f.owner("UPDATE notice SET retry_after = now() - interval '1 second' WHERE id = $1", [id]);

  describe("notice_create (plan § Review 2)", () => {
    it("every notice_kind row the migrations seed has a template", () => {
      for (const name of seededKinds) expect(PUSH_TEMPLATES[name], name).toBeDefined();
    });

    it("with an unknown kind writes nothing and raises nothing", async () => {
      const player = await f.newPlayer();
      expect(await f.notice("no_such_kind", { player })).toBeNull();
      expect(await f.count("notice WHERE player_id = $1", [player])).toBe(0);
    });

    it("twice with one dedupe: one notice", async () => {
      const kind = await f.kind();
      const player = await f.newPlayer();
      const dedupe = randomUUID();
      expect(await f.notice(kind, { player, dedupe })).not.toBeNull();
      expect(await f.notice(kind, { player, dedupe })).toBeNull();
      expect(await f.count("notice WHERE dedupe = $1", [dedupe])).toBe(1);
    });

    it("a past until: one expired notice, no error; a later until is capped by the kind's time to live", async () => {
      const kind = await f.kind({ ttl: "2 hours" });
      const player = await f.newPlayer();
      const past = await f.notice(kind, { player, until: new Date(Date.now() - 60_000) });
      const late = await f.notice(kind, { player, until: new Date(Date.now() + 9 * 3600_000) });
      const [rows] = await f.owner<{ past: boolean; capped: boolean }>(
        `SELECT (SELECT expires_at < now() FROM notice WHERE id = $1) AS past,
                (SELECT expires_at <= now() + interval '2 hours' FROM notice WHERE id = $2) AS capped`,
        [past, late],
      );
      expect(rows).toEqual({ past: true, capped: true });
    });

    it("refuses a mismatch by inserting nothing: no player for a personal kind, a player for an event kind, another organizer's event, no marker", async () => {
      const personal = await f.kind();
      const eventKind = await f.kind({ class: "event" });
      const event = await f.newEvent({ phase: "live" });
      const player = await f.newPlayer();
      expect(await f.notice(personal, { event })).toBeNull();
      expect(await f.notice(eventKind, { event, player })).toBeNull();
      expect(await f.notice(eventKind, {})).toBeNull();
      const [bad] = await f.owner<{ id: string | null }>(
        "SELECT notice_create($1, $2, $3, NULL, '{}', '{}', $4, NULL) AS id",
        [eventKind, f.ids.orgB, event, randomUUID()],
      );
      expect(bad?.id).toBeNull();
      const [none] = await f.owner<{ id: string | null }>(
        "SELECT notice_create($1, NULL, NULL, $2, '{}', '{}', NULL, NULL) AS id",
        [personal, player],
      );
      expect(none?.id).toBeNull();
    });

    it("a personal notice: no center row until the worker runs, then one", async () => {
      const kind = await f.kind();
      const { who } = await f.playerWithPhone();
      const id = await f.notice(kind, { player: who });
      expect(await f.recipients(id)).toEqual([]);
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([who]);
      expect((await f.sends(id)).map((row) => row.state)).toEqual(["queued"]);
    });
  });

  describe("the event's status decides the audience (plan § Review 1)", () => {
    it("ended event: a shop-closing-shaped notice reaches every active member, not only rehearsal accounts", async () => {
      const event = await f.newEvent({ phase: "ended" });
      const kind = await f.kind({ class: "event", topic: "reminders" });
      const a = await member(event);
      const b = await member(event);
      const id = await f.notice(kind, { event });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([a.who, b.who].toSorted());
    });

    it("draft and scheduled: rehearsal enrollments only", async () => {
      const kind = await f.kind({ class: "event" });
      for (const status of ["draft", "scheduled"]) {
        const event = await f.newEvent({ phase: "scheduled" });
        if (status === "draft")
          await f.owner("UPDATE event SET status = 'draft' WHERE id = $1", [event]);
        const rehearsal = await member(event, { via: "rehearsal" });
        await member(event);
        const id = await f.notice(kind, { event });
        await f.fanOut();
        expect(await f.recipients(id), status).toEqual([rehearsal.who]);
      }
    });

    it("before_start in scheduled: real members, no rehearsal account; nothing once live", async () => {
      const kind = await f.kind({ class: "event", topic: "reminders", beforeStart: true });
      const event = await f.newEvent({ phase: "scheduled" });
      await member(event, { via: "rehearsal" });
      const real = await member(event);
      const id = await f.notice(kind, { event });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([real.who]);
      const live = await f.newEvent({ phase: "live" });
      await member(live);
      const late = await f.notice(kind, { event: live });
      await f.fanOut();
      expect(await f.recipients(late)).toEqual([]);
    });

    it("archived: no center row, no send; a personal notice of an archived event gets its row and no send", async () => {
      const event = await f.newEvent({ phase: "archived" });
      const someone = await member(event);
      const eventKind = await f.kind({ class: "event" });
      const personal = await f.kind();
      const broadcast = await f.notice(eventKind, { event });
      const own = await f.notice(personal, { event, player: someone.who });
      await f.fanOut();
      expect(await f.recipients(broadcast)).toEqual([]);
      expect(await f.recipients(own)).toEqual([someone.who]);
      expect(await f.sends(own)).toEqual([]);
    });

    it("an event that ends between fan-out and the claim still sends", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event" });
      const one = await member(event);
      const id = await f.notice(kind, { event });
      await f.fanOut();
      await f.owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [
        event,
      ]);
      const claimed = await f.claim();
      expect(claimed.map((row) => row.notification_id)).toHaveLength(1);
      expect((await f.sends(id))[0]?.state).toBe("sending");
      expect(await f.recipients(id)).toEqual([one.who]);
    });
  });

  describe("a failing fan-out (code review minor 4, re-review 1 and 3)", () => {
    it("an event batch that fails waits 1, 4, 16 minutes, then at most an hour, with the alert at the third failure", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event" });
      const someone = await member(event);
      const poisoned = await f.notice(kind, { event });
      const behind = await f.notice(kind, { event });
      await poison([poisoned]);
      try {
        const answers = [];
        const waits = [];
        for (let i = 0; i < 5; i += 1) {
          const answer = await fanOnce();
          answers.push({
            failed: answer["failed"],
            code: answer["code"],
            parked: answer["parked"],
            more: answer["more"],
          });
          waits.push((await backOff(poisoned))?.minutes);
          if (i === 0) {
            // Waiting out its back-off, it no longer holds up the notice behind it.
            await f.fanOut();
            expect(await f.recipients(behind)).toEqual([someone.who]);
          }
          await elapse(poisoned);
        }
        expect(waits).toEqual([1, 4, 16, 60, 60]);
        expect(answers).toEqual(
          [1, 2, 3, 4, 5].map((n) => ({
            failed: Number(poisoned),
            code: "22012",
            parked: n === 3,
            more: false,
          })),
        );
        expect(await f.recipients(poisoned)).toEqual([]);
      } finally {
        await cure();
      }
      // Retried after its back-off once the cause is gone; the success clears the count.
      await elapse(poisoned);
      await f.fanOut();
      expect(await f.recipients(poisoned)).toEqual([someone.who]);
      expect(await backOff(poisoned)).toEqual({ failures: 0, minutes: null });
    });

    it("the manual release (RUNBOOK) retries a backed-off notice at once", async () => {
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event" });
      const someone = await member(event);
      const id = await f.notice(kind, { event });
      await f.owner(
        "UPDATE notice SET fan_failures = 7, retry_after = now() + interval '1 hour' WHERE id = $1",
        [id],
      );
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([]);
      await f.owner("UPDATE notice SET retry_after = NULL, fan_failures = 0 WHERE id = $1", [id]);
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([someone.who]);
    });

    it("a personal batch that fails finds the poisoned notice alone and backs it off; the others go out", async () => {
      const kind = await f.kind();
      const first = await f.playerWithPhone();
      const second = await f.playerWithPhone();
      const third = await f.playerWithPhone();
      const healthy = await f.notice(kind, { player: first.who });
      const poisoned = await f.notice(kind, { player: second.who });
      const later = await f.notice(kind, { player: third.who });
      await poison([poisoned]);
      try {
        // The batch of three fails; the oldest alone (healthy) goes out.
        expect(await fanOnce()).toMatchObject({ rows: 1, more: true });
        expect(await f.recipients(healthy)).toEqual([first.who]);
        // The batch of two fails; the oldest alone is the poisoned one: counted and backed off.
        expect(await fanOnce()).toMatchObject({
          failed: Number(poisoned),
          code: "22012",
          parked: false,
        });
        expect(await backOff(poisoned)).toEqual({ failures: 1, minutes: 1 });
        await f.fanOut();
        expect(await f.recipients(later)).toEqual([third.who]);
        expect(await f.recipients(poisoned)).toEqual([]);
      } finally {
        await cure();
      }
      await elapse(poisoned);
      await f.fanOut();
      expect(await f.recipients(poisoned)).toEqual([second.who]);
    });
  });

  describe("who receives (ADR-347)", () => {
    it("active only: pending, left, removed, banned and declined enrollments, banned and deleted players and excluded players get nothing", async () => {
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event" });
      const active = await member(event);
      for (const status of ["pending", "left", "removed", "banned", "declined"])
        await member(event, { status });
      const banned = await member(event);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned.who]);
      const deleted = await member(event);
      await f.owner(
        "UPDATE player SET status = 'deleted', username = NULL, deleted_at = now() - interval '3 days' WHERE id = $1",
        [deleted.who],
      );
      const excluded = await member(event);
      const [contact] = await f.owner<{ email: string }>(
        "SELECT email FROM player_contact WHERE player_id = $1",
        [excluded.who],
      );
      await f.owner(
        `INSERT INTO event_exclusion (organizer_id, event_id, kind, value)
         SELECT organizer_id, id, 'email_domain', split_part($2, '@', 2) FROM event WHERE id = $1`,
        [event, contact?.email],
      );
      const id = await f.notice(kind, { event });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([active.who]);
    });

    it("the decided rule reaches a declined request; none needs no enrollment", async () => {
      const event = await f.newEvent({ phase: "live" });
      const decided = await f.kind({ membership: "decided" });
      const none = await f.kind({ membership: "none" });
      const declined = await member(event, { status: "declined" });
      const stranger = await f.playerWithPhone();
      const a = await f.notice(decided, { event, player: declined.who });
      const b = await f.notice(none, { event, player: stranger.who });
      const c = await f.notice(decided, { event, player: stranger.who });
      await f.fanOut();
      expect(await f.recipients(a)).toEqual([declined.who]);
      expect(await f.recipients(b)).toEqual([stranger.who]);
      expect(await f.recipients(c)).toEqual([]);
    });

    it("personal notices go before event notices", async () => {
      const event = await f.newEvent({ phase: "live" });
      const eventKind = await f.kind({ class: "event" });
      const personal = await f.kind();
      const someone = await member(event);
      const broadcast = await f.notice(eventKind, { event });
      const own = await f.notice(personal, { player: someone.who });
      const first = await f.one<{ rows: number; more: boolean }>(
        f.system,
        "SELECT push_fan_out() AS r",
      );
      expect(first).toEqual({ rows: 1, more: true });
      expect(await f.recipients(own)).toEqual([someone.who]);
      expect(await f.recipients(broadcast)).toEqual([]);
      await f.fanOut();
      expect(await f.recipients(broadcast)).toEqual([someone.who]);
    });

    it("moves the cursor across batches of 2,000, a join in between taken in id order", async () => {
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event" });
      await f.owner(
        `WITH made AS (INSERT INTO player (username) SELECT 'pf_' || g || '_' || substr(md5(random()::text), 1, 6)
                       FROM generate_series(1, 2500) g RETURNING id)
         INSERT INTO enrollment (organizer_id, event_id, player_id)
         SELECT e.organizer_id, e.id, made.id FROM made CROSS JOIN event e WHERE e.id = $1`,
        [event],
      );
      const id = await f.notice(kind, { event });
      const first = await f.one<{ rows: number; more: boolean }>(
        f.system,
        "SELECT push_fan_out() AS r",
      );
      expect(first.rows).toBe(2000);
      const [cursor] = await f.owner<{ at: string }>(
        "SELECT fan_cursor AS at FROM notice WHERE id = $1",
        [id],
      );
      const late = await member(event);
      await f.fanOut();
      expect(await f.count("notice WHERE id = $1 AND fanned_at IS NOT NULL", [id])).toBe(1);
      const rows = await f.count("notification WHERE notice_id = $1", [id]);
      expect(rows).toBe(late.enrollment > (cursor?.at ?? "") ? 2501 : 2500);
    });

    it("an expired notice still gets its center rows and no send", async () => {
      const kind = await f.kind();
      const { who } = await f.playerWithPhone();
      const id = await f.notice(kind, { player: who, until: new Date(Date.now() - 1000) });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([who]);
      expect(await f.sends(id)).toEqual([]);
    });
  });

  describe("what a notice may name (plan § Review 7)", () => {
    it("a hidden category's notice reaches only members who revealed it; revealed after fan-out: no row", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await categoryOf(event);
      await f.owner("UPDATE category SET hidden = true WHERE id = $1", [category]);
      const kind = await f.kind({ class: "event" });
      const finder = await member(event);
      const other = await member(event);
      await f.owner(
        `INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
         SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1`,
        [event, finder.enrollment, category],
      );
      const id = await f.notice(kind, { event, refs: { category } });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([finder.who]);
      await f.owner(
        `INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
         SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1`,
        [event, other.enrollment, category],
      );
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([finder.who]);
    });

    it("a category targeted by a join answer or tag: only matching members; audience changed after planning: the claim skips not_visible", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const category = await categoryOf(event);
      await f.owner(
        "UPDATE category SET audience_kind = 'tag', audience_values = '{vip}' WHERE id = $1",
        [category],
      );
      const kind = await f.kind({ class: "event" });
      const vip = await member(event);
      await member(event);
      await tagVip(event, vip.who);
      const id = await f.notice(kind, { event, refs: { category } });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([vip.who]);
      await f.owner("UPDATE category SET audience_values = '{staff}' WHERE id = $1", [category]);
      expect(await f.claim()).toEqual([]);
      expect((await f.sends(id)).map((row) => [row.state, row.code])).toEqual([
        ["skipped", "not_visible"],
      ]);
    });

    it("an event notice naming a quest not yet open, already closed or not visible: no row", async () => {
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event" });
      const someone = await member(event);
      const open = await newQuest(event, { opens: "-1 hour", closes: "1 hour" });
      const later = await newQuest(event, { opens: "1 hour" });
      const closed = await newQuest(event, { closes: "-1 minute" });
      const hidden = await newQuest(event, { visible: false });
      const ids = [];
      for (const quest of [open, later, closed, hidden])
        ids.push(await f.notice(kind, { event, refs: { quest } }));
      await f.fanOut();
      const reached = [];
      for (const id of ids) reached.push((await f.recipients(id)).length);
      expect(reached).toEqual([1, 0, 0, 0]);
      expect(await f.recipients(ids[0] ?? null)).toEqual([someone.who]);
    });

    it("member_sees_quest gives member_event_quests' answer over the same fixtures, within the window", async () => {
      const event = await f.newEvent({ phase: "live" });
      const plain = await categoryOf(event);
      const [hiddenCat] = await f.owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en, hidden, position) VALUES ($1, 'Hidden', true, 1) RETURNING id",
        [event],
      );
      const [targeted] = await f.owner<{ id: string }>(
        `INSERT INTO category (event_id, name_en, audience_kind, audience_values, position)
         VALUES ($1, 'VIP', 'tag', '{vip}', 2) RETURNING id`,
        [event],
      );
      const someone = await member(event);
      const quests = [
        await newQuest(event),
        await newQuest(event, { category: hiddenCat?.id ?? "" }),
        await newQuest(event, { category: targeted?.id ?? "" }),
        await newQuest(event, { opens: "1 hour" }),
        await newQuest(event, { closes: "-1 minute" }),
        await newQuest(event, { visible: false }),
        await newQuest(event, { category: plain }),
      ];
      const listed = await f.asPlayer<{
        quest_id: string;
        opens_at: Date | null;
        closes_at: Date | null;
      }>(someone.who, "SELECT quest_id, opens_at, closes_at FROM member_event_quests($1)", [event]);
      const now = Date.now();
      for (const quest of quests) {
        const row = listed.find((one) => one.quest_id === quest);
        const expected =
          row !== undefined &&
          (row.opens_at === null || row.opens_at.getTime() <= now) &&
          (row.closes_at === null || row.closes_at.getTime() > now);
        const [seen] = await f.owner<{ ok: boolean }>("SELECT member_sees_quest($1, $2) AS ok", [
          someone.enrollment,
          quest,
        ]);
        expect(seen?.ok, quest).toBe(expected);
      }
      const answers = [];
      for (const quest of quests) {
        answers.push(
          (
            await f.owner<{ ok: boolean }>("SELECT member_sees_quest($1, $2) AS ok", [
              someone.enrollment,
              quest,
            ])
          )[0]?.ok,
        );
      }
      expect(answers).toEqual([true, false, false, false, false, false, true]);
    });

    it("an event notice naming a targeted reward: matching members only", async () => {
      const event = await f.newEvent({ phase: "live" });
      const [reward] = await f.owner<{ id: string }>(
        `INSERT INTO reward (organizer_id, event_id, kind, name_en, price, stock_total, audience_kind, audience_values)
         SELECT organizer_id, id, 'item', 'Mug', 10, 5, 'tag', '{vip}' FROM event WHERE id = $1 RETURNING id`,
        [event],
      );
      const kind = await f.kind({ class: "event" });
      const vip = await member(event);
      await member(event);
      await tagVip(event, vip.who);
      const id = await f.notice(kind, { event, refs: { reward: reward?.id } });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([vip.who]);
    });

    it("a submission decision on a closed quest still reaches its player; a malformed reference hides the notice", async () => {
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind();
      const someone = await member(event);
      const closed = await newQuest(event, { closes: "-1 day" });
      const decided = await f.notice(kind, { event, player: someone.who, refs: { quest: closed } });
      const broken = await f.notice(kind, {
        event,
        player: someone.who,
        refs: { category: "not-a-uuid" },
      });
      await f.fanOut();
      expect(await f.recipients(decided)).toEqual([someone.who]);
      expect(await f.recipients(broken)).toEqual([]);
    });
  });

  describe("devices (ADR-343 (5))", () => {
    it("registers only on the caller's own live session", async () => {
      const a = await f.newPlayer();
      const b = await f.newPlayer();
      const mine = await f.signIn(a);
      expect(await sqlstate(f.register(b, mine.session))).toBe("PN401");
      const revoked = await f.signIn(a);
      await f.owner("UPDATE player_session SET revoked_at = now() WHERE token_hash = $1", [
        revoked.session,
      ]);
      expect(await sqlstate(f.register(a, revoked.session))).toBe("PN401");
      const expired = await f.signIn(a);
      await f.owner(
        "UPDATE player_session SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
        [expired.session],
      );
      expect(await sqlstate(f.register(a, expired.session))).toBe("PN401");
      expect(await sqlstate(f.register(a, mine.session))).toBe("none");
      for (const status of ["banned", "deleted"]) {
        const who = await f.newPlayer();
        const sign = await f.signIn(who);
        await f.owner(
          "UPDATE player SET status = $2::text, username = CASE WHEN $2::text = 'deleted' THEN NULL ELSE username END WHERE id = $1",
          [who, status],
        );
        expect(await sqlstate(f.register(who, sign.session)), status).toBe("PN401");
      }
      expect(
        await sqlstate(
          f.run(
            { deviceId: randomUUID(), playerId: a },
            "SELECT push_device_register($1, 'ios', $2, 'production', 'ar', '1') ",
            [mine.session, "a".repeat(64)],
          ),
        ),
      ).toBe("PN401");
      expect(await f.count("push_device WHERE player_id = $1", [a])).toBe(1);
    });

    it("checks every field: an iOS token lower-cased and needing an environment, an Android one taking none", async () => {
      const who = await f.newPlayer();
      const sign = await f.signIn(who);
      const cases: Array<[Record<string, string | null>, string]> = [
        [{ platform: "web" }, "platform"],
        [{ token: "z".repeat(64) }, "token"],
        [{ environment: null }, "environment"],
        [{ environment: "staging" }, "environment"],
        [{ language: "fr" }, "language"],
      ];
      for (const [over, field] of cases) {
        const error = await f
          .run({ playerId: who }, "SELECT push_device_register($1, $2, $3, $4, $5, '1.0')", [
            sign.session,
            over["platform"] ?? "ios",
            over["token"] ?? "A".repeat(64),
            "environment" in over ? over["environment"] : "production",
            over["language"] ?? "ar",
          ])
          .then(
            () => null,
            (failure: { code?: string; detail?: string }) => [failure.code, failure.detail],
          );
        expect(error, field).toEqual(["PN422", field]);
      }
      expect(
        await sqlstate(
          f.run(
            { playerId: who },
            "SELECT push_device_register($1, 'ios', $2, 'sandbox', 'en', '')",
            [sign.session, "a".repeat(64)],
          ),
        ),
      ).toBe("PN422");
      await f.register(who, sign.session, { token: "AB".repeat(32) });
      const android = await f.signIn(who);
      await f.register(who, android.session, {
        platform: "android",
        token: "fcm_token_1234567890",
        environment: "production",
      });
      const rows = await f.owner<{ platform: string; token: string; environment: string | null }>(
        "SELECT platform, token, environment FROM push_device WHERE player_id = $1 ORDER BY platform",
        [who],
      );
      expect(rows).toEqual([
        { platform: "android", token: "fcm_token_1234567890", environment: null },
        { platform: "ios", token: "ab".repeat(32), environment: "production" },
      ]);
    });

    it("keeps one row per sign-in; the same token keeps token_set_at; a new token or environment resets the invalid mark and moves queued sends", async () => {
      const kind = await f.kind();
      const phone = await f.playerWithPhone();
      const read = async () =>
        (
          await f.owner<{ set: Date; seen: Date; invalid: Date | null; token: string }>(
            "SELECT token_set_at AS set, seen_at AS seen, invalid_at AS invalid, token FROM push_device WHERE family = $1",
            [phone.family],
          )
        )[0];
      const before = await read();
      await f.owner("UPDATE push_device SET seen_at = now() - interval '1 day' WHERE family = $1", [
        phone.family,
      ]);
      await f.register(phone.who, phone.session, { token: phone.token });
      const same = await read();
      expect(same?.set).toEqual(before?.set);
      expect((same?.seen.getTime() ?? 0) > Date.now() - 60_000).toBe(true);
      const id = await f.notice(kind, { player: phone.who });
      await f.fanOut();
      await f.owner(
        "UPDATE push_device SET invalid_at = now(), invalid_code = 'BadDeviceToken' WHERE family = $1",
        [phone.family],
      );
      await f.register(phone.who, phone.session, { token: phone.token, environment: "sandbox" });
      const moved = await read();
      expect(moved?.invalid).toBeNull();
      expect((moved?.set.getTime() ?? 0) > (before?.set.getTime() ?? 0)).toBe(true);
      expect((await f.sends(id)).map((row) => row.target)).toEqual(["apns:sandbox"]);
      expect(await f.count("push_device WHERE family = $1", [phone.family])).toBe(1);
    });

    it("moves a token to the sign-in that registered it last, with the other player's queued pushes gone", async () => {
      const kind = await f.kind();
      const first = await f.playerWithPhone();
      const id = await f.notice(kind, { player: first.who });
      await f.fanOut();
      expect(await f.sends(id)).toHaveLength(1);
      const second = await f.newPlayer();
      const sign = await f.signIn(second);
      await f.register(second, sign.session, { token: first.token.toUpperCase() });
      const owners = await f.owner<{ player_id: string }>(
        "SELECT player_id FROM push_device WHERE token = $1",
        [first.token],
      );
      expect(owners).toEqual([{ player_id: second }]);
      expect(await f.sends(id)).toEqual([]);
      expect(await f.recipients(id)).toEqual([first.who]);
    });

    it("removes the caller's device for this sign-in only, idempotently", async () => {
      const phone = await f.playerWithPhone();
      const other = await f.phone(phone.who);
      await f.one({ playerId: phone.who }, "SELECT push_device_remove($1) AS r", [phone.session]);
      await f.one({ playerId: phone.who }, "SELECT push_device_remove($1) AS r", [phone.session]);
      expect(await f.count("push_device WHERE player_id = $1", [phone.who])).toBe(1);
      expect(await f.count("push_device WHERE family = $1", [other.family])).toBe(1);
      const stranger = await f.newPlayer();
      expect(
        await sqlstate(
          f.one({ playerId: stranger }, "SELECT push_device_remove($1) AS r", [other.session]),
        ),
      ).toBe("PN401");
    });

    it("pushes only to a live sign-in: rotation keeps it, sign-out, the 10-family limit, a reused token and 60 days unseen stop it", async () => {
      const pushable = async (family: string) =>
        (
          await f.owner<{ ok: boolean }>(
            "SELECT push_pushable(d) AS ok FROM push_device d WHERE d.family = $1",
            [family],
          )
        )[0]?.ok;
      const rotated = await f.playerWithPhone();
      const [turn] = await f.owner<{ outcome: string }>(
        "SELECT outcome FROM rotate_player_refresh($1, $2, $3)",
        [rotated.refresh, Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
      );
      expect(turn?.outcome).toBe("rotated");
      expect(await pushable(rotated.family)).toBe(true);
      await f.owner("SELECT sign_out_player($1)", [Buffer.alloc(32, 2)]);
      expect(await pushable(rotated.family)).toBe(false);
      const reused = await f.playerWithPhone();
      await f.owner("SELECT * FROM rotate_player_refresh($1, $2, $3)", [
        reused.refresh,
        Buffer.alloc(32, 3),
        Buffer.alloc(32, 4),
      ]);
      await f.owner("SELECT * FROM rotate_player_refresh($1, $2, $3)", [
        Buffer.alloc(32, 4),
        Buffer.alloc(32, 5),
        Buffer.alloc(32, 6),
      ]);
      await f.owner(
        "UPDATE player_refresh SET used_at = now() - interval '5 minutes' WHERE token_hash = $1",
        [reused.refresh],
      );
      const [again] = await f.owner<{ outcome: string }>(
        "SELECT outcome FROM rotate_player_refresh($1, $2, $3)",
        [reused.refresh, Buffer.alloc(32, 7), Buffer.alloc(32, 8)],
      );
      expect(again?.outcome).toBe("reused");
      expect(await pushable(reused.family)).toBe(false);
      const evicted = await f.playerWithPhone();
      for (let i = 0; i < 10; i += 1) {
        await f.owner("SELECT issue_player_tokens($1, $2, $3, $4)", [
          evicted.who,
          Buffer.alloc(32, 20 + i),
          Buffer.alloc(32, 40 + i),
          randomUUID(),
        ]);
      }
      expect(await pushable(evicted.family)).toBe(false);
      const unseen = await f.playerWithPhone();
      await f.owner(
        "UPDATE push_device SET seen_at = now() - interval '61 days' WHERE family = $1",
        [unseen.family],
      );
      expect(await pushable(unseen.family)).toBe(false);
    });

    it("writes no ledger, XP or gem row when a device registers (FR-1106)", async () => {
      const counts = () =>
        f.owner<{ l: number; x: number; g: number }>(
          "SELECT (SELECT count(*) FROM ledger_entry)::int AS l, (SELECT count(*) FROM xp_entry)::int AS x, (SELECT count(*) FROM gem_entry)::int AS g",
        );
      const before = await counts();
      await f.playerWithPhone();
      expect(await counts()).toEqual(before);
      // No database function outside the push store reads a device or a mute (erasure only deletes them).
      const readers = await f.owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~ '(push_device|push_topic_mute|push_live_devices)' ORDER BY 1`,
      );
      expect(
        readers
          .map((row) => row.proname)
          .filter((name) => !name.startsWith("push_") && !name.endsWith("_push_topics")),
      ).toEqual(["erase_rows"]);
    });
  });

  describe("mute, consent and a refused permission (ADR-347, ADR-348)", () => {
    it("refused permission blocks nothing: three players (no device, muted, one device), three center rows, one send", async () => {
      const event = await f.newEvent({ phase: "live" });
      const kind = await f.kind({ class: "event", topic: "announcements" });
      const plain = await f.newPlayer();
      await f.join(event, plain);
      const muted = await member(event);
      await f.one({ playerId: muted.who }, "SELECT set_push_topics('{announcements}') AS r");
      const reached = await member(event);
      const id = await f.notice(kind, { event, params: { event: { en: "Fest" } } });
      await f.fanOut();
      expect(await f.recipients(id)).toEqual([plain, muted.who, reached.who].toSorted());
      expect((await f.sends(id)).map((row) => row.device_id)).toEqual([reached.deviceId]);
      for (const who of [plain, muted.who]) {
        const page = await f.one<Array<{ id: number }>>(
          { playerId: who },
          "SELECT own_notifications(NULL, 20) AS r",
        );
        expect(page).toHaveLength(1);
        expect(await f.one({ playerId: who }, "SELECT own_unread_notifications() AS r")).toBe(1);
        expect(
          await f.one({ playerId: who }, "SELECT mark_notifications_read($1::bigint[]) AS r", [
            [page[0]?.id],
          ]),
        ).toBe(0);
      }
    });

    it("muted after planning: the claim skips the push and the center row stays", async () => {
      await f.drain();
      const kind = await f.kind({ topic: "reminders" });
      const phone = await f.playerWithPhone();
      const id = await f.notice(kind, { player: phone.who });
      await f.fanOut();
      await f.one({ playerId: phone.who }, "SELECT set_push_topics('{reminders,rank}') AS r");
      expect(await f.claim()).toEqual([]);
      expect((await f.sends(id)).map((row) => [row.state, row.code])).toEqual([
        ["skipped", "muted"],
      ]);
      expect(await f.recipients(id)).toEqual([phone.who]);
    });

    it("promo: a token alone is not consent, so no center row and no send; consent withdrawn after planning is skipped", async () => {
      await f.drain();
      const kind = await f.kind({ class: "promo", membership: "none" });
      const noConsent = await f.playerWithPhone();
      const consentWithoutPhone = await f.newPlayer();
      await f.consentPush(consentWithoutPhone);
      const consenting = await f.playerWithPhone();
      await f.consentPush(consenting.who);
      const a = await f.notice(kind, { player: noConsent.who });
      const b = await f.notice(kind, { player: consenting.who });
      const c = await f.notice(kind, { player: consentWithoutPhone });
      await f.fanOut();
      expect(await f.sends(a)).toEqual([]);
      expect(await f.recipients(a)).toEqual([]);
      expect(await f.recipients(c)).toEqual([consentWithoutPhone]);
      expect(await f.recipients(b)).toEqual([consenting.who]);
      expect(await f.sends(b)).toHaveLength(1);
      await f.consentPush(consenting.who, false);
      expect(await f.claim()).toEqual([]);
      expect((await f.sends(b)).map((row) => row.code)).toEqual(["consent"]);
    });
  });

  describe("the center (FR-1104, FR-1824)", () => {
    it("pages newest first, marks only the caller's rows and caps the unread count at 100", async () => {
      const kind = await f.kind();
      const who = await f.newPlayer();
      const other = await f.newPlayer();
      await f.owner(
        `INSERT INTO notice (kind, player_id, audience, dedupe, expires_at, fanned_at)
         SELECT $1, $2, 'player', md5(random()::text) || g, now() + interval '1 day', now() FROM generate_series(1, 120) g`,
        [kind, who],
      );
      await f.owner(
        "INSERT INTO notification (notice_id, player_id) SELECT id, player_id FROM notice WHERE player_id = $1 ORDER BY id",
        [who],
      );
      const theirs = await f.notice(kind, { player: other });
      await f.fanOut();
      expect(await f.one({ playerId: who }, "SELECT own_unread_notifications() AS r")).toBe(100);
      const first = await f.one<Array<{ id: number; kind: string; read: boolean }>>(
        { playerId: who },
        "SELECT own_notifications(NULL, 500) AS r",
      );
      expect(first).toHaveLength(50);
      expect(first.map((row) => row.id)).toEqual(
        first.map((row) => row.id).toSorted((x, y) => y - x),
      );
      const second = await f.one<Array<{ id: number }>>(
        { playerId: who },
        "SELECT own_notifications($1, 20) AS r",
        [first.at(-1)?.id],
      );
      expect(second).toHaveLength(20);
      expect((second[0]?.id ?? 0) < (first.at(-1)?.id ?? 0)).toBe(true);
      const [theirsRow] = await f.owner<{ id: string }>(
        "SELECT id FROM notification WHERE notice_id = $1",
        [theirs],
      );
      const unread = await f.one<number>(
        { playerId: who },
        "SELECT mark_notifications_read($1::bigint[]) AS r",
        [[first[0]?.id, Number(theirsRow?.id)]],
      );
      expect(unread).toBe(100);
      expect(await f.count("notification WHERE id = $1 AND read_at IS NULL", [theirsRow?.id])).toBe(
        1,
      );
      expect(await f.one({ playerId: who }, "SELECT mark_notifications_read(NULL) AS r")).toBe(0);
      expect(
        await sqlstate(
          f.one({ playerId: who }, "SELECT mark_notifications_read('{}'::bigint[]) AS r"),
        ),
      ).toBe("PN422");
      expect(await sqlstate(f.one({}, "SELECT own_notifications(NULL, 20) AS r"))).toBe("PN401");
      expect(await f.one({ playerId: other }, "SELECT own_unread_notifications() AS r")).toBe(1);
    });

    it("renders a kind without a template as the generic text", async () => {
      const kind = await f.kind();
      const who = await f.newPlayer();
      await f.notice(kind, { player: who, params: { event: { ar: "مهرجان", en: "Fest" } } });
      await f.fanOut();
      const [row] = await f.one<Array<Parameters<typeof centerItem>[0]>>(
        { playerId: who },
        "SELECT own_notifications(NULL, 20) AS r",
      );
      expect(row === undefined ? null : centerItem(row, "ar")).toMatchObject({
        title: "مهرجان",
        body: "لديك رسالة جديدة",
        optOut: false,
        read: false,
      });
    });

    it("answers and replaces the muted topics", async () => {
      const who = await f.newPlayer();
      const all = { announcements: true, rank: true, community: true, reminders: true };
      expect(await f.one({ playerId: who }, "SELECT own_push_topics() AS r")).toEqual(all);
      expect(
        await f.one({ playerId: who }, "SELECT set_push_topics('{rank,rank,community}') AS r"),
      ).toEqual({
        ...all,
        rank: false,
        community: false,
      });
      expect(await f.one({ playerId: who }, "SELECT set_push_topics('{}') AS r")).toEqual(all);
      expect(
        await sqlstate(f.one({ playerId: who }, "SELECT set_push_topics('{offers}') AS r")),
      ).toBe("PN422");
    });
  });

  describe("erasure (plan § Review 6)", () => {
    it("deletes the player's personal notices with their center rows, sends, devices and mutes", async () => {
      const event = await f.newEvent({ phase: "live" });
      const eventKind = await f.kind({ class: "event" });
      const personal = await f.kind();
      const someone = await member(event);
      await f.one({ playerId: someone.who }, "SELECT set_push_topics('{rank}') AS r");
      const own = await f.notice(personal, { player: someone.who });
      const broadcast = await f.notice(eventKind, { event });
      await f.fanOut();
      expect(await f.erase(someone.who)).toBe("erased");
      expect(await f.count("notice WHERE id = $1", [own])).toBe(0);
      expect(await f.count("notification WHERE player_id = $1", [someone.who])).toBe(0);
      expect(await f.count("push_device WHERE player_id = $1", [someone.who])).toBe(0);
      expect(await f.count("push_topic_mute WHERE player_id = $1", [someone.who])).toBe(0);
      expect(await f.count("push_send WHERE device_id = $1", [someone.deviceId])).toBe(0);
      expect(await f.count("notice WHERE id = $1", [broadcast])).toBe(1);
    });

    it("a fan-out or a producer committed after an erasure: settle removes the orphan rows; 25 hours ago is not scanned", async () => {
      const personal = await f.kind();
      const late = await f.newPlayer();
      await f.owner(
        "UPDATE player SET status = 'deleted', username = NULL, deleted_at = now() - interval '1 hour' WHERE id = $1",
        [late],
      );
      const orphanNotice = await f.notice(personal, { player: late });
      const [stray] = await f.owner<{ id: string }>(
        `INSERT INTO notice (kind, audience, dedupe, expires_at, fanned_at) VALUES ($1, 'player', $2, now() + interval '1 day', now())
         RETURNING id`,
        [personal, randomUUID()],
      );
      await f.owner("INSERT INTO notification (notice_id, player_id) VALUES ($1, $2)", [
        stray?.id,
        late,
      ]);
      const old = await f.newPlayer();
      await f.owner(
        "UPDATE player SET status = 'deleted', username = NULL, deleted_at = now() - interval '25 hours' WHERE id = $1",
        [old],
      );
      await f.owner("INSERT INTO notification (notice_id, player_id) VALUES ($1, $2)", [
        stray?.id,
        old,
      ]);
      await f.settle();
      expect(await f.count("notice WHERE id = $1", [orphanNotice])).toBe(0);
      expect(await f.count("notification WHERE player_id = $1", [late])).toBe(0);
      expect(await f.count("notification WHERE player_id = $1", [old])).toBe(1);
    });
  });

  describe("retention (ADR-343 (8))", () => {
    it("purges old center rows, finished sends, empty old notices and dead devices, oldest first and bounded", async () => {
      const kind = await f.kind();
      const phone = await f.playerWithPhone();
      const id = await f.notice(kind, { player: phone.who });
      await f.fanOut();
      await f.owner(
        "UPDATE push_send SET state = 'sent', finished_at = now() - interval '8 days' WHERE notice_id = $1",
        [id],
      );
      await f.settle();
      expect(await f.sends(id)).toEqual([]);
      expect(await f.recipients(id)).toEqual([phone.who]);
      await f.owner(
        "UPDATE notification SET created_at = now() - interval '179 days' WHERE notice_id = $1",
        [id],
      );
      await f.owner("UPDATE notice SET created_at = now() - interval '181 days' WHERE id = $1", [
        id,
      ]);
      await f.settle();
      expect(await f.recipients(id)).toEqual([phone.who]);
      expect(await f.count("notice WHERE id = $1", [id])).toBe(1);
      await f.owner(
        "UPDATE notification SET created_at = now() - interval '181 days' WHERE notice_id = $1",
        [id],
      );
      await f.settle();
      expect(await f.recipients(id)).toEqual([]);
      expect(await f.count("notice WHERE id = $1", [id])).toBe(0);
      const invalid = await f.playerWithPhone();
      await f.owner(
        "UPDATE push_device SET invalid_at = now() - interval '8 days' WHERE family = $1",
        [invalid.family],
      );
      const signedOut = await f.playerWithPhone();
      await f.owner("SELECT revoke_family($1)", [signedOut.family]);
      const fresh = await f.playerWithPhone();
      await f.settle();
      expect(
        await f.count("push_device WHERE family = ANY ($1)", [[invalid.family, signedOut.family]]),
      ).toBe(0);
      expect(await f.count("push_device WHERE family = $1", [fresh.family])).toBe(1);
    });
  });
});
