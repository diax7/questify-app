import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushMessageOf, type ClaimedSend } from "#src/push/message";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type NoticeRow = {
  id: string;
  kind: string;
  event_id: string | null;
  player_id: string | null;
  refs: Record<string, unknown>;
  params: Record<string, unknown>;
  dedupe: string;
  expires_at: Date;
};
type Phone = Awaited<ReturnType<PushFixture["playerWithPhone"]>>;

const DAY_MS = 24 * 3600_000;
/** Today's date in Riyadh, `days` later; at 18:00 and after, it is also the Questify day (04:00 to 04:00). */
const riyadhDate = (days = 0): string =>
  new Date(Date.now() + 3 * 3600_000 + days * DAY_MS).toISOString().slice(0, 10);
/** A moment today in Riyadh. */
const riyadhAt = (time: string): Date => new Date(`${riyadhDate()}T${time}+03:00`);

/**
 * The reminder pushes in the database (T-501f, migration 0079; plan docs/plans/2026-10-28-t-501f-reminders-promotion.md):
 * the daily streak reminder (from 18:00 Riyadh, a streak of 2 or more, nothing played today) and the shop's closing
 * (the day before the window closes, members with a balance), each once and only once, to the right players and no one
 * else; what changed is checked again at sending; a broken kind never rolls the scan back.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("reminder pushes (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const due = () => f.one<Record<string, number | boolean>>(f.system, "SELECT push_due() AS r");
  const kindNotices = (column: "player_id" | "event_id", id: string, kind: string) =>
    f.owner<NoticeRow>(
      `SELECT id, kind, event_id, player_id, refs, params, dedupe, expires_at FROM notice
       WHERE ${column} = $1 AND kind = $2 ORDER BY id`,
      [id, kind],
    );
  const sendsOf = async (notices: readonly NoticeRow[]) =>
    (await f.sends()).filter((send) => notices.some((notice) => notice.id === send.notice_id));

  const scan = async (time = "18:30:00"): Promise<number> =>
    (await f.owner<{ n: number }>("SELECT push_due_streak(500, $1) AS n", [riyadhAt(time)]))[0]
      ?.n ?? 0;
  const remindersOf = (who: string) => kindNotices("player_id", who, "streak_reminder");
  /** A player with a phone and Questify streak days `ago` days before today. */
  const streaker = async (ago: readonly number[] = [1, 2], phone?: Phone) => {
    const made = phone ?? (await f.playerWithPhone());
    for (const days of ago) {
      await f.owner(
        "INSERT INTO questify_streak_day (player_id, day) VALUES ($1, $2::date - $3::int)",
        [made.who, riyadhDate(), days],
      );
    }
    return made;
  };

  const shopNotices = (event: string) => kindNotices("event_id", event, "shop_closing");
  /** A member with a phone, with a balance of 10 unless `broke`. */
  const member = async (
    event: string,
    options: Readonly<{ via?: string; broke?: boolean }> = {},
  ) => {
    const phone = await f.playerWithPhone();
    const enrollment = await f.join(event, phone.who, options.via ?? "code");
    if (options.broke !== true) await f.earn(event, enrollment);
    return { ...phone, enrollment };
  };
  /** Ends a live event `ago` back with a shop window of `days` (both in one write: the window guard allows it). */
  const end = (event: string, ago: string, days: number) =>
    f.owner(
      `UPDATE event SET starts_at = now() - $2::interval - interval '1 day', ends_at = now() - $2::interval,
                        shop_days_after = $3
       WHERE id = $1`,
      [event, ago, days],
    );

  describe("the daily streak reminder (FR-1102, ADR-300)", () => {
    it("reminds once a day, from 18:00 Riyadh, a player with a streak of 2 or more and nothing played today", async () => {
      const kept = await streaker([1, 2, 3]);
      const one = await streaker([1]);
      const played = await streaker([0, 1, 2]);
      const gap = await streaker([1, 3]);
      await f.drain();
      await scan("17:59:00");
      expect(await remindersOf(kept.who)).toEqual([]);
      await scan();
      await scan("23:59:00");
      const [reminder, ...more] = await remindersOf(kept.who);
      expect(more).toEqual([]);
      expect(reminder).toMatchObject({
        event_id: null,
        refs: {},
        params: {},
        dedupe: `streak:${kept.who}:${riyadhDate()}`,
      });
      const midnight = new Date(`${riyadhDate(1)}T00:00:00+03:00`);
      expect(reminder?.expires_at.getTime()).toBeLessThanOrEqual(midnight.getTime());
      for (const other of [one, played, gap]) expect(await remindersOf(other.who)).toEqual([]);
      await f.fanOut();
      expect(await f.recipients(reminder?.id ?? null)).toEqual([kept.who]);
      const claimed = (await f.claim()) as unknown as ClaimedSend[];
      const mine = claimed.filter((row) => row.kind === "streak_reminder");
      expect(mine.map((row) => row.token)).toEqual([kept.token]);
      const message = mine[0] === undefined ? null : pushMessageOf(mine[0]);
      expect(message).toMatchObject({
        title: "Questify",
        body: "يمكنك مواصلة سلسلتك اليومية باللعب اليوم.",
        channel: "reminders",
      });
      expect(message?.body).not.toMatch(/[0-9]/);
    });

    it("never reminds a banned or erased player, one without a pushable device or one who muted reminders", async () => {
      const banned = await streaker();
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned.who]);
      const erased = await streaker();
      expect(await f.erase(erased.who)).toBe("erased");
      const muted = await streaker();
      await f.owner("INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, 'reminders')", [
        muted.who,
      ]);
      const signedOut = await streaker();
      await f.owner("UPDATE player_refresh SET revoked_at = now() WHERE player_id = $1", [
        signedOut.who,
      ]);
      const noPhone = await f.newPlayer();
      await f.owner(
        "INSERT INTO questify_streak_day (player_id, day) SELECT $1, $2::date - g FROM generate_series(1, 2) g",
        [noPhone, riyadhDate()],
      );
      const control = await streaker();
      await scan();
      for (const who of [banned.who, erased.who, muted.who, signedOut.who, noPhone]) {
        expect(await remindersOf(who), who).toEqual([]);
      }
      expect(await remindersOf(control.who)).toHaveLength(1);
    });

    it("sends nothing while the daily streak is switched off, and a rehearsal play makes no streak day", async () => {
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('features', '{"dailyStreak": {"enabled": false}}')
         ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      );
      const off = await streaker();
      await scan();
      expect(await remindersOf(off.who)).toEqual([]);
      await f.owner(
        `UPDATE platform_setting SET value = value || '{"dailyStreak": {"enabled": true}}' WHERE key = 'features'`,
      );
      const event = await f.newEvent({ phase: "scheduled" });
      const rehearsing = await f.playerWithPhone();
      await f.earn(event, await f.join(event, rehearsing.who, "rehearsal"));
      expect(await f.count("questify_streak_day WHERE player_id = $1", [rehearsing.who])).toBe(0);
      await scan();
      expect(await remindersOf(rehearsing.who)).toEqual([]);
      expect(await remindersOf(off.who)).toHaveLength(1);
    });

    it("skips the push at sending once the player has played since the scan", async () => {
      const later = await streaker();
      await f.drain();
      await scan();
      const reminders = await remindersOf(later.who);
      await f.fanOut();
      await f.owner("INSERT INTO questify_streak_day (player_id, day) VALUES ($1, $2::date)", [
        later.who,
        riyadhDate(),
      ]);
      expect((await f.claim()).filter((row) => row.token === later.token)).toEqual([]);
      expect((await sendsOf(reminders)).map((send) => [send.state, send.code])).toEqual([
        ["skipped", "not_member"],
      ]);
    });

    it("a broken kind cannot roll back the scan: it writes nothing and raises nothing, and the marker stays free", async () => {
      const waiting = await streaker();
      await f.withoutKind("streak_reminder", async () => {
        expect(await scan()).toBe(0);
        expect(await due()).toMatchObject({ streak: 0 });
      });
      expect(await remindersOf(waiting.who)).toEqual([]);
      await scan();
      expect(await remindersOf(waiting.who)).toHaveLength(1);
    });
  });

  describe("the shop's closing (T-410, ADR-338 (6))", () => {
    it("pushes once, the day before the window closes, to real active members with a balance and no one else", async () => {
      const event = await f.newEvent({ phase: "live" });
      const real = await member(event);
      const others = [await member(event, { broke: true })];
      for (const status of ["left", "removed", "banned", "pending"]) {
        const one = await member(event);
        await f.owner("UPDATE enrollment SET status = $2 WHERE id = $1", [one.enrollment, status]);
        others.push(one);
      }
      others.push(await member(event, { via: "rehearsal" }));
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
      others.push(operator, barred, erased);
      await end(event, "2 days 12 hours", 3);
      await f.drain();
      await due();
      await due();
      const [notice, ...more] = await shopNotices(event);
      expect(more).toEqual([]);
      const [closes] = await f.owner<{ at: Date }>(
        "SELECT ends_at + make_interval(days => shop_days_after) AS at FROM event WHERE id = $1",
        [event],
      );
      expect(notice).toMatchObject({ dedupe: `shop_closing:${event}`, refs: {}, player_id: null });
      expect(new Date(String(notice?.params["date"])).getTime()).toBe(closes?.at.getTime());
      expect(notice?.expires_at.getTime()).toBe(closes?.at.getTime());
      await f.fanOut();
      expect(await f.recipients(notice?.id ?? null)).toEqual([real.who]);
      const claimed = (await f.claim()) as unknown as ClaimedSend[];
      const mine = claimed.filter((row) => row.kind === "shop_closing");
      expect(mine.map((row) => row.token)).toEqual([real.token]);
      const message = mine[0] === undefined ? null : pushMessageOf({ ...mine[0], language: "en" });
      expect(message?.body).toMatch(
        /^The Event [0-9]+ rewards shop is open until [0-9]{1,2} [A-Z][a-z]{2}\.$/,
      );
      expect(message?.body).not.toContain("10");
      expect(message?.channel).toBe("reminders");
    });

    it("none for a 0-day window, a shop switched off, a window more than a day from closing or one closed", async () => {
      const cases: Array<[string, string, number]> = [
        ["zero", "1 hour", 0],
        ["early", "1 hour", 3],
        ["closed", "4 days", 3],
      ];
      const silent: string[] = [];
      for (const [, ago, days] of cases) {
        const event = await f.newEvent({ phase: "live" });
        await member(event);
        await end(event, ago, days);
        silent.push(event);
      }
      const eventOff = await f.newEvent({ phase: "live" });
      await member(eventOff);
      await f.owner(
        `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}') || '{"shop": false}')
         WHERE id = $1`,
        [eventOff],
      );
      await end(eventOff, "2 days 12 hours", 3);
      silent.push(eventOff);
      const platformOff = await f.newEvent({ phase: "live" });
      await member(platformOff);
      await end(platformOff, "2 days 12 hours", 3);
      await f.owner(
        `INSERT INTO platform_setting (key, value) VALUES ('features', '{"shop": {"enabled": false}}')
         ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      );
      await due();
      await f.owner(
        `UPDATE platform_setting SET value = value || '{"shop": {"enabled": true}}' WHERE key = 'features'`,
      );
      for (const event of silent) expect(await shopNotices(event), event).toEqual([]);
      expect(await shopNotices(platformOff)).toEqual([]);
      await due();
      expect(await shopNotices(platformOff)).toHaveLength(1);
    });

    it("skips the push when the window was extended after the notice, and no second push follows", async () => {
      const event = await f.newEvent({ phase: "live" });
      const stays = await member(event);
      await end(event, "2 days 12 hours", 3);
      await f.drain();
      await due();
      const notices = await shopNotices(event);
      await f.fanOut();
      expect(await f.recipients(notices[0]?.id ?? null)).toEqual([stays.who]);
      await f.owner("UPDATE event SET shop_days_after = 5 WHERE id = $1", [event]);
      expect((await f.claim()).filter((row) => row.token === stays.token)).toEqual([]);
      expect((await sendsOf(notices)).map((send) => [send.state, send.code])).toEqual([
        ["skipped", "not_member"],
      ]);
      // The new close comes within a day too: still the one notice per event.
      await f.owner(
        `UPDATE event SET starts_at = now() - interval '5 days 12 hours', ends_at = now() - interval '4 days 12 hours'
         WHERE id = $1`,
        [event],
      );
      await due();
      expect(await shopNotices(event)).toHaveLength(1);
    });

    it("skips a member who left between the fan-out and the claim", async () => {
      const event = await f.newEvent({ phase: "live" });
      const leaving = await member(event);
      await end(event, "2 days 12 hours", 3);
      await f.drain();
      await due();
      await f.fanOut();
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [leaving.enrollment]);
      expect((await f.claim()).filter((row) => row.token === leaving.token)).toEqual([]);
      expect((await sendsOf(await shopNotices(event))).map((send) => send.state)).toEqual([
        "skipped",
      ]);
    });

    it("a broken kind cannot roll back the scan, and the marker stays free for the next one", async () => {
      const event = await f.newEvent({ phase: "live" });
      await member(event);
      await end(event, "2 days 12 hours", 3);
      await f.withoutKind("shop_closing", async () => {
        expect(await due()).toMatchObject({ shop: 0 });
      });
      expect(await shopNotices(event)).toEqual([]);
      await due();
      expect(await shopNotices(event)).toHaveLength(1);
    });
  });
});
