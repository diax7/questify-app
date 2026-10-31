import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";
import { pushFixture, type PushFixture } from "#test/support/push";

type Counts = Record<string, number>;
const DAY = 24 * 3600 * 1000;

/** A call's SQLSTATE and detail ("ED409:target_not_empty"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/** The tables that hold an event's setup: the door copies these and no others (T-601, migration 0092). */
const COPIED = new Set([
  "big_screen",
  "category",
  "event_join_field",
  "event_map",
  "event_session",
  "event_streak",
  "event_topic_off",
  "map_pin",
  "passport_step",
  "quest",
  "quest_first_bonus",
  "quest_item",
  "rank_prize",
  "reward",
  "sponsor",
  "sponsor_tag",
]);

/**
 * The tables with an `event_id` the door leaves alone, each for a reason: a person or a play row, a secret or a device, live
 * operation with state, money and activation, results. A new table with an `event_id` is in neither list until its task
 * decides, and the walk below fails until then.
 */
const NOT_COPIED = new Set([
  // people and play
  "announcement",
  "bulk_award",
  "category_bonus",
  "category_reveal",
  "cheer",
  "community_contributor",
  "community_payout",
  "community_reach",
  "completion_position",
  "enrollment",
  "erased_mark",
  "event_exclusion",
  "event_guest",
  "event_streak_day",
  "final_rank",
  "flag",
  "game_round",
  "join_answer",
  "ledger_entry",
  "ledger_note",
  "manual_award_key",
  "meet_pass",
  "meeting",
  "notice",
  "notification",
  "organizer_alert",
  "passport_stamp",
  "quest_bonus_slot",
  "quest_completion",
  "quest_item_miss",
  "quest_rating",
  "quest_vote",
  "quiz_attempt",
  "redemption",
  "session_attendance",
  "session_message",
  "session_registration",
  "souvenir_receipt",
  "souvenir_work",
  "submission",
  "survey_response",
  "ticket",
  // secrets, devices and people who act for the event
  "kiosk_scan",
  "nfc_tag",
  "nfc_tap",
  "operator_invite",
  "paired_device",
  "reward_code",
  "staff_assignment",
  "staff_assignment_quest",
  "survey_share",
  "invitation_campaign",
  // live operation with state, promises that freeze, money, activation and results
  "boost",
  "cheers_moment",
  "community_goal",
  "community_step",
  "event_activation_request",
  "event_entitlement",
  "event_limit_alert",
  "event_rehearsal",
  "event_result",
  "finale",
  "rank_top_snapshot",
  "ranking_repair",
  "result_place",
  "souvenir_command",
  "souvenir_rule",
  "souvenir_target",
  // the record of the copy itself
  "audit_log",
]);

