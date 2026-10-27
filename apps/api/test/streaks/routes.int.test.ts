import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  dailyStreakSchema,
  eventStreakSchema,
  questifySyncSchema,
  streakBonusSchema,
  streakSettingsSchema,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Reply = { statusCode: number; json: () => Row };
const codeOf = (response: Reply) => [response.statusCode, response.json()["code"]];

/**
 * Streaks over HTTP (T-405): the event streak's settings for owners (PUT) and editors (GET) with every refusal, the
 * completion answer's `streakBonus`, event Home's `streak`, the history's `streakDays`, `/v1/me`'s `dailyStreak`, the
 * sync's `dailyStreak`, the platform switch flipped through the settings service, and staff kept out of player doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("streaks over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let admin: PublicAccount;
  let organizer = "";
  let ownerCookie = "";
  let editorCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool, ttlMs: 0 });
    test = await startApp(db, false, {}, { settings });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('streak-org', 'streak-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    for (const [email, role] of [
      ["owner@streak.test", "owner"],
      ["editor@streak.test", "editor"],
    ] as const) {
      const id = await createStaff(db.owner, { email });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
        [organizer, id, role],
      );
    }
    ownerCookie = await signInFully(test, "owner@streak.test");
    editorCookie = await signInFully(test, "editor@streak.test");
    const adminId = await createStaff(db.owner, { email: "root@streak.test", admin: true });
    admin = { id: adminId, email: "root@streak.test", status: "active", platformRole: "admin" };
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (single = false): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, timezone, day_start_hour)
       VALUES ($1, $2, 'Streak Fest', 'live', now() - $3::interval, now() + $3::interval, 'UTC',
               CASE WHEN $4 THEN (extract(hour FROM now() AT TIME ZONE 'UTC')::int + 12) % 24 ELSE 4 END)
       RETURNING id`,
      [organizer, `STH${counter}`, single ? "1 hour" : "3 days", single],
    );
    await owner(
      "INSERT INTO category (event_id, name_en) SELECT $1, 'General' WHERE NOT EXISTS (SELECT 1 FROM category WHERE event_id = $1)",
      [event?.id],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, (SELECT id FROM category WHERE event_id = $1 LIMIT 1), 'enter_code', 'Falcon', 10, 5,
                 '{"code":"FALCON"}') RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`streak_http_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(token).digest()],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    return { token, player: player?.id ?? "", enrollment: enrolled?.id ?? "" };
  };
  /** Yesterday's day row, as the trigger would have written it (a test cannot move the clock). */
  const playedYesterday = (event: string, quest: string, enrollment: string) =>
    owner(
      `WITH c AS (
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'code', gen_random_uuid()::text) RETURNING id)
       INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
       SELECT $3, event_day(now(), e) - 1, $1, $2, 1, c.id FROM c, event e WHERE e.id = $2`,
      [organizer, event, enrollment, quest],
    );
  const player = (method: "GET" | "POST", path: string, token: string, payload?: object) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    });
  const team = (
    cookie: string,
    method: "GET" | "PUT",
    event: string,
    payload?: unknown,
    key = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}/events/${event}/streak`,
      headers: withSession(cookie, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const BODY = { enabled: true, bonusPoints: 5, closedWeekdays: [], closedDays: [] };

  it("reads for owners and editors, sets for owners, replays the same key", async () => {
    const event = await newEvent();
    for (const cookie of [ownerCookie, editorCookie]) {
      const read = await team(cookie, "GET", event);
      expect(read.statusCode).toBe(200);
      expect(streakSettingsSchema.parse(read.json()["streak"])).toMatchObject({
        enabled: false,
        bonusPoints: null,
        multiDay: true,
      });
    }
    const key = randomUUID();
    const set = await team(ownerCookie, "PUT", event, BODY, key);
    expect(set.statusCode).toBe(200);
    expect(set.json()["streak"]).toMatchObject({ ...BODY, multiDay: true });
    expect((await team(ownerCookie, "PUT", event, BODY, key)).json()).toEqual(set.json());
    expect((await team(ownerCookie, "PUT", event, BODY)).statusCode).toBe(200);
    const audits = await owner(
      "SELECT 1 FROM audit_log WHERE event_id = $1 AND action = 'event.streak_set'",
      [event],
    );
    expect(audits).toHaveLength(1);
    expect(codeOf(await team(editorCookie, "PUT", event, BODY))[0]).toBe(403);
  });

  it("answers each refusal: the field at fault, the conflict's reason and day, a missing event", async () => {
    const event = await newEvent();
    for (const [body, field] of [
      [{ ...BODY, bonusPoints: 0 }, "bonusPoints"],
      [{ ...BODY, closedWeekdays: [8] }, "closedWeekdays"],
      [{ ...BODY, closedDays: ["soon"] }, "closedDays"],
      [{ ...BODY, enabled: "yes" }, "enabled"],
    ] as const) {
      const refused = await team(ownerCookie, "PUT", event, body);
      expect([refused.statusCode, refused.json()["code"], refused.json()["details"]]).toEqual([
        422,
        "invalid_streak",
        { field },
      ]);
    }
    for (const body of [{ ...BODY, freeze: true }, null, [BODY], []]) {
      expect(codeOf(await team(ownerCookie, "PUT", event, body)), JSON.stringify(body)).toEqual([
        400,
        "invalid_request",
      ]);
    }
    // A bad listed field is named even beside an unknown key.
    const both = await team(ownerCookie, "PUT", event, { ...BODY, bonusPoints: 0, freeze: true });
    expect(both.json()).toMatchObject({
      code: "invalid_streak",
      details: { field: "bonusPoints" },
    });
    const outside = await team(ownerCookie, "PUT", event, { ...BODY, closedDays: ["2001-01-01"] });
    expect(outside.json()).toMatchObject({
      code: "invalid_streak",
      details: { field: "closedDays" },
    });
    const [today] = await owner<{ d: string }>(
      "SELECT event_day(now(), e)::text AS d FROM event e WHERE e.id = $1",
      [event],
    );
    const started = await team(ownerCookie, "PUT", event, { ...BODY, closedDays: [today?.d] });
    expect([started.statusCode, started.json()["code"], started.json()["details"]]).toEqual([
      409,
      "streak_conflict",
      { reason: "day_started", day: today?.d },
    ]);
    const single = await team(ownerCookie, "PUT", await newEvent(true), BODY);
    expect([single.statusCode, single.json()["details"]]).toEqual([409, { reason: "single_day" }]);
    expect(codeOf(await team(ownerCookie, "GET", randomUUID()))).toEqual([404, "not_found"]);
    expect(codeOf(await team(ownerCookie, "PUT", randomUUID(), BODY))).toEqual([404, "not_found"]);
  });

  it("pays and shows the bonus on the completion, event Home and the history", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    expect((await team(ownerCookie, "PUT", event, BODY)).statusCode).toBe(200);
    const one = await newPlayer(event);
    await playedYesterday(event, quest, one.enrollment);
    const paid = await player("POST", `/v1/quests/${quest}/complete`, one.token, {
      proof: { type: "code", code: "FALCON" },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ points: 10, score: 15 });
    expect(streakBonusSchema.parse(paid.json()["streakBonus"])).toEqual({ points: 5, days: 2 });
    const again = await player("POST", `/v1/quests/${quest}/complete`, one.token, {
      proof: { type: "code", code: "FALCON" },
    });
    expect(again.json()["streakBonus"]).toBeNull();

    const home = await player("GET", `/v1/events/${event}/home`, one.token);
    expect(eventStreakSchema.parse(home.json()["streak"])).toEqual({
      days: 2,
      playedToday: true,
      closedToday: false,
      bonusPoints: 5,
    });
    const history = (await player("GET", `/v1/events/${event}/activity`, one.token)).json() as {
      entries: { kind: string; streakDays: number | null }[];
    };
    expect(history.entries.map((entry) => [entry.kind, entry.streakDays])).toEqual([
      ["quest", null],
      ["streak", 2],
      ["quest", null],
    ]);
    // Off, Home shows no streak at all.
    await team(ownerCookie, "PUT", event, { ...BODY, enabled: false });
    expect(
      (await player("GET", `/v1/events/${event}/home`, one.token)).json()["streak"],
    ).toBeNull();
  });

  it("answers the daily streak on /v1/me and the sync, and null while the platform switch is off", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const one = await newPlayer(event);
    await player("POST", `/v1/quests/${quest}/complete`, one.token, {
      proof: { type: "code", code: "FALCON" },
    });
    const me = (await player("GET", "/v1/me", one.token)).json();
    expect(dailyStreakSchema.parse(me["dailyStreak"])).toEqual({
      days: 1,
      today: true,
      next: { days: 3, xp: 50 },
    });
    const synced = questifySyncSchema.parse(
      (await player("POST", "/v1/me/questify/sync", one.token)).json(),
    );
    expect(synced.dailyStreak).toEqual({
      days: 1,
      today: true,
      next: { days: 3, xp: 50 },
      rewards: [],
    });

    const saved = await settings.savePlatformSettings(admin, {
      features: { dailyStreak: { enabled: false } },
    });
    expect(saved).toMatchObject({ ok: true });
    try {
      const config = (await test.app.inject({ method: "GET", url: "/v1/config" })).json() as {
        features: Record<string, { enabled: boolean }>;
      };
      expect(config.features["dailyStreak"]?.enabled).toBe(false);
      expect((await player("GET", "/v1/me", one.token)).json()["dailyStreak"]).toBeNull();
      const off = questifySyncSchema.parse(
        (await player("POST", "/v1/me/questify/sync", one.token)).json(),
      );
      expect(off.dailyStreak).toBeNull();
    } finally {
      await settings.savePlatformSettings(admin, { features: { dailyStreak: { enabled: true } } });
    }
  });

  it("keeps staff out of the player doors and players out of the team doors", async () => {
    const event = await newEvent();
    const one = await newPlayer(event);
    for (const url of ["/v1/me", `/v1/events/${event}/home`]) {
      const staff = await test.app.inject({
        method: "GET",
        url,
        headers: withSession(ownerCookie),
      });
      expect(staff.statusCode, url).toBe(401);
    }
    const asPlayer = await test.app.inject({
      method: "GET",
      url: `/v1/organizers/${organizer}/events/${event}/streak`,
      headers: { authorization: `Bearer ${one.token}` },
    });
    expect(asPlayer.statusCode).toBe(401);
  });
});
