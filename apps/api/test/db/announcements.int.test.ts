import { randomInt, randomUUID } from "node:crypto";
import { ANNOUNCEMENT_RATE } from "@questify/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Member = Readonly<{ who: string; enrollment: string; token: string; deviceId: string }>;
type Sent = Readonly<{ id: string | null; status: string; send_at: Date; replayed: boolean }>;
type Draft = Record<string, string | undefined>;

const GOOD: Draft = {
  titleAr: "الغداء جاهز",
  titleEn: "Lunch is ready",
  bodyAr: "يبدأ تقديم الغداء الآن في القاعة 2 وحتى الثالثة.",
  bodyEn: "Lunch is served now in hall 2 until three.",
  pushBodyAr: "يبدأ تقديم الغداء الآن في القاعة 2 وحتى الثالثة.",
  pushBodyEn: "Lunch is served now in hall 2 until three.",
};

/** A rehearsal's join code is unique across events: four and four characters of the code alphabet. */
function rehearsalCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from({ length: 4 }, () => alphabet.charAt(randomInt(alphabet.length))).join("");
  return `${group()}-${group()}`;
}

/** A call's SQLSTATE and detail ("PE409:event_closed"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const minutes = (count: number): Date => new Date(Date.now() + count * 60_000);

/**
 * Organizer announcements in the database (T-502, migration 0081; plan docs/plans/2026-10-28-t-502-announcements.md,
 * ADR-358): the door writes one notice through notice_create, once per Idempotency-Key, inside its own rate limit; a
 * scheduled one is re-checked when its time comes; the text is frozen; only roles that can edit the event may send; the
 * audience is T-501's rule for an event kind.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("announcements (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const send = (
    event: string,
    options: Readonly<{
      draft?: Draft | null;
      at?: Date | null;
      key?: string;
      seat?: RequestContext;
    }> = {},
  ) =>
    f.run<Sent>(
      options.seat ?? f.team(),
      "SELECT * FROM announcement_send($1, $2::jsonb, $3, $4, $5)",
      [
        event,
        JSON.stringify(options.draft ?? GOOD),
        options.at ?? null,
        options.key ?? randomUUID(),
        randomUUID(),
      ],
    );
  const cancel = (event: string, id: string, seat: RequestContext = f.team()) =>
    f.run<{ announcement_cancel: string }>(seat, "SELECT announcement_cancel($1, $2, $3)", [
      event,
      id,
      randomUUID(),
    ]);
  const preview = (event: string, seat: RequestContext = f.team()) =>
    f.run<{ members: number; phase: string }>(seat, "SELECT * FROM announcement_preview($1)", [
      event,
    ]);
  const list = async (event: string, seat: RequestContext = f.team()) =>
    (
      await f.run<{ r: Record<string, unknown>[] }>(seat, "SELECT announcement_list($1) AS r", [
        event,
      ])
    )[0]?.r ?? [];
  const mine = async (event: string, who: string) =>
    (
      await f.run<{ r: { id: string; title: { ar: string; en: string } }[] }>(
        { playerId: who },
        "SELECT member_announcements($1, 20) AS r",
        [event],
      )
    )[0]?.r ?? [];
  const rowOf = async (id: string) =>
    (await f.owner<Record<string, unknown>>("SELECT * FROM announcement WHERE id = $1", [id]))[0] ??
    {};
  const noticesOf = (event: string) =>
    f.owner<{
      id: string;
      refs: Record<string, unknown>;
      params: Record<string, Record<string, string>>;
      dedupe: string;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT id, refs, params, dedupe, expires_at, created_at FROM notice
       WHERE event_id = $1 AND kind = 'announcement' ORDER BY id`,
      [event],
    );
  const due = () => f.one<Record<string, number | boolean>>(f.system, "SELECT push_due() AS r");

  /** The row's time moved into the past (the frozen-time trigger off for the update), as if the time had come. */
  const comeDue = async (id: string, agoMinutes = 1) => {
    await f.owner("ALTER TABLE announcement DISABLE TRIGGER announcement_frozen");
    try {
      await f.owner(
        "UPDATE announcement SET send_at = now() - make_interval(mins => $2) WHERE id = $1",
        [id, agoMinutes],
      );
    } finally {
      await f.owner("ALTER TABLE announcement ENABLE TRIGGER announcement_frozen");
    }
  };
  const setEvent = (event: string, set: string) =>
    f.owner(`UPDATE event SET ${set} WHERE id = $1`, [event]);

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
  /** The other organizer's owner, made once (an organizer has one owner). */
  let outsider: string | undefined;
  const outsiderOwner = async (): Promise<string> =>
    (outsider ??= await addMember(f.db.owner, f.ids.orgB, "owner"));
  const openRehearsal = (event: string) =>
    f.owner(
      `INSERT INTO event_rehearsal (event_id, organizer_id, code)
       SELECT id, organizer_id, $2 FROM event WHERE id = $1`,
      [event, rehearsalCode()],
    );
  /** A live event with one real member, so a send now has someone to tell. */
  const liveEvent = async () => {
    const event = await f.newEvent({ phase: "live" });
    await member(event);
    return event;
  };

  // ------------------------------------------------------------------ the kind
  describe("the kind", () => {
    it("is an event kind on the announcements topic, 2 hours, pushed to active members", async () => {
      const [kind] = await f.owner<Record<string, unknown>>(
        "SELECT class, topic, membership, before_start, priority, ttl::text FROM notice_kind WHERE kind = 'announcement'",
      );
      expect(kind).toEqual({
        class: "event",
        topic: "announcements",
        membership: "active",
        before_start: false,
        priority: 1,
        ttl: "02:00:00",
      });
    });
  });

  // ------------------------------------------------------------------ send now
  describe("send now", () => {
    it("writes one notice with the frozen title and cut text, and tells the members the fan-out tells", async () => {
      await f.drain();
      const event = await liveEvent();
      const { id, status } = (await send(event))[0] as Sent;
      expect(status).toBe("sent");
      const notices = await noticesOf(event);
      expect(notices).toHaveLength(1);
      const notice = notices[0] as (typeof notices)[number];
      expect(notice.dedupe).toBe(`announcement:${id}`);
      expect(notice.refs).toEqual({ announcement: id });
      expect(notice.params["title"]).toEqual({ ar: GOOD["titleAr"], en: GOOD["titleEn"] });
      expect(notice.params["body"]).toEqual({ ar: GOOD["pushBodyAr"], en: GOOD["pushBodyEn"] });
      expect(Object.keys(notice.params).toSorted()).toEqual(["body", "event", "title"]);
      expect(notice.expires_at.getTime() - notice.created_at.getTime()).toBeLessThanOrEqual(
        2 * 3600 * 1000,
      );
      const row = await rowOf(id as string);
      expect(row).toMatchObject({ status: "sent", rehearsal: false, notice_id: notice.id });
    });

    it("tells exactly the active real members: the count, the center rows and the sends agree", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const real = await member(event);
      const muted = await member(event);
      await f.owner("INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, 'announcements')", [
        muted.who,
      ]);
      const deviceless = await f.newPlayer();
      await f.join(event, deviceless);
      const operator = await member(event);
      await f.owner(
        `INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play)
         SELECT organizer_id, id, $2, false FROM event WHERE id = $1`,
        [event, operator.who],
      );
      const others = [
        await member(event, { status: "left" }),
        await member(event, { status: "banned" }),
        await member(event, { status: "pending" }),
        await member(event, { status: "declined" }),
        await member(event, { via: "rehearsal" }),
      ];
      const barred = await member(event);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [barred.who]);
      const erased = await member(event);
      expect(await f.erase(erased.who)).toBe("erased");
      const byPhone = await member(event);
      const byDomain = await member(event);
      const phone = `+9665${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
      await f.owner(
        `INSERT INTO event_exclusion (organizer_id, event_id, kind, value)
         SELECT organizer_id, id, entry.kind, entry.value
         FROM event, (VALUES ('email_domain', 'excluded.test'), ('phone', $2)) AS entry (kind, value)
         WHERE id = $1`,
        [event, phone],
      );
      await f.owner("UPDATE player_contact SET phone_e164 = $2 WHERE player_id = $1", [
        byPhone.who,
        phone,
      ]);
      await f.owner("UPDATE player_contact SET email = 'who@excluded.test' WHERE player_id = $1", [
        byDomain.who,
      ]);
      // Another organizer's live event with members of its own: nothing crosses.
      const elsewhere = await f.newEvent({ phase: "live", organizer: f.ids.orgB });
      const stranger = await member(elsewhere);

      const told = [real.who, muted.who, deviceless, operator.who].toSorted();
      expect((await preview(event))[0]).toEqual({ members: told.length, phase: "live" });
      await send(event);
      await f.fanOut();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual(told);
      for (const one of [...others, barred, erased, byPhone, byDomain, stranger]) {
        expect(await f.recipients(notice?.id ?? null), one.who).not.toContain(one.who);
      }
      // A muted topic keeps the center row and loses the push; the operator is told as anyone.
      await f.claim();
      expect((await f.sends(notice?.id ?? null)).map((row) => row.device_id).toSorted()).toEqual(
        [real.deviceId, operator.deviceId].toSorted(),
      );
      expect(await f.count("notification WHERE player_id = $1", [muted.who])).toBe(1);
    });

    it("tells a draft or scheduled event's rehearsal accounts only, and flags the row", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "scheduled" });
      const real = await member(event);
      const rehearsing = await member(event, { via: "rehearsal" });
      expect((await preview(event))[0]).toEqual({ members: 0, phase: "idle" });
      expect(await refusal(send(event))).toBe("PE409:event_not_live");
      await openRehearsal(event);
      expect((await preview(event))[0]).toEqual({ members: 1, phase: "rehearsal" });
      const { id } = (await send(event))[0] as Sent;
      await f.fanOut();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual([rehearsing.who]);
      expect(await rowOf(id as string)).toMatchObject({ rehearsal: true, status: "sent" });
      // The Home list shows it to the rehearsal account only.
      expect((await mine(event, rehearsing.who)).map((one) => one.id)).toEqual([id]);
      expect(await mine(event, real.who)).toEqual([]);
    });

    it("refuses a send that would tell no one, after the replay check", async () => {
      const event = await f.newEvent({ phase: "live" });
      expect(await refusal(send(event))).toBe("PT409:nobody");
      expect(await noticesOf(event)).toHaveLength(0);
      await member(event);
      const key = randomUUID();
      const first = (await send(event, { key }))[0] as Sent;
      await f.owner("UPDATE enrollment SET status = 'left' WHERE event_id = $1", [event]);
      expect((await send(event, { key }))[0]).toMatchObject({ id: first.id, replayed: true });
    });

    it("refuses an ended or archived event, and writes nothing", async () => {
      for (const phase of ["ended", "archived"] as const) {
        const event = await f.newEvent({ phase });
        await member(event);
        expect(await refusal(send(event)), phase).toBe("PE409:event_closed");
        expect(await refusal(send(event, { at: minutes(30) })), phase).toBe("PE409:event_closed");
        expect(await noticesOf(event)).toHaveLength(0);
        expect(await f.count("announcement WHERE event_id = $1", [event])).toBe(0);
      }
    });
  });

  // ------------------------------------------------------------------ once per key
  describe("one send per Idempotency-Key", () => {
    it("answers the first result again and writes nothing more", async () => {
      const event = await liveEvent();
      const key = randomUUID();
      const first = (await send(event, { key }))[0] as Sent;
      const again = (await send(event, { key }))[0] as Sent;
      expect(again).toMatchObject({ id: first.id, status: "sent", replayed: true });
      expect(await noticesOf(event)).toHaveLength(1);
      expect(await f.count("announcement WHERE event_id = $1", [event])).toBe(1);
      expect(
        await f.count("audit_log WHERE event_id = $1 AND action = 'announcement.send'", [event]),
      ).toBe(1);
    });

    it("two presses at once with one key are one announcement", async () => {
      const event = await liveEvent();
      const key = randomUUID();
      const results = await Promise.all([send(event, { key }), send(event, { key })]);
      const ids = results.map((rows) => rows[0]?.id);
      expect(ids[0]).toBe(ids[1]);
      expect(results.map((rows) => rows[0]?.replayed).toSorted()).toEqual([false, true]);
      expect(await noticesOf(event)).toHaveLength(1);
    });

    it("a key is the event's own: the same key on another event is a new send", async () => {
      const first = await liveEvent();
      const second = await liveEvent();
      const key = randomUUID();
      const one = (await send(first, { key }))[0] as Sent;
      const two = (await send(second, { key }))[0] as Sent;
      expect(two.replayed).toBe(false);
      expect(two.id).not.toBe(one.id);
    });

    it("needs a key of 1 to 255 characters", async () => {
      const event = await liveEvent();
      expect(await refusal(send(event, { key: "" }))).toBe("PK400");
      expect(await refusal(send(event, { key: "k".repeat(256) }))).toBe("PK400");
      expect((await send(event, { key: "k".repeat(255) }))[0]?.replayed).toBe(false);
    });
  });

  // ------------------------------------------------------------------ the door's own rate limit
  describe("the rate limit", () => {
    it("is 3 an hour and 10 a day, as the shared constants say", () => {
      expect(ANNOUNCEMENT_RATE).toEqual({ perHour: 3, perDay: 10 });
    });

    it("refuses the fourth send in an hour, and counts nothing it refused", async () => {
      const event = await liveEvent();
      for (let sent = 0; sent < 3; sent += 1) {
        expect((await send(event))[0]?.status).toBe("sent");
      }
      expect(await refusal(send(event))).toBe("PL429:hour");
      expect(await refusal(send(event, { at: minutes(30) }))).toBe("PL429:hour");
      expect(await noticesOf(event)).toHaveLength(3);
      expect(await f.count("announcement WHERE event_id = $1", [event])).toBe(3);
    });

    it("lets a send through once the first has left the hour", async () => {
      const event = await liveEvent();
      const ids: string[] = [];
      for (let sent = 0; sent < 3; sent += 1) {
        ids.push(((await send(event))[0] as Sent).id as string);
      }
      await f.owner("ALTER TABLE announcement DISABLE TRIGGER announcement_frozen");
      await f.owner(
        "UPDATE announcement SET send_at = now() - interval '61 minutes' WHERE id = $1",
        [ids[0]],
      );
      await f.owner("ALTER TABLE announcement ENABLE TRIGGER announcement_frozen");
      expect((await send(event))[0]?.status).toBe("sent");
      expect(await refusal(send(event))).toBe("PL429:hour");
    });

    it("counts scheduled ones on their own time: a later send that would crowd them is refused", async () => {
      const event = await liveEvent();
      for (const ahead of [300, 310, 320]) {
        expect((await send(event, { at: minutes(ahead) }))[0]?.status).toBe("scheduled");
      }
      // Now is far from them: allowed. 30 minutes after the first is inside their hour: the fourth in a window.
      expect((await send(event))[0]?.status).toBe("sent");
      expect(await refusal(send(event, { at: minutes(330) }))).toBe("PL429:hour");
      expect(await refusal(send(event, { at: minutes(290) }))).toBe("PL429:hour");
      // Two hours clear of the three is free.
      expect((await send(event, { at: minutes(480) }))[0]?.status).toBe("scheduled");
    });

    it("sees a window that opens at an existing send, not only at the new one", async () => {
      const event = await liveEvent();
      // Sends at 55, 56 and 57 minutes from now. A fourth at 100 is alone in the hour that starts at itself, but the hour
      // that starts at 55 holds all four; so does 114 (inside [55, 115)). 115 is the first moment that hour lets go of.
      for (const ahead of [55, 56, 57]) {
        await send(event, { at: minutes(ahead) });
      }
      expect(await refusal(send(event, { at: minutes(100) }))).toBe("PL429:hour");
      expect(await refusal(send(event, { at: minutes(114) }))).toBe("PL429:hour");
      expect((await send(event, { at: minutes(116) }))[0]?.status).toBe("scheduled");
    });

    it("refuses the eleventh send in a day, and a cancelled one does not count", async () => {
      const event = await liveEvent();
      const ids: string[] = [];
      for (let slot = 0; slot < 10; slot += 1) {
        // Two hours apart, so the hourly limit never speaks.
        ids.push(((await send(event, { at: minutes(10 + slot * 130) }))[0] as Sent).id as string);
      }
      // All ten sit inside one rolling day (the first and the last are 1,170 minutes apart): an eleventh between them is
      // refused by the day, not the hour. Cancelling one frees the place; a send more than a day after the first is
      // free from the start.
      expect(await refusal(send(event, { at: minutes(700) }))).toBe("PL429:day");
      await cancel(event, ids[0] as string);
      expect(await refusal(send(event, { at: minutes(700) }))).toBe("none");
      expect(await refusal(send(event, { at: minutes(700 + 1440) }))).toBe("none");
    });

    it("is per event: another event of the same organizer sends freely", async () => {
      const busy = await liveEvent();
      const quiet = await liveEvent();
      for (let sent = 0; sent < 3; sent += 1) await send(busy);
      expect(await refusal(send(busy))).toBe("PL429:hour");
      expect((await send(quiet))[0]?.status).toBe("sent");
    });

    it("lets two presses racing for the last slot through once", async () => {
      const event = await liveEvent();
      await send(event);
      await send(event);
      const raced = await Promise.all([refusal(send(event)), refusal(send(event))]);
      expect(raced.toSorted()).toEqual(["PL429:hour", "none"]);
      expect(await f.count("announcement WHERE event_id = $1", [event])).toBe(3);
    });

    it("answers a replay before it looks at the limit", async () => {
      const event = await liveEvent();
      const key = randomUUID();
      await send(event, { key });
      await send(event);
      await send(event);
      expect(await refusal(send(event))).toBe("PL429:hour");
      expect((await send(event, { key }))[0]?.replayed).toBe(true);
    });
  });

  // ------------------------------------------------------------------ scheduling
  describe("scheduling", () => {
    it("stores the announcement without a notice and answers it scheduled", async () => {
      const event = await liveEvent();
      const at = minutes(45);
      const result = (await send(event, { at }))[0] as Sent;
      expect(result).toMatchObject({ status: "scheduled", replayed: false });
      expect(result.send_at.getTime()).toBe(at.getTime());
      expect(await noticesOf(event)).toHaveLength(0);
      expect(await rowOf(result.id as string)).toMatchObject({
        status: "scheduled",
        notice_id: null,
        sent_at: null,
      });
    });

    it("takes a time 2 minutes to 180 days ahead, after the event's start and before its end", async () => {
      const event = await liveEvent();
      expect(await refusal(send(event, { at: minutes(1) }))).toBe("PA422:sendAt:past");
      expect(await refusal(send(event, { at: new Date(Date.now() - 3600_000) }))).toBe(
        "PA422:sendAt:past",
      );
      expect(await refusal(send(event, { at: minutes(181 * 24 * 60) }))).toBe(
        "PA422:sendAt:too_far",
      );
      // The live fixture ends in three days.
      expect(await refusal(send(event, { at: minutes(4 * 24 * 60) }))).toBe(
        "PA422:sendAt:after_end",
      );
      const later = await f.newEvent({ phase: "scheduled" });
      expect(await refusal(send(later, { at: minutes(60) }))).toBe("PA422:sendAt:before_start");
      expect(await refusal(send(later, { at: minutes(25 * 60) }))).toBe("none");
    });

    it("sends at its time to the members of that moment, with the text frozen at creation", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const early = await member(event);
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      const late = await member(event);
      await due();
      expect(await noticesOf(event)).toHaveLength(0);
      await comeDue(id as string);
      expect(await due()).toMatchObject({ announcement: 1 });
      await f.fanOut();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual([early.who, late.who].toSorted());
      expect(await rowOf(id as string)).toMatchObject({
        status: "sent",
        rehearsal: false,
        notice_id: notice?.id,
      });
      expect(notice?.params["title"]).toEqual({ ar: GOOD["titleAr"], en: GOOD["titleEn"] });
      expect(
        await f.count("audit_log WHERE target_id = $1 AND action = 'announcement.release'", [id]),
      ).toBe(1);
      // A second run writes nothing more.
      expect(await due()).toMatchObject({ announcement: 0 });
      expect(await noticesOf(event)).toHaveLength(1);
    });

    it("is not sent before its time", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(3) }))[0] as Sent;
      expect(await due()).toMatchObject({ announcement: 0 });
      expect(await rowOf(id as string)).toMatchObject({ status: "scheduled" });
    });

    it("is skipped when the event has ended or been archived by then", async () => {
      for (const set of ["ends_at = now() - interval '1 minute'", "status = 'archived'"]) {
        const event = await liveEvent();
        const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
        await setEvent(event, set);
        await comeDue(id as string);
        await due();
        expect(await rowOf(id as string), set).toMatchObject({
          status: "skipped",
          skip_reason: "event_closed",
        });
        expect(await noticesOf(event)).toHaveLength(0);
      }
    });

    it("is skipped when the event has not started by its time", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      const { id } = (await send(event, { at: minutes(26 * 60) }))[0] as Sent;
      await comeDue(id as string);
      await due();
      expect(await rowOf(id as string)).toMatchObject({
        status: "skipped",
        skip_reason: "not_live",
      });
      expect(await noticesOf(event)).toHaveLength(0);
    });

    it("is skipped when it is more than 30 minutes late, and still sent at 29", async () => {
      const event = await liveEvent();
      const stale = ((await send(event, { at: minutes(30) }))[0] as Sent).id as string;
      const fresh = ((await send(event, { at: minutes(300) }))[0] as Sent).id as string;
      await comeDue(stale, 31);
      await comeDue(fresh, 29);
      await due();
      expect(await rowOf(stale)).toMatchObject({ status: "skipped", skip_reason: "late" });
      expect(await rowOf(fresh)).toMatchObject({ status: "sent" });
      expect(await noticesOf(event)).toHaveLength(1);
    });

    it("waits for the next tick when the kind row is missing, and writes nothing", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      await comeDue(id as string);
      await f.withoutKind("announcement", async () => {
        expect(await due()).toMatchObject({ announcement: 0 });
      });
      expect(await rowOf(id as string)).toMatchObject({ status: "scheduled" });
      expect(await noticesOf(event)).toHaveLength(0);
      expect(await due()).toMatchObject({ announcement: 1 });
    });

    it("a due scan that finds a cancel in flight leaves the row alone", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      await comeDue(id as string);
      const release = await holdRow(id as string);
      try {
        expect(await due()).toMatchObject({ announcement: 0 });
      } finally {
        await release();
      }
      expect(await rowOf(id as string)).toMatchObject({ status: "scheduled" });
    });
  });

  // ------------------------------------------------------------------ cancel
  describe("cancel", () => {
    it("stops a scheduled announcement before it goes out, audited, and the scan skips it", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      expect((await cancel(event, id as string))[0]?.announcement_cancel).toBe("cancelled");
      expect(await rowOf(id as string)).toMatchObject({ status: "cancelled" });
      await comeDue(id as string);
      await due();
      expect(await noticesOf(event)).toHaveLength(0);
      expect(
        await f.count("audit_log WHERE target_id = $1 AND action = 'announcement.cancel'", [id]),
      ).toBe(1);
      // Cancelling again is quiet.
      expect((await cancel(event, id as string))[0]?.announcement_cancel).toBe("cancelled");
      expect(
        await f.count("audit_log WHERE target_id = $1 AND action = 'announcement.cancel'", [id]),
      ).toBe(1);
    });

    it("refuses one that has gone out, was skipped, or belongs to another event", async () => {
      const event = await liveEvent();
      const sentNow = ((await send(event))[0] as Sent).id as string;
      expect(await refusal(cancel(event, sentNow))).toBe("PA409:sent");
      const skipped = ((await send(event, { at: minutes(30) }))[0] as Sent).id as string;
      await setEvent(event, "status = 'archived'");
      await comeDue(skipped);
      await due();
      expect(await refusal(cancel(event, skipped))).toBe("PA409:skipped");
      const other = await liveEvent();
      expect(await refusal(cancel(other, sentNow))).toBe("AN404");
      expect(await refusal(cancel(event, randomUUID()))).toBe("AN404");
    });

    it("races the due scan: exactly one of them wins", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      await comeDue(id as string);
      const [cancelled, scanned] = await Promise.allSettled([cancel(event, id as string), due()]);
      expect(scanned.status).toBe("fulfilled");
      const row = await rowOf(id as string);
      if (row["status"] === "cancelled") {
        expect(cancelled.status).toBe("fulfilled");
        expect(await noticesOf(event)).toHaveLength(0);
      } else {
        // The scan took the row first: it is sent, and the cancel was refused.
        expect(row["status"]).toBe("sent");
        expect(cancelled.status).toBe("rejected");
        expect(await noticesOf(event)).toHaveLength(1);
      }
    });
  });

  // ------------------------------------------------------------------ the text is frozen
  describe("the text is frozen", () => {
    it("refuses any change of the text, the time, the key or the event, even as the owner", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      for (const set of [
        "title_en = 'Changed'",
        "title_ar = 'تغيير'",
        "body_en = 'Changed'",
        "body_ar = 'تغيير'",
        "push_body_en = 'Changed'",
        "push_body_ar = 'تغيير'",
        "send_at = send_at + interval '1 hour'",
        "press = repeat('a', 64)",
        "event_id = gen_random_uuid()",
      ]) {
        expect(
          await refusal(f.owner(`UPDATE announcement SET ${set} WHERE id = $1`, [id])),
          set,
        ).toBe("PA409:frozen");
      }
      expect(await rowOf(id as string)).toMatchObject({
        title_en: GOOD["titleEn"],
        body_en: GOOD["bodyEn"],
      });
    });

    it("lets a scheduled row change state once, and no finished row change again", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      await cancel(event, id as string);
      expect(
        await refusal(
          f.owner(
            "UPDATE announcement SET status = 'scheduled', cancelled_at = NULL WHERE id = $1",
            [id],
          ),
        ),
      ).toBe("PA409:finished");
    });

    it("keeps the notice's copy when the row is the only place the text was", async () => {
      const event = await liveEvent();
      await send(event, { draft: { ...GOOD, titleEn: "Frozen at send" } });
      const [notice] = await noticesOf(event);
      expect(notice?.params["title"]?.["en"]).toBe("Frozen at send");
    });
  });

  // ------------------------------------------------------------------ bounds the door keeps
  describe("the door's own bounds", () => {
    it("refuses a missing, empty, over-long or control-character field with the field's name", async () => {
      const event = await liveEvent();
      const cases: [Draft, string][] = [
        [{ ...GOOD, titleAr: undefined }, "titleAr"],
        [{ ...GOOD, titleEn: "" }, "titleEn"],
        [{ ...GOOD, bodyAr: "ب".repeat(501) }, "bodyAr"],
        [{ ...GOOD, bodyEn: "a".repeat(501) }, "bodyEn"],
        [{ ...GOOD, titleEn: "a".repeat(61) }, "titleEn"],
        [{ ...GOOD, pushBodyEn: "a".repeat(141) }, "pushBodyEn"],
        [{ ...GOOD, pushBodyAr: undefined }, "pushBodyAr"],
        [{ ...GOOD, bodyEn: "line\nbreak" }, "bodyEn"],
        [{ ...GOOD, titleEn: "bell\u0007" }, "titleEn"],
      ];
      for (const [draft, field] of cases) {
        expect(await refusal(send(event, { draft })), field).toBe(`PA422:${field}`);
      }
      expect(await noticesOf(event)).toHaveLength(0);
    });

    it("takes the limits exactly: 60, 500 and 140 code points", async () => {
      const event = await liveEvent();
      const edge: Draft = {
        titleAr: "ب".repeat(60),
        titleEn: "🎉".repeat(60),
        bodyAr: "ب".repeat(500),
        bodyEn: "🎉".repeat(500),
        pushBodyAr: "ب".repeat(140),
        pushBodyEn: "🎉".repeat(140),
      };
      expect(await refusal(send(event, { draft: edge }))).toBe("none");
    });

    it("refuses a draft that is not an object", async () => {
      const event = await liveEvent();
      for (const draft of ["null", "[]", '"text"']) {
        const work = f.run(
          f.team(),
          "SELECT * FROM announcement_send($1, $2::jsonb, NULL, $3, $4)",
          [event, draft, randomUUID(), randomUUID()],
        );
        expect(await refusal(work), draft).toMatch(/^PA422:/);
      }
    });
  });

  // ------------------------------------------------------------------ who may send
  describe("roles", () => {
    it("lets an owner and an editor send, and refuses everyone else", async () => {
      const event = await liveEvent();
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      expect((await send(event, { seat: f.team(editor) }))[0]?.status).toBe("sent");
      const outsideOwner = await outsiderOwner();
      for (const seat of [
        f.team(outsideOwner, f.ids.orgB),
        { playerId: await f.newPlayer() },
        {},
      ] as RequestContext[]) {
        expect(await refusal(send(event, { seat }))).toMatch(/^(AN404|42501)$/);
        expect(await refusal(preview(event, seat))).toMatch(/^(AN404|42501)$/);
        expect(await refusal(list(event, seat))).toMatch(/^(AN404|42501)$/);
      }
      // The event limit: an editor scoped to another event cannot send, preview or list here.
      const elsewhere = await f.newEvent({ phase: "live" });
      const limited = f.team(await addMember(f.db.owner, f.ids.orgA, "editor", [elsewhere]));
      expect(await refusal(send(event, { seat: limited }))).toBe("AN404");
      expect(await refusal(preview(event, limited))).toBe("AN404");
      expect(await refusal(list(event, limited))).toBe("AN404");
      expect(await noticesOf(event)).toHaveLength(1);
    });

    it("keeps an organizer's announcements out of another organizer's reach", async () => {
      const event = await liveEvent();
      const { id } = (await send(event, { at: minutes(30) }))[0] as Sent;
      const outsideOwner = await outsiderOwner();
      const seat = f.team(outsideOwner, f.ids.orgB);
      expect(await refusal(cancel(event, id as string, seat))).toBe("AN404");
      expect(await refusal(list(event, seat))).toBe("AN404");
      expect(await rowOf(id as string)).toMatchObject({ status: "scheduled" });
    });
  });

  // ------------------------------------------------------------------ the dashboard's list
  describe("the list", () => {
    it("shows every state, newest send time first, with a rounded count for a sent one", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      for (let at = 0; at < 14; at += 1) await member(event);
      const sentNow = ((await send(event))[0] as Sent).id as string;
      const scheduled = ((await send(event, { at: minutes(600) }))[0] as Sent).id as string;
      const cancelled = ((await send(event, { at: minutes(700) }))[0] as Sent).id as string;
      await cancel(event, cancelled);
      const rows = await list(event);
      expect(rows.map((row) => row["id"])).toEqual([cancelled, scheduled, sentNow]);
      const sent = rows.find((row) => row["id"] === sentNow);
      expect(sent).toMatchObject({
        status: "sent",
        delivering: true,
        delivered: 0,
        rehearsal: false,
      });
      await f.fanOut();
      const done = (await list(event)).find((row) => row["id"] === sentNow);
      expect(done).toMatchObject({ delivering: false, delivered: 10 });
      expect(rows.find((row) => row["id"] === scheduled)).toMatchObject({
        status: "scheduled",
        delivered: null,
        sentAt: null,
      });
    });

    it("rounds: exact below 10, the nearest 10 above", async () => {
      await f.drain();
      const small = await f.newEvent({ phase: "live" });
      for (let at = 0; at < 7; at += 1) await member(small);
      await send(small);
      await f.fanOut();
      expect((await list(small))[0]).toMatchObject({ delivered: 7 });
      const big = await f.newEvent({ phase: "live" });
      for (let at = 0; at < 26; at += 1) await member(big);
      await send(big);
      await f.fanOut();
      expect((await list(big))[0]).toMatchObject({ delivered: 30 });
    });

    it("has no number once the notice is purged, and names no player", async () => {
      const event = await liveEvent();
      const { id } = (await send(event))[0] as Sent;
      await f.fanOut();
      await f.owner("DELETE FROM notice WHERE event_id = $1", [event]);
      const [row] = await list(event);
      expect(row).toMatchObject({ id, status: "sent", delivered: null, delivering: false });
      expect(Object.keys(row ?? {}).toSorted()).toEqual(
        [
          "bodyAr",
          "bodyEn",
          "delivered",
          "delivering",
          "id",
          "rehearsal",
          "sendAt",
          "sentAt",
          "skipReason",
          "status",
          "titleAr",
          "titleEn",
        ].toSorted(),
      );
    });
  });

  // ------------------------------------------------------------------ the player's list
  describe("the member's list", () => {
    it("shows the event's sent announcements to its active members, newest first, in both languages", async () => {
      const event = await f.newEvent({ phase: "live" });
      const reader = await member(event);
      const first = ((await send(event, { draft: { ...GOOD, titleEn: "First" } }))[0] as Sent).id;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = ((await send(event, { draft: { ...GOOD, titleEn: "Second" } }))[0] as Sent).id;
      await send(event, { at: minutes(300) });
      const rows = await mine(event, reader.who);
      expect(rows.map((row) => row.id)).toEqual([second, first]);
      expect(rows[0]).toMatchObject({
        title: { ar: GOOD["titleAr"], en: "Second" },
        body: { ar: GOOD["bodyAr"], en: GOOD["bodyEn"] },
      });
    });

    it("is shown to active members only, and only for their own event", async () => {
      const event = await liveEvent();
      await send(event);
      const other = await liveEvent();
      const strangers = [
        await member(event, { status: "pending" }),
        await member(event, { status: "left" }),
        await member(event, { status: "banned" }),
        await member(other),
        await member(event, { via: "code" }),
      ];
      const failures: string[] = [];
      for (const who of strangers.slice(0, 4)) {
        failures.push(await refusal(mine(event, who.who)));
      }
      expect(failures).toEqual(["AM403", "AM403", "AM403", "AM403"]);
      expect(await mine(event, strangers[4]?.who ?? "")).toHaveLength(1);
      expect(await refusal(mine(event, randomUUID()))).toBe("AM403");
      await setEvent(event, "status = 'archived'");
      expect(await refusal(mine(event, strangers[4]?.who ?? ""))).toBe("AM403");
    });

    it("never shows a staff seat or a device seat the list", async () => {
      const event = await liveEvent();
      await send(event);
      expect(await refusal(f.run(f.team(), "SELECT member_announcements($1, 20)", [event]))).toBe(
        "AM403",
      );
    });
  });

  // ------------------------------------------------------------------ muted topic, no email or SMS
  describe("channels", () => {
    it("gives a member who muted announcements the center row and no push", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const heard = await member(event);
      const muted = await member(event);
      await f.owner("INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, 'announcements')", [
        muted.who,
      ]);
      await send(event);
      await f.fanOut();
      await f.claim();
      const [notice] = await noticesOf(event);
      expect(await f.recipients(notice?.id ?? null)).toEqual([heard.who, muted.who].toSorted());
      expect((await f.sends(notice?.id ?? null)).map((row) => row.device_id)).toEqual([
        heard.deviceId,
      ]);
    });

    it("writes only announcement, notice, notification, push_send and audit rows: no email or SMS path", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const reader = await member(event);
      // A player with a phone, an email and consent to everything: still only the push store hears of it.
      await f.owner("UPDATE player SET birth_year = 1990 WHERE id = $1", [reader.who]);
      await f.owner("UPDATE player_contact SET phone_e164 = '+966555550000' WHERE player_id = $1", [
        reader.who,
      ]);
      await f.consentPush(reader.who);
      const before = await tableCounts();
      await send(event);
      await send(event, { at: minutes(30) });
      await f.fanOut();
      await f.claim();
      await due();
      const after = await tableCounts();
      const changed = Object.keys(after)
        .filter((table) => after[table] !== before[table])
        .toSorted();
      expect(changed).toEqual(["announcement", "audit_log", "notice", "notification", "push_send"]);
    });

    it("has functions that name no sender, contact or consent", async () => {
      const sources = await f.owner<{ proname: string; prosrc: string }>(
        `SELECT proname, prosrc FROM pg_proc
         WHERE proname LIKE 'announcement\\_%' OR proname IN ('member_announcements', 'push_due_announcement')`,
      );
      expect(sources.length).toBeGreaterThanOrEqual(9);
      for (const { proname, prosrc } of sources) {
        expect(prosrc, proname).not.toMatch(
          /invitation|sms|msegat|smtp|gmail|outbound|marketing|consent|promo/i,
        );
      }
    });
  });

  /** The row count of every table in the public schema. */
  async function tableCounts(): Promise<Record<string, number>> {
    const tables = await f.owner<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    );
    const counts: Record<string, number> = {};
    for (const { relname } of tables) {
      counts[relname] = await f.count(`"${relname}"`);
    }
    return counts;
  }

  /** Holds a row `FOR UPDATE` in another transaction, as a cancel in flight does; answers the release. */
  async function holdRow(id: string): Promise<() => Promise<void>> {
    const url = new URL(f.db.appUrl);
    const base = new URL(TEST_DATABASE_URL as string);
    url.username = base.username;
    url.password = base.password;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query("BEGIN");
    await client.query("SELECT 1 FROM announcement WHERE id = $1 FOR UPDATE", [id]);
    return async () => {
      await client.query("ROLLBACK");
      await client.end();
    };
  }
});