/**
 * Duplicating an event in the database (T-601, migration 0092; plan docs/plans/2026-10-31-t-601-duplicate-event.md,
 * ADR-380): the door copies an event's setup into the empty draft the API just made, with new ids, references that
 * point at the copies and times moved by the distance between the starts; it never copies a person, a play row or a
 * secret, and it works only between two events of the caller's own organizer.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("duplicate an event (database)", () => {
  let f: PushFixture;
  let source: string;
  let counter = 0;
  const ref: Record<string, string> = {};

  const one = async (sql: string, values: unknown[] = []): Promise<string> =>
    (await f.owner<{ id: string }>(sql, values))[0]?.id ?? "";
  const count = async (table: string, event: string): Promise<number> =>
    (
      await f.owner<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE event_id = $1`, [
        event,
      ])
    )[0]?.n ?? 0;
  const draft = async (startsInDays = 30, organizer = f.ids.orgA): Promise<string> => {
    counter += 1;
    return one(
      `INSERT INTO event (organizer_id, join_code, name_en, starts_at, ends_at)
       VALUES ($1, $2, 'Copy', now() + $3 * interval '1 day', now() + ($3 + 1) * interval '1 day') RETURNING id`,
      [organizer, `DUP${counter}`, startsInDays],
    );
  };
  const copy = (from: string, to: string, seat = f.team()) =>
    f.run<{ r: Counts }>(seat, "SELECT event_copy_setup($1, $2, $3) AS r", [
      from,
      to,
      randomUUID(),
    ]);

  const setupEvent = async (): Promise<void> => {
    await f.owner(
      `UPDATE event SET config = '{"features": {"ranking": false, "questRatings": true}, "terms": {"currency": {"en": "Gems"}}}',
         pickup_minutes = 60, shop_days_after = 5, welcome_points = 7, rules_en = 'Be kind', award_cap_each = 150,
         award_cap_day = 400, player_limit_mode = 'soft', player_limit = 300, email_domains = '{acme.test}',
         desk_hours = tstzmultirange(tstzrange(starts_at, starts_at + interval '2 hours'))
       WHERE id = $1`,
      [source],
    );
    await f.owner(
      "INSERT INTO event_topic_off (event_id, organizer_id, topic) SELECT id, organizer_id, 'rank' FROM event WHERE id = $1",
      [source],
    );
    ref["field"] = await one(
      "INSERT INTO event_join_field (event_id, kind, label_en, position) VALUES ($1, 'custom', 'Company', 1) RETURNING id",
      [source],
    );
    ref["item"] = await one(
      "INSERT INTO quest_item (event_id, name_en, stock_total) VALUES ($1, 'Badge', 10) RETURNING id",
      [source],
    );
    await f.owner(
      "INSERT INTO quest_item (event_id, name_en, stock_total, status) VALUES ($1, 'Old badge', 5, 'removed')",
      [source],
    );
    ref["zoneA"] = await one(
      `INSERT INTO category (event_id, name_en, name_ar, position, audience_kind, audience_field_id, audience_values, item_id)
       VALUES ($1, 'Zone A', 'منطقة أ', 1, 'answer', $2, '{Acme}', $3) RETURNING id`,
      [source, ref["field"], ref["item"]],
    );
    ref["zoneB"] = await one(
      `INSERT INTO category (event_id, name_en, position, unlock_after, completion_bonus, opens_at)
       SELECT $1, 'Zone B', 2, $2, 5, starts_at + interval '1 hour' FROM event WHERE id = $1 RETURNING id`,
      [source, ref["zoneA"]],
    );
    await setupQuests();
    await setupRewards();
    await setupExtras();
  };

  const setupQuests = async (): Promise<void> => {
    ref["scan"] = await one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, item_id, place_lat, place_lng, place_radius_m)
       VALUES ($1, $2, 'scan_qr', 'Scan the gate', 25, 3, $3, 24.7, 46.7, 100) RETURNING id`,
      [source, ref["zoneA"], ref["item"]],
    );
    ref["code"] = await one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, opens_at, closes_at, visible)
       SELECT $1, $2, 'enter_code', 'Type the word', 10, 1, '{"code": "SECRET99"}',
              starts_at + interval '2 hours', starts_at + interval '5 hours', false FROM event WHERE id = $1 RETURNING id`,
      [source, ref["zoneB"]],
    );
    ref["flash"] = await one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, flash, opens_at, closes_at, visible)
       SELECT $1, $2, 'scan_qr', 'Flash', 50, 1, true, starts_at + interval '3 hours', starts_at + interval '4 hours', true
       FROM event WHERE id = $1 RETURNING id`,
      [source, ref["zoneB"]],
    );
    await f.owner(
      "UPDATE quest SET flash_launched_at = now() - interval '1 hour', qr_version = 4 WHERE id = $1",
      [ref["flash"]],
    );
    ref["passport"] = await one(
      `WITH q AS (INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
                  VALUES ($1, $2, 'passport', 'Passport', 40, 1, '{"needed": 2}') RETURNING id),
            s AS (INSERT INTO passport_step (event_id, quest_id, name_en, position)
                  SELECT $1, q.id, 'Stop ' || n, n FROM q, generate_series(1, 2) AS n)
       SELECT id FROM q`,
      [source, ref["zoneA"]],
    );
    await f.owner(
      "INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots) SELECT id, organizer_id, event_id, 20, 3 FROM quest WHERE id = $1",
      [ref["scan"]],
    );
    await f.owner("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [source, ref["scan"]]);
  };

  const setupRewards = async (): Promise<void> => {
    ref["item_reward"] = await one(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total, section, audience_kind, audience_field_id, audience_values)
       VALUES ($1, 'item', 'Cap', 100, 20, 'merch', 'answer', $2, '{Acme}') RETURNING id`,
      [source, ref["field"]],
    );
    ref["digital"] = await one(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'digital', 'Voucher', 50, 0) RETURNING id",
      [source],
    );
    await f.owner(
      `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
       SELECT organizer_id, event_id, id, decode(repeat('00', 29), 'hex'), decode(md5('a') || md5('b'), 'hex')
       FROM reward WHERE id = $1`,
      [ref["digital"]],
    );
    await f.owner("UPDATE reward SET stock_total = 1 WHERE id = $1", [ref["digital"]]);
    ref["removed"] = await one(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Gone', 10, 1) RETURNING id",
      [source],
    );
    await f.owner("UPDATE reward SET status = 'removed' WHERE id = $1", [ref["removed"]]);
    await f.owner(
      "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en) VALUES ($1, 1, 3, 'experience', 'Tour')",
      [source],
    );
    await f.owner(
      "INSERT INTO rank_prize (event_id, rank_from, rank_to, kind, name_en, status) VALUES ($1, 4, 5, 'experience', 'Dinner', 'removed')",
      [source],
    );
  };

  const setupExtras = async (): Promise<void> => {
    await f.owner(
      `INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points, closed_weekdays, closed_days)
       SELECT id, organizer_id, true, 5, '{5}', ARRAY[(starts_at + interval '1 day')::date] FROM event WHERE id = $1`,
      [source],
    );
    ref["session"] = await one(
      `INSERT INTO event_session (organizer_id, event_id, kind, title_en, starts_at, ends_at, access, seats, quest_id, created_by, points)
       SELECT organizer_id, id, 'talk', 'Keynote', starts_at + interval '1 hour', starts_at + interval '2 hours', 'registration', 50, $2, $3, 40
       FROM event WHERE id = $1 RETURNING id`,
      [source, ref["scan"], f.ownerA],
    );
    ref["map"] = await one(
      "INSERT INTO event_map (organizer_id, event_id, name_en, position, created_by) SELECT organizer_id, id, 'Hall', 1, $2 FROM event WHERE id = $1 RETURNING id",
      [source, f.ownerA],
    );
    await f.owner(
      "INSERT INTO map_pin (organizer_id, event_id, map_id, kind, quest_id, x, y, created_by) SELECT organizer_id, id, $2, 'quest', $3, 0.5, 0.5, $4 FROM event WHERE id = $1",
      [source, ref["map"], ref["scan"], f.ownerA],
    );
    ref["sponsor"] = await one(
      "INSERT INTO sponsor (organizer_id, event_id, name_en, tier, created_by) SELECT organizer_id, id, 'Acme', 'gold', $2 FROM event WHERE id = $1 RETURNING id",
      [source, f.ownerA],
    );
    await f.owner(
      "INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, quest_id, created_by) SELECT organizer_id, id, $2, 'quest', $3, $4 FROM event WHERE id = $1",
      [source, ref["sponsor"], ref["scan"], f.ownerA],
    );
    await f.owner(
      "INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, reward_id, created_by) SELECT organizer_id, id, $2, 'reward', $3, $4 FROM event WHERE id = $1",
      [source, ref["sponsor"], ref["removed"], f.ownerA],
    );
    await f.owner(
      "INSERT INTO big_screen (event_id, organizer_id, scenes) SELECT id, organizer_id, '{poll,ranking}' FROM event WHERE id = $1",
      [source],
    );
  };

  /** People, play, secrets and live operation on the source: none of it may reach a copy. */
  const setupState = async (): Promise<void> => {
    const player = await f.newPlayer();
    const enrollment = await f.play(source, player, 2);
    await f.owner(
      "INSERT INTO event_guest (organizer_id, event_id, kind, value) SELECT organizer_id, id, 'email', 'guest@acme.test' FROM event WHERE id = $1",
      [source],
    );
    await f.owner(
      `INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, label, locked)
       SELECT gen_random_uuid(), organizer_id, event_id, id, $2, 'Gate', true FROM quest WHERE id = $1`,
      [ref["scan"], Buffer.from("04a1b2c3d4e5f6", "hex")],
    );
    await f.owner(
      `INSERT INTO boost (organizer_id, event_id, category_id, multiplier, starts_at, ends_at)
       SELECT organizer_id, event_id, id, 2, now(), now() + interval '1 hour' FROM category WHERE id = $1`,
      [ref["zoneA"]],
    );
    expect(enrollment).not.toBe("");
  };

  beforeAll(async () => {
    f = await pushFixture();
    source = await f.newEvent({ phase: "ended" });
    await setupEvent();
    await setupState();
  });
  afterAll(async () => {
    await f.close();
  });

  it("copies the setup with new ids and references that point at the copies", async () => {
    const target = await draft();
    const counts = (await copy(source, target))[0]?.r ?? {};
    expect(counts).toMatchObject({
      items: 1,
      joinFields: 1,
      categories: 4,
      rewards: 2,
      rankPrizes: 1,
      sessions: 1,
      maps: 1,
      pins: 1,
      sponsors: 1,
      sponsorTags: 1,
    });
    const cats = await f.owner<{
      id: string;
      name_en: string;
      unlock_after: string | null;
      item_id: string | null;
      audience_field_id: string | null;
      completion_bonus: number | null;
    }>(
      "SELECT id, name_en, unlock_after, item_id, audience_field_id, completion_bonus FROM category WHERE event_id = $1 ORDER BY position, name_en",
      [target],
    );
    expect(cats.map((c) => c.name_en)).toEqual(["General", "General", "Zone A", "Zone B"]);
    const sourceCats = await f.owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1",
      [source],
    );
    expect(cats.some((c) => sourceCats.some((s) => s.id === c.id))).toBe(false);
    const zoneA = cats.find((c) => c.name_en === "Zone A");
    const zoneB = cats.find((c) => c.name_en === "Zone B");
    expect(zoneB?.unlock_after).toBe(zoneA?.id);
    expect(zoneB?.completion_bonus).toBe(5);
    const items = await f.owner<{ id: string; name_en: string }>(
      "SELECT id, name_en FROM quest_item WHERE event_id = $1",
      [target],
    );
    expect(items.map((i) => i.name_en)).toEqual(["Badge"]);
    expect(zoneA?.item_id).toBe(items[0]?.id);
    const fields = await f.owner<{ id: string }>(
      "SELECT id FROM event_join_field WHERE event_id = $1",
      [target],
    );
    expect(zoneA?.audience_field_id).toBe(fields[0]?.id);
    expect(fields[0]?.id).not.toBe(ref["field"]);
  });

  it("copies quests, rewards, prizes and the extras, and only what is still on offer", async () => {
    const target = await draft();
    await copy(source, target);
    const quests = await f.owner<{
      id: string;
      type: string;
      title_en: string;
      category_id: string;
      item_id: string | null;
      flash_launched_at: Date | null;
      qr_version: number;
      type_config: { code?: string };
    }>(
      "SELECT id, type, title_en, category_id, item_id, flash_launched_at, qr_version, type_config FROM quest WHERE event_id = $1",
      [target],
    );
    const titles = quests
      .map((q) => q.title_en)
      .filter((t) => ["Scan the gate", "Type the word", "Flash", "Passport"].includes(t ?? ""));
    expect(titles.toSorted()).toEqual(["Flash", "Passport", "Scan the gate", "Type the word"]);
    const flash = quests.find((q) => q.title_en === "Flash");
    expect(flash?.flash_launched_at).toBeNull();
    expect(flash?.qr_version).toBe(1);
    const typed = quests.find((q) => q.title_en === "Type the word");
    expect(typed?.type_config.code).toMatch(/^[A-Z0-9]{10}$/);
    expect(typed?.type_config.code).not.toBe("SECRET99");
    const scan = quests.find((q) => q.title_en === "Scan the gate");
    expect(scan?.item_id).not.toBeNull();
    expect(scan?.item_id).not.toBe(ref["item"]);
    const catIds = (
      await f.owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [target])
    ).map((c) => c.id);
    expect(quests.every((q) => catIds.includes(q.category_id))).toBe(true);
    const [event] = await f.owner<{ focus_quest_id: string | null }>(
      "SELECT focus_quest_id FROM event WHERE id = $1",
      [target],
    );
    expect(event?.focus_quest_id).toBe(scan?.id);
    expect(await count("passport_step", target)).toBe(2);
    expect(await count("quest_first_bonus", target)).toBe(1);
    const rewards = await f.owner<{
      name_en: string;
      kind: string;
      stock_total: number;
      units_out: number;
      audience_field_id: string | null;
    }>(
      "SELECT name_en, kind, stock_total, units_out, audience_field_id FROM reward WHERE event_id = $1 ORDER BY name_en",
      [target],
    );
    expect(rewards.map((r) => [r.name_en, r.stock_total, r.units_out])).toEqual([
      ["Cap", 20, 0],
      ["Voucher", 0, 0],
    ]);
    expect(rewards[0]?.audience_field_id).not.toBeNull();
    const prizes = await f.owner<{ name_en: string }>(
      "SELECT name_en FROM rank_prize WHERE event_id = $1",
      [target],
    );
    expect(prizes.map((p) => p.name_en)).toEqual(["Tour"]);
    const [pin] = await f.owner<{ quest_id: string }>(
      "SELECT quest_id FROM map_pin WHERE event_id = $1",
      [target],
    );
    expect(pin?.quest_id).toBe(scan?.id);
    const [session] = await f.owner<{ quest_id: string; points: number }>(
      "SELECT quest_id, points FROM event_session WHERE event_id = $1",
      [target],
    );
    expect(session?.quest_id).toBe(scan?.id);
    expect(session?.points).toBe(40);
    const [tag] = await f.owner<{ quest_id: string }>(
      "SELECT quest_id FROM sponsor_tag WHERE event_id = $1",
      [target],
    );
    expect(tag?.quest_id).toBe(scan?.id);
  });

  it("copies the event's own settings, switches, words and default topics", async () => {
    const target = await draft();
    await copy(source, target);
    const [row] = await f.owner<Record<string, unknown>>(
      `SELECT status, activated_at, config, pickup_minutes, shop_days_after, welcome_points, rules_en, award_cap_each,
              award_cap_day, player_limit_mode, player_limit, email_domains, desk_location_en, join_code,
              (SELECT array_agg(topic) FROM event_topic_off WHERE event_id = event.id) AS topics,
              (SELECT bonus_points FROM event_streak WHERE event_id = event.id) AS streak,
              (SELECT scenes FROM big_screen WHERE event_id = event.id) AS scenes
       FROM event WHERE id = $1`,
      [target],
    );
    expect(row).toMatchObject({
      status: "draft",
      activated_at: null,
      pickup_minutes: 60,
      shop_days_after: 5,
      welcome_points: 7,
      rules_en: "Be kind",
      award_cap_each: 150,
      award_cap_day: 400,
      player_limit_mode: "none",
      player_limit: null,
      email_domains: ["acme.test"],
      desk_location_en: "Hall B",
      topics: ["rank"],
      streak: 5,
      scenes: ["poll", "ranking"],
    });
    expect(row?.["config"]).toEqual({
      features: { ranking: false, questRatings: true },
      terms: { currency: { en: "Gems" } },
    });
    expect(row?.["join_code"]).toBe(`DUP${counter}`);
  });

  it("moves every time by the distance between the two starts and leaves the source alone", async () => {
    const [before] = await f.owner<{ s: string }>(
      "SELECT md5(string_agg(q::text, '|' ORDER BY q.id)) AS s FROM quest q WHERE q.event_id = $1",
      [source],
    );
    const target = await draft(30);
    await copy(source, target);
    const [row] = await f.owner<{
      shift: number;
      code_open: number;
      session_start: number;
      zone_open: number;
      desk: number;
    }>(
      `SELECT extract(epoch FROM t.starts_at - s.starts_at) AS shift,
        (SELECT extract(epoch FROM q.opens_at) FROM quest q WHERE q.event_id = t.id AND q.title_en = 'Type the word')
          - (SELECT extract(epoch FROM q.opens_at) FROM quest q WHERE q.event_id = s.id AND q.title_en = 'Type the word') AS code_open,
        (SELECT extract(epoch FROM x.starts_at) FROM event_session x WHERE x.event_id = t.id)
          - (SELECT extract(epoch FROM x.starts_at) FROM event_session x WHERE x.event_id = s.id) AS session_start,
        (SELECT extract(epoch FROM c.opens_at) FROM category c WHERE c.event_id = t.id AND c.name_en = 'Zone B')
          - (SELECT extract(epoch FROM c.opens_at) FROM category c WHERE c.event_id = s.id AND c.name_en = 'Zone B') AS zone_open,
        extract(epoch FROM lower(t.desk_hours) - t.starts_at) AS desk
       FROM event t, event s WHERE t.id = $1 AND s.id = $2`,
      [target, source],
    );
    expect(row?.code_open).toBeCloseTo(row?.shift ?? 0, 0);
    expect(row?.session_start).toBeCloseTo(row?.shift ?? 0, 0);
    expect(row?.zone_open).toBeCloseTo(row?.shift ?? 0, 0);
    expect(row?.desk).toBeCloseTo(0, 0);
    const [after] = await f.owner<{ s: string }>(
      "SELECT md5(string_agg(q::text, '|' ORDER BY q.id)) AS s FROM quest q WHERE q.event_id = $1",
      [source],
    );
    expect(after?.s).toBe(before?.s);
  });

  it.each([
    ["2 days 14 hours", "2030-03-10 09:00+03", "2030-03-12 23:00+03", 2],
    ["3 days 17 hours across the day's start", "2030-03-10 09:00+03", "2030-03-14 02:00+03", 3],
  ])(
    "moves the streak's closed days by event days, not by a rounded shift (%s)",
    async (_name, from, to, days) => {
      const dated = async (startsAt: string): Promise<string> => {
        counter += 1;
        return one(
          `INSERT INTO event (organizer_id, join_code, name_en, starts_at, ends_at)
         VALUES ($1, $2, 'Dated', $3::timestamptz, $3::timestamptz + interval '1 day') RETURNING id`,
          [f.ids.orgA, `DUP${counter}`, startsAt],
        );
      };
      const closed = async (event: string): Promise<string[]> =>
        (
          await f.owner<{ day: string }>(
            "SELECT d::text AS day FROM event_streak, unnest(closed_days) AS d WHERE event_id = $1 ORDER BY d",
            [event],
          )
        ).map((row) => row.day);
      const origin = await dated(from);
      await f.owner(
        `INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points, closed_days)
       SELECT id, organizer_id, true, 5, '{2030-03-11,2030-03-15}' FROM event WHERE id = $1`,
        [origin],
      );
      const target = await dated(to);
      await copy(origin, target);
      const expected = ["2030-03-11", "2030-03-15"].map((day) =>
        new Date(Date.parse(day) + days * DAY).toISOString().slice(0, 10),
      );
      expect(await closed(target)).toEqual(expected);
    },
  );

  it("copies no person, play row, code, device, tag or live operation", async () => {
    const target = await draft();
    await copy(source, target);
    const tables = await f.owner<{ table_name: string }>(
      `SELECT DISTINCT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'event_id' AND t.table_type = 'BASE TABLE'
       ORDER BY 1`,
    );
    expect(tables.length).toBeGreaterThan(60);
    const names = tables.map((t) => t.table_name);
    expect(names.filter((name) => !COPIED.has(name) && !NOT_COPIED.has(name))).toEqual([]);
    const notCopied = names.filter((name) => NOT_COPIED.has(name) && name !== "audit_log");
    for (const name of notCopied) {
      expect(await count(name, target), name).toBe(0);
    }
    // The source did hold such rows, so the checks above are not empty ones.
    for (const name of [
      "enrollment",
      "quest_completion",
      "ledger_entry",
      "reward_code",
      "nfc_tag",
      "boost",
      "event_guest",
    ]) {
      expect(await count(name, source), name).toBeGreaterThan(0);
    }
  });

  it("writes one audit entry that names the source and the counts", async () => {
    const target = await draft();
    await copy(source, target);
    const rows = await f.owner<{ after: Record<string, unknown>; actor_id: string }>(
      "SELECT after, actor_id FROM audit_log WHERE event_id = $1 AND action = 'event.duplicate'",
      [target],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toMatchObject({ source, quests: expect.any(Number) as number });
    expect(rows[0]?.actor_id).toBe(f.ownerA);
  });

  it("refuses an event onto itself and a target that is not an empty draft", async () => {
    expect(await refusal(copy(source, source))).toBe("ED422:same_event");
    const target = await draft();
    await copy(source, target);
    expect(await refusal(copy(source, target))).toBe("ED409:target_not_empty");
    const live = await draft();
    await f.owner("UPDATE event SET status = 'scheduled' WHERE id = $1", [live]);
    expect(await refusal(copy(source, live))).toBe("ED409:target_not_empty");
    const joined = await draft();
    await f.join(joined, await f.newPlayer());
    expect(await refusal(copy(source, joined))).toBe("ED409:target_not_empty");
    expect(await count("quest", joined)).toBe(0);
  });

  it("works only between events of the caller's own organizer and scope", async () => {
    const foreign = await f.newEvent({ organizer: f.ids.orgB });
    const mine = await draft();
    expect(await refusal(copy(foreign, mine))).toBe("AN404");
    const theirs = await draft(30, f.ids.orgB);
    expect(await refusal(copy(source, theirs))).toBe("AN404");
    expect(await count("category", theirs)).toBe(1);
    const limited = await addMember(f.db.owner, f.ids.orgA, "editor", [source]);
    const other = await draft();
    expect(await refusal(copy(source, other, f.team(limited)))).toBe("AN404");
    const seat = { organizerId: f.ids.orgA };
    expect(await refusal(copy(source, other, seat))).toBe("AN404");
  });
});
