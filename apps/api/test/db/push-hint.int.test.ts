import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Member = Readonly<{ who: string; enrollment: string; token: string; deviceId: string }>;
type Pressed = Readonly<{ sent: boolean; replayed: boolean }>;
type NoticeRow = {
  id: string;
  refs: Record<string, unknown>;
  params: Record<string, unknown>;
  dedupe: string;
  expires_at: Date;
  created_at: Date;
};

/** A rehearsal's join code is unique across events: four and four characters of the code alphabet. */
function rehearsalCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from({ length: 4 }, () => alphabet.charAt(randomInt(alphabet.length))).join("");
  return `${group()}-${group()}`;
}

/** A call's SQLSTATE and detail ("PE409:event_not_live"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/**
 * The hidden-category hint in the database (T-501g, migration 0080; plan docs/plans/2026-10-28-t-501g-hint-push.md,
 * ADR-357): the door writes one notice through notice_create, once per press; the fan-out reveals the category to each
 * member it writes a center row for, so the recipients and the players who see the category are one set; nothing about a
 * device, a mute, the platform switch or a delivery changes who sees it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the hidden-category hint (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const press = (
    event: string,
    category: string,
    key: string = randomUUID(),
    seat: RequestContext = f.team(),
  ) =>
    f.run<Pressed>(seat, "SELECT * FROM send_category_hint($1, $2, $3, $4)", [
      event,
      category,
      key,
      randomUUID(),
    ]);
  const preview = (event: string, category: string, seat: RequestContext = f.team()) =>
    f.run<{ members: number; pending: boolean }>(
      seat,
      "SELECT * FROM category_hint_preview($1, $2)",
      [event, category],
    );
  const noticesOf = (event: string) =>
    f.owner<NoticeRow>(
      `SELECT id, refs, params, dedupe, expires_at, created_at FROM notice
       WHERE event_id = $1 AND kind = 'category_hint' ORDER BY id`,
      [event],
    );
  const onlyNotice = async (event: string) => {
    const rows = await noticesOf(event);
    expect(rows).toHaveLength(1);
    return rows[0] as NoticeRow;
  };
  const revealed = async (category: string) =>
    (
      await f.owner<{ player_id: string }>(
        `SELECT n.player_id FROM category_reveal r JOIN enrollment n ON n.id = r.enrollment_id
         WHERE r.category_id = $1 ORDER BY n.player_id`,
        [category],
      )
    ).map((row) => row.player_id);
  /** The categories a player's quest list shows. */
  const seen = async (event: string, who: Member) =>
    (
      await f.run<{ category_id: string }>(
        { playerId: who.who },
        "SELECT DISTINCT category_id FROM member_event_quests($1)",
        [event],
      )
    ).map((row) => row.category_id);

  /** A hidden category with one visible quest, so a player who sees the category lists it. */
  const hiddenCategory = async (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO category (event_id, name_en, name_ar, hidden) VALUES ($1, 'Secret garden', 'الحديقة السرية', true)
       RETURNING id`,
      [event],
    );
    // All the fields in one statement: the audience columns are only valid together.
    const columns = Object.keys(fields);
    if (columns.length > 0) {
      await f.owner(
        `UPDATE category SET ${columns.map((column, at) => `${column} = $${at + 2}`).join(", ")} WHERE id = $1`,
        [made?.id, ...Object.values(fields)],
      );
    }
    await f.owner(
      `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, visible)
       VALUES ($1, $2, 'scan_qr', 'Find the rose', 'ابحث عن الوردة', 10, true)`,
      [event, made?.id],
    );
    return made?.id ?? "";
  };
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
  /** Everyone a hint must never reach, beside one real member who should be told. */
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
  const openRehearsal = (event: string) =>
    f.owner(
      `INSERT INTO event_rehearsal (event_id, organizer_id, code)
       SELECT id, organizer_id, $2 FROM event WHERE id = $1`,
      [event, rehearsalCode()],
    );

  // ------------------------------------------------------------------ who is told, and who sees the category
  describe("the recipients", () => {
    it("reveals the category to exactly the members it tells, and to no one else", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const { real, others } = await crowd(event);
      const found = await member(event);
      await f.owner(
        `INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
         SELECT organizer_id, id, $2, $3 FROM event WHERE id = $1`,
        [event, found.enrollment, category],
      );
      // Another organizer's live event with a hidden category of its own: nothing crosses.
      const elsewhere = await f.newEvent({ phase: "live", organizer: f.ids.orgB });
      const elsewhereCategory = await hiddenCategory(elsewhere);
      const stranger = await member(elsewhere);
      expect((await preview(event, category))[0]).toEqual({ members: 2, pending: false });

      expect(await press(event, category)).toEqual([{ sent: true, replayed: false }]);
      const joinedAfter = await member(event);
      await f.fanOut();
      const notice = await onlyNotice(event);

      expect(await revealed(category)).toEqual([real.who, found.who].toSorted());
      expect(await f.recipients(notice.id)).toEqual([real.who, found.who].toSorted());
      expect(await seen(event, real)).toEqual([category]);
      expect(await seen(event, joinedAfter)).not.toContain(category);
      for (const one of [...others, joinedAfter, stranger]) {
        expect(await revealed(category), one.who).not.toContain(one.who);
        expect(await f.recipients(notice.id), one.who).not.toContain(one.who);
      }
      expect(await revealed(elsewhereCategory)).toEqual([]);
      // Ids only in the refs, the event's name only in the params; never the category's name.
      expect(notice.refs).toEqual({ category });
      expect(Object.keys(notice.params)).toEqual(["event"]);
      expect(notice.expires_at.getTime() - notice.created_at.getTime()).toBeLessThanOrEqual(
        2 * 3600 * 1000,
      );
      // The claim tells the same story: every send of a recipient goes, no one else has one.
      await f.claim();
      expect((await f.sends(notice.id)).map((row) => row.device_id).toSorted()).toEqual(
        [real.deviceId, found.deviceId].toSorted(),
      );
    });

    it("a player who joins after the press is not told, unless they scan the secret code", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const early = await member(event);
      const rejoined = await member(event, { status: "left" });
      await press(event, category);
      const late = await member(event);
      // Left before the press and back after it: joined_at moves to the re-join, as the join doors write it.
      await f.owner("UPDATE enrollment SET status = 'active', joined_at = now() WHERE id = $1", [
        rejoined.enrollment,
      ]);
      await f.fanOut();
      expect(await revealed(category)).toEqual([early.who]);
      expect(await seen(event, late)).not.toContain(category);
      expect(await seen(event, rejoined)).not.toContain(category);
      // The secret code still reveals it, as before (reveal_category, T-304c).
      const [found] = await f.run<{ revealed: boolean }>(
        { playerId: late.who },
        "SELECT * FROM reveal_category($1, 1)",
        [category],
      );
      expect(found?.revealed).toBe(true);
      expect(await seen(event, late)).toContain(category);
    });

    it("a told member who leaves and re-joins is told again by the next press, in the count and the fan-out", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const back = await member(event);
      await press(event, category);
      await f.fanOut();
      expect((await preview(event, category))[0]?.members).toBe(0);
      await f.owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [back.enrollment]);
      await f.owner("UPDATE enrollment SET status = 'active', joined_at = now() WHERE id = $1", [
        back.enrollment,
      ]);
      expect((await preview(event, category))[0]?.members).toBe(1);
      expect(await press(event, category)).toEqual([{ sent: true, replayed: false }]);
      await f.fanOut();
      const notices = await noticesOf(event);
      expect(notices).toHaveLength(2);
      expect(await f.recipients(notices[0]?.id ?? null)).toEqual([back.who]);
      expect(await f.recipients(notices[1]?.id ?? null)).toEqual([back.who]);
    });

    it("a member who joined before the press but whose enrollment the fan-out reaches later is still told", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const slow = await member(event);
      await f.owner("UPDATE enrollment SET joined_at = now() - interval '1 hour' WHERE id = $1", [
        slow.enrollment,
      ]);
      await press(event, category);
      await f.fanOut();
      expect(await revealed(category)).toEqual([slow.who]);
    });

    it("a targeted hidden category tells only the members in its audience", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event, {
        audience_kind: "tag",
        audience_values: ["vip"],
      });
      const vip = await member(event);
      const other = await member(event);
      await tagVip(event, vip.who);
      expect((await preview(event, category))[0]?.members).toBe(1);
      await press(event, category);
      await f.fanOut();
      expect(await revealed(category)).toEqual([vip.who]);
      expect(await f.recipients((await onlyNotice(event)).id)).toEqual([vip.who]);
      expect(await seen(event, vip)).toEqual([category]);
      expect(await seen(event, other)).toEqual([]);
    });

    it("a category targeted by a join answer tells only the members who gave it, and the count agrees", async () => {
      const event = await f.newEvent({ phase: "live" });
      const [field] = await f.owner<{ id: string }>(
        `INSERT INTO event_join_field (event_id, kind, label_en, required, position, options)
         VALUES ($1, 'custom', 'Section', true, 0, $2::jsonb) RETURNING id`,
        [
          event,
          JSON.stringify([
            { id: "ladies", ar: "نساء", en: "Ladies" },
            { id: "men", ar: "رجال", en: "Men" },
          ]),
        ],
      );
      const category = await hiddenCategory(event, {
        audience_kind: "answer",
        audience_field_id: field?.id,
        audience_values: ["ladies"],
      });
      const ladies = await member(event);
      const men = await member(event);
      await member(event);
      for (const [who, value] of [
        [ladies, "ladies"],
        [men, "men"],
      ] as const) {
        await f.owner(
          `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
           SELECT $1, $2, organizer_id, id, $3 FROM event WHERE id = $4`,
          [who.enrollment, field?.id, value, event],
        );
      }
      expect((await preview(event, category))[0]?.members).toBe(1);
      await press(event, category);
      await f.fanOut();
      expect(await revealed(category)).toEqual([ladies.who]);
      expect(await f.recipients((await onlyNotice(event)).id)).toEqual([ladies.who]);
    });

    it("a rehearsal hint reaches the rehearsal accounts only", async () => {
      const event = await f.newEvent({ phase: "scheduled" });
      const category = await hiddenCategory(event);
      expect(await refusal(preview(event, category))).toBe("PE409:event_not_live");
      await openRehearsal(event);
      const rehearsing = await member(event, { via: "rehearsal" });
      await member(event);
      expect((await preview(event, category))[0]?.members).toBe(1);
      await press(event, category);
      await f.fanOut();
      expect(await revealed(category)).toEqual([rehearsing.who]);
      expect(await f.recipients((await onlyNotice(event)).id)).toEqual([rehearsing.who]);
      expect(await seen(event, rehearsing)).toEqual([category]);
    });

    it("a rehearsal account left on a live event is not told", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const real = await member(event);
      await member(event, { via: "rehearsal" });
      await press(event, category);
      await f.fanOut();
      expect(await revealed(category)).toEqual([real.who]);
    });

    it("the count agrees with who the fan-out tells, on every kind of member", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const { real } = await crowd(event);
      const more = [await member(event), await member(event), await member(event)];
      const byPhone = await member(event);
      const phone = `+9665${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
      await f.owner(
        `INSERT INTO event_exclusion (organizer_id, event_id, kind, value)
         SELECT organizer_id, id, entry.kind, entry.value
         FROM event, (VALUES ('email_domain', 'excluded.test'), ('phone', $2)) AS entry (kind, value)
         WHERE id = $1`,
        [event, phone],
      );
      await f.owner("UPDATE player_contact SET email = 'who@excluded.test' WHERE player_id = $1", [
        more[0]?.who,
      ]);
      await f.owner("UPDATE player_contact SET phone_e164 = $2 WHERE player_id = $1", [
        byPhone.who,
        phone,
      ]);
      const counted = (await preview(event, category))[0]?.members;
      await press(event, category);
      await f.fanOut();
      const told = await f.recipients((await onlyNotice(event)).id);
      expect(told).toEqual([real.who, more[1]?.who, more[2]?.who].toSorted());
      expect(counted).toBe(told.length);
    });
  });

  // ------------------------------------------------------------------ delivery does not decide who sees it
  describe("delivery", () => {
    it("a muted topic, no device, an invalid device and a switched-off platform still reveal and fill the center", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const delivered = await member(event);
      const muted = await member(event);
      await f.owner("INSERT INTO push_topic_mute (player_id, topic) VALUES ($1, 'announcements')", [
        muted.who,
      ]);
      const deviceless = await f.newPlayer();
      await f.join(event, deviceless);
      const invalid = await member(event);
      await f.owner("UPDATE push_device SET invalid_at = now() WHERE id = $1", [invalid.deviceId]);
      await f.switchPush(false);
      try {
        await press(event, category);
        await f.fanOut();
        const notice = await onlyNotice(event);
        expect(await f.recipients(notice.id)).toEqual(
          [delivered.who, muted.who, deviceless, invalid.who].toSorted(),
        );
        expect(await revealed(category)).toEqual(
          [delivered.who, muted.who, deviceless, invalid.who].toSorted(),
        );
        expect(await seen(event, muted)).toEqual([category]);
        expect(await seen(event, invalid)).toEqual([category]);
        // Only the delivered member's device has a send; the muted and device-less members have the center row alone.
        expect((await f.sends(notice.id)).map((row) => row.device_id)).toEqual([
          delivered.deviceId,
        ]);
      } finally {
        await f.switchPush(true);
      }
    });

    it("a push skipped at the claim does not take the category back", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const one = await member(event);
      await press(event, category);
      await f.fanOut();
      await f.owner(
        "UPDATE category SET audience_kind = 'tag', audience_values = '{nobody}' WHERE id = $1",
        [category],
      );
      const sends = await f.claim();
      expect(sends).toEqual([]);
      expect(
        (await f.sends((await onlyNotice(event)).id)).map((row) => [row.state, row.code]),
      ).toEqual([["skipped", "not_member"]]);
      expect(await revealed(category)).toEqual([one.who]);
    });

    it("a category made visible before the claim skips the push and keeps the center row", async () => {
      await f.drain();
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const one = await member(event);
      await press(event, category);
      await f.fanOut();
      await f.owner("UPDATE category SET hidden = false WHERE id = $1", [category]);
      await f.claim();
      const notice = await onlyNotice(event);
      expect((await f.sends(notice.id)).map((row) => [row.state, row.code])).toEqual([
        ["skipped", "not_member"],
      ]);
      expect(await f.recipients(notice.id)).toEqual([one.who]);
    });
  });

  // ------------------------------------------------------------------ once per press
  describe("a press", () => {
    it("is sent once per Idempotency-Key: a replay writes no second notice and reveals no one new", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const first = await member(event);
      const key = randomUUID();
      expect(await press(event, category, key)).toEqual([{ sent: true, replayed: false }]);
      expect(await press(event, category, key)).toEqual([{ sent: true, replayed: true }]);
      await f.fanOut();
      await member(event);
      expect(await press(event, category, key)).toEqual([{ sent: true, replayed: true }]);
      await f.fanOut();
      expect(await noticesOf(event)).toHaveLength(1);
      expect(await revealed(category)).toEqual([first.who]);
      const [audited] = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE event_id = $1 AND action = 'category.hint_send'",
        [event],
      );
      expect(audited?.n).toBe(1);
    });

    it("a second press while the first is still being delivered is refused", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      await member(event);
      await press(event, category);
      expect(await refusal(press(event, category))).toBe("PH409:hint_in_progress");
      expect((await preview(event, category))[0]?.pending).toBe(true);
      await f.fanOut();
      expect((await preview(event, category))[0]?.pending).toBe(false);
      expect(await noticesOf(event)).toHaveLength(1);
    });

    it("a later press tells only the members not yet told", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const early = await member(event);
      await press(event, category);
      await f.fanOut();
      const late = await member(event);
      const second = await preview(event, category);
      expect(second[0]).toEqual({ members: 1, pending: false });
      await press(event, category);
      await f.fanOut();
      const notices = await noticesOf(event);
      expect(notices).toHaveLength(2);
      expect(await f.recipients(notices[0]?.id ?? null)).toEqual([early.who]);
      expect(await f.recipients(notices[1]?.id ?? null)).toEqual([late.who]);
      expect(await revealed(category)).toEqual([early.who, late.who].toSorted());
      expect((await preview(event, category))[0]?.members).toBe(0);
    });

    it("is refused when it would tell no one: no member yet, or everyone already told", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      expect(await refusal(press(event, category))).toBe("PT409:hint_nobody");
      expect(await noticesOf(event)).toEqual([]);
      await member(event);
      const key = randomUUID();
      expect(await press(event, category, key)).toEqual([{ sent: true, replayed: false }]);
      await f.fanOut();
      for (let again = 0; again < 3; again += 1) {
        expect(await refusal(press(event, category)), `press ${again}`).toBe("PT409:hint_nobody");
      }
      // The key that sent the hint still answers: a resend is not a new press.
      expect(await press(event, category, key)).toEqual([{ sent: true, replayed: true }]);
      expect(await noticesOf(event)).toHaveLength(1);
      const [audited] = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE event_id = $1 AND action = 'category.hint_send'",
        [event],
      );
      expect(audited?.n).toBe(1);
    });

    it("a notice that never finished and is older than 10 minutes does not block a press", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      const stuck = await member(event);
      await press(event, category);
      expect((await preview(event, category))[0]?.pending).toBe(true);
      await f.owner(
        "UPDATE notice SET created_at = now() - interval '11 minutes' WHERE event_id = $1 AND kind = 'category_hint'",
        [event],
      );
      expect((await preview(event, category))[0]).toEqual({ members: 1, pending: false });
      expect(await press(event, category)).toEqual([{ sent: true, replayed: false }]);
      expect(await noticesOf(event)).toHaveLength(2);
      await f.fanOut();
      expect(await revealed(category)).toEqual([stuck.who]);
    });

    it("on a live event first wipes a rehearsal account that was left behind, and tells only the real members", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      await openRehearsal(event);
      const leftover = await member(event, { via: "rehearsal" });
      const real = await member(event);
      expect((await preview(event, category))[0]?.members).toBe(1);
      await press(event, category);
      const [wiped] = await f.owner<{ live_wiped_at: Date | null }>(
        "SELECT live_wiped_at FROM event_rehearsal WHERE event_id = $1",
        [event],
      );
      expect(wiped?.live_wiped_at).not.toBeNull();
      const [account] = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM enrollment WHERE id = $1",
        [leftover.enrollment],
      );
      expect(account?.n).toBe(0);
      await f.fanOut();
      expect(await revealed(category)).toEqual([real.who]);
    });

    it("a broken kind cannot roll back the door: nothing is written and the door answers sent false", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      await member(event);
      await f.withoutKind("category_hint", async () => {
        expect(await press(event, category)).toEqual([{ sent: false, replayed: false }]);
        await f.fanOut();
      });
      expect(await noticesOf(event)).toEqual([]);
      expect(await revealed(category)).toEqual([]);
      const [audited] = await f.owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_log WHERE event_id = $1 AND action = 'category.hint_send'",
        [event],
      );
      expect(audited?.n).toBe(0);
    });
  });

  // ------------------------------------------------------------------ the door's refusals and who may press
  describe("the door", () => {
    it("refuses an ended event, a draft without a rehearsal, a shown category, another event's category and a bad key", async () => {
      const ended = await f.newEvent({ phase: "ended" });
      const endedCategory = await hiddenCategory(ended);
      expect(await refusal(press(ended, endedCategory))).toBe("PE409:event_not_live");
      const draft = await f.newEvent({ phase: "scheduled" });
      const draftCategory = await hiddenCategory(draft);
      expect(await refusal(press(draft, draftCategory))).toBe("PE409:event_not_live");
      const live = await f.newEvent({ phase: "live" });
      const shown = await hiddenCategory(live, { hidden: false });
      expect(await refusal(press(live, shown))).toBe("QH422");
      expect(await refusal(preview(live, shown))).toBe("QH422");
      expect(await refusal(press(live, endedCategory))).toBe("AN404");
      expect(await refusal(press(live, randomUUID()))).toBe("AN404");
      const hidden = await hiddenCategory(live);
      expect(await refusal(press(live, hidden, ""))).toBe("PK400");
      expect(await refusal(press(live, hidden, "k".repeat(256)))).toBe("PK400");
      expect(await noticesOf(live)).toEqual([]);
    });

    it("lets an owner and an editor press, and no one else", async () => {
      const event = await f.newEvent({ phase: "live" });
      const other = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      await member(event);
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor", [event]);
      const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [other]);
      const foreign = await addMember(f.db.owner, f.ids.orgB, "owner");
      const stranger = await f.newPlayer();
      const seats: ReadonlyArray<readonly [string, RequestContext]> = [
        ["an editor outside the event limit", f.team(limited)],
        ["another organizer's owner", { organizerId: f.ids.orgB, staffUserId: foreign }],
        [
          "another organizer's owner under this organizer",
          { organizerId: f.ids.orgA, staffUserId: foreign },
        ],
        ["a player", { playerId: stranger }],
        ["no one", {}],
      ];
      for (const [who, seat] of seats) {
        expect(await refusal(press(event, category, randomUUID(), seat)), who).toBe("AN404");
        expect(await refusal(preview(event, category, seat)), who).toBe("AN404");
      }
      expect(await noticesOf(event)).toEqual([]);
      expect(await press(event, category, randomUUID(), f.team(editor))).toEqual([
        { sent: true, replayed: false },
      ]);
      await f.fanOut();
      await member(event);
      expect(await press(event, category)).toEqual([{ sent: true, replayed: false }]);
      expect(await noticesOf(event)).toHaveLength(2);
    });

    it("audits each press with the editor's name and no recipients", async () => {
      const event = await f.newEvent({ phase: "live" });
      const category = await hiddenCategory(event);
      await member(event);
      await press(event, category);
      const [row] = await f.owner<{ actor_type: string; target_id: string; after: unknown }>(
        "SELECT actor_type, target_id, after FROM audit_log WHERE event_id = $1 AND action = 'category.hint_send'",
        [event],
      );
      expect(row).toEqual({
        actor_type: "staff",
        target_id: category,
        after: { rehearsal: false },
      });
    });
  });
});
