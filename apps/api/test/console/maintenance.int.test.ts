import { createHash, randomBytes, randomUUID } from "node:crypto";
import { noticesViewSchema, type NoticesView } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Method = "GET" | "PUT" | "DELETE" | "POST";
type Json = Record<string, unknown>;

const PAUSE = { ar: "الصيانة جارية.", en: "Under maintenance." };
const OWN = { ar: "هذه الفعالية متوقفة.", en: "This event is paused." };
const SWITCHES = "/v1/admin/switches";
const code = (answer: { json: () => unknown }) => (answer.json() as { code?: string }).code;
const WINDOW = { startsAt: "2026-11-05T15:00:00.000Z", endsAt: "2026-11-05T18:00:00.000Z" };

/**
 * Maintenance mode and the scheduled banner (T-703b, FR-1771, FR-1772) over HTTP: the console doors are for an active
 * admin only, every change is audited with its before and after, the composed configuration carries the pause and the
 * banner, and the play doors answer 503 `maintenance` for the platform or for the paused event only. Reads, leaving, the
 * team's doors, the console and the configuration door are never held.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("maintenance mode and the banner (HTTP)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let memberCookie = "";
  let eventA = "";
  let eventB = "";
  let token = "";
  let questA = "";
  let questB = "";
  let categoryA = "";
  let rewardA = "";
  let stepA = "";

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []): Promise<string> =>
    (await owner<{ id: string }>(sql, values))[0]?.id ?? "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const seed = await seedTwoTenants(db.owner);
    eventA = seed.eventA;
    eventB = seed.eventB;
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const member = await createStaff(db.owner, { email: "member@najd.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [seed.orgA, member],
    );
    adminCookie = await signInFully(test, "admin@questify.test");
    memberCookie = await signInFully(test, "member@najd.test");
    token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [seed.playerA, createHash("sha256").update(token).digest()],
    );
    for (const [event, name] of [
      [eventA, "A"],
      [eventB, "B"],
    ] as const) {
      const category = await one(
        "INSERT INTO category (event_id, name_en) VALUES ($1, $2) RETURNING id",
        [event, `General ${name}`],
      );
      const quest = await one(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'enter_code', 'Booth', 10, '{"code": "ABC123"}') RETURNING id`,
        [event, category],
      );
      if (event === eventA) {
        categoryA = category;
        questA = quest;
        rewardA = await one(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 40, 8) RETURNING id",
          [event],
        );
        stepA = await one(
          `WITH q AS (
             INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
             VALUES ($1, $2, 'passport', 'Trail', 10, '{"needed": 1}') RETURNING id
           )
           INSERT INTO passport_step (event_id, quest_id, name_en, position)
           SELECT $1, q.id, 'Stop', 0 FROM q RETURNING id`,
          [event, category],
        );
      } else {
        questB = quest;
      }
    }
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const console = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const admin = (method: Method, url: string, payload?: object) =>
    console(method, url, adminCookie, payload);
  const player = (method: Method, url: string, payload: object = {}, key: string = randomUUID()) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(method === "GET" ? {} : { payload }),
    });
  const notices = async (): Promise<NoticesView> =>
    noticesViewSchema.parse((await admin("GET", `${SWITCHES}/notices`)).json());
  const audits = async (block: string) =>
    owner<{ before: Json | null; after: Json }>(
      `SELECT before, after FROM audit_log WHERE action = 'platform_settings.update' AND (after ? $1 OR before ? $1) ORDER BY id`,
      [block],
    );

  const DOORS = () =>
    [
      ["POST", `/v1/quests/${questA}/complete`, { proof: { type: "code", code: "ABC123" } }],
      ["POST", `/v1/steps/${stepA}/stamp`, {}],
      ["POST", `/v1/categories/${categoryA}/reveal`, {}],
      ["POST", `/v1/rewards/${rewardA}/reserve`, {}],
      ["PUT", `/v1/events/${eventA}/goal`, {}],
      ["POST", "/v1/join", { joinCode: "NAJD1", via: "code" }],
      ["POST", "/v1/join", { eventId: eventA, via: "invite" }],
    ] as const;

  it("answers 404 to a team member and 401 to nobody signed in, on every notices door", async () => {
    const doors: [Method, string, object?][] = [
      ["GET", `${SWITCHES}/notices`],
      ["PUT", `${SWITCHES}/maintenance/global`, { message: PAUSE }],
      ["DELETE", `${SWITCHES}/maintenance/global`],
      ["PUT", `${SWITCHES}/maintenance/events`, { joinCode: "NAJD1", message: OWN }],
      ["DELETE", `${SWITCHES}/maintenance/events/${eventA}`],
      ["PUT", `${SWITCHES}/banner`, { message: PAUSE, ...WINDOW }],
      ["DELETE", `${SWITCHES}/banner`],
    ];
    for (const [method, url, payload] of doors) {
      expect((await console(method, url, memberCookie, payload)).statusCode, url).toBe(404);
      const signedOut = await test.app.inject({
        method,
        url,
        headers: withSession("", { "idempotency-key": randomUUID() }),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(signedOut.statusCode, url).toBe(401);
      const asPlayer = await player(method, url, payload ?? {});
      expect(asPlayer.statusCode, url).toBeGreaterThanOrEqual(401);
      expect(asPlayer.statusCode, url).not.toBe(204);
    }
    expect(await notices()).toEqual({
      maintenance: { global: null, events: [] },
      banner: null,
    });
  });

  it("lets every play door through while nothing is paused", async () => {
    for (const [method, url, body] of DOORS()) {
      expect(code(await player(method, url, body)), url).not.toBe("maintenance");
    }
    const config = (await test.app.inject({ method: "GET", url: "/v1/config" })).json<Json>();
    expect(config).toMatchObject({ maintenance: null, banner: null });
  });

  it("pauses one event with its message: its doors answer 503, another event plays", async () => {
    const missing = await admin("PUT", `${SWITCHES}/maintenance/events`, {
      joinCode: "NOSUCH",
      message: OWN,
    });
    expect(missing.statusCode).toBe(404);
    const half = await admin("PUT", `${SWITCHES}/maintenance/events`, {
      joinCode: "NAJD1",
      message: { ar: "x", en: "" },
    });
    expect(half.statusCode).toBe(422);

    const paused = await admin("PUT", `${SWITCHES}/maintenance/events`, {
      joinCode: "najd1",
      message: OWN,
    });
    expect(paused.statusCode).toBe(204);
    const view = await notices();
    expect(view.maintenance.events).toEqual([
      { eventId: eventA, joinCode: "NAJD1", name: { ar: null, en: "Tech Fest" }, message: OWN },
    ]);

    for (const [method, url, body] of DOORS()) {
      const answer = await player(method, url, body);
      expect(answer.statusCode, url).toBe(503);
      expect(answer.json()).toMatchObject({
        code: "maintenance",
        message: OWN,
        details: { scope: "event" },
      });
    }
    const other = await player("POST", `/v1/quests/${questB}/complete`, {
      proof: { type: "code", code: "ABC123" },
    });
    expect(code(other)).not.toBe("maintenance");
    expect(code(await player("POST", "/v1/join", { joinCode: "TABUK1", via: "code" }))).not.toBe(
      "maintenance",
    );
    expect(code(await player("POST", "/v1/me/questify/sync"))).not.toBe("maintenance");

    const own = await player("GET", `/v1/events/${eventA}/config`);
    expect(own.json()).toMatchObject({ maintenance: OWN });
    const platform = (await test.app.inject({ method: "GET", url: "/v1/config" })).json<Json>();
    expect(platform["maintenance"]).toBeNull();

    expect((await audits("maintenance")).at(-1)).toMatchObject({
      before: { maintenance: null },
      after: { maintenance: { events: { [eventA]: OWN } } },
    });
  });

  it("keeps reads, leaving, the team's doors and the console open while an event is paused", async () => {
    expect((await player("GET", "/v1/me")).statusCode).toBe(200);
    expect((await player("GET", `/v1/events/${eventA}/shop`)).statusCode).not.toBe(503);
    expect((await player("POST", `/v1/events/${eventA}/leave`)).statusCode).not.toBe(503);
    expect((await console("GET", `/v1/events/${eventA}/config`, memberCookie)).statusCode).not.toBe(
      503,
    );
    expect((await admin("GET", `${SWITCHES}`)).statusCode).toBe(200);
  });

  it("resumes the event, and a second resume changes nothing and writes no audit entry", async () => {
    const before = (await audits("maintenance")).length;
    expect((await admin("DELETE", `${SWITCHES}/maintenance/events/${eventA}`)).statusCode).toBe(
      204,
    );
    expect((await notices()).maintenance.events).toEqual([]);
    expect((await admin("DELETE", `${SWITCHES}/maintenance/events/${eventA}`)).statusCode).toBe(
      204,
    );
    expect((await audits("maintenance")).length).toBe(before + 1);
    expect(code(await player("PUT", `/v1/events/${eventA}/goal`))).not.toBe("maintenance");
  });

  it("pauses the whole platform: every play door answers 503, the config and the console stay up", async () => {
    expect(
      (await admin("PUT", `${SWITCHES}/maintenance/global`, { message: { ar: "", en: "x" } }))
        .statusCode,
    ).toBe(422);
    expect(
      (await admin("PUT", `${SWITCHES}/maintenance/global`, { message: PAUSE })).statusCode,
    ).toBe(204);
    const key = randomUUID();
    for (const [method, url, body] of [
      ...DOORS(),
      ["POST", `/v1/quests/${questB}/complete`, {}],
      ["POST", "/v1/me/questify/sync", {}],
    ] as const) {
      const answer = await player(method, url, body, key + url.length);
      expect(answer.statusCode, url).toBe(503);
      expect(answer.json()).toMatchObject({
        code: "maintenance",
        message: PAUSE,
        details: { scope: "platform" },
      });
    }
    const config = (await test.app.inject({ method: "GET", url: "/v1/config" })).json<Json>();
    expect(config["maintenance"]).toEqual(PAUSE);
    expect((await player("GET", "/v1/me")).statusCode).toBe(200);
    expect((await admin("GET", `${SWITCHES}/notices`)).statusCode).toBe(200);
    expect((await admin("GET", `${SWITCHES}`)).statusCode).toBe(200);
    expect((await console("GET", `/v1/events/${eventA}/config`, memberCookie)).statusCode).not.toBe(
      503,
    );
  });

  it("frees the idempotency key of a held call, so the retry after maintenance runs", async () => {
    const key = randomUUID();
    const url = `/v1/quests/${questA}/complete`;
    const body = { proof: { type: "code", code: "ABC123" } };
    expect((await player("POST", url, body, key)).statusCode).toBe(503);
    expect((await admin("DELETE", `${SWITCHES}/maintenance/global`)).statusCode).toBe(204);
    const retried = await player("POST", url, body, key);
    expect(retried.statusCode).not.toBe(503);
    expect(retried.statusCode).not.toBe(409);
    expect(retried.headers["idempotent-replayed"]).toBeUndefined();
    expect((await audits("maintenance")).at(-1)).toMatchObject({
      before: { maintenance: { global: PAUSE, events: {} } },
      after: { maintenance: { events: {} } },
    });
  });

  it("schedules, replaces and removes the banner, and the apps read it from the configuration", async () => {
    const badWindow = await admin("PUT", `${SWITCHES}/banner`, {
      message: PAUSE,
      startsAt: WINDOW.endsAt,
      endsAt: WINDOW.startsAt,
    });
    expect(badWindow.statusCode).toBe(422);
    expect(badWindow.json()).toMatchObject({ details: { issues: [{ path: "endsAt" }] } });
    expect(
      (
        await admin("PUT", `${SWITCHES}/banner`, {
          message: PAUSE,
          startsAt: "soon",
          endsAt: "later",
        })
      ).statusCode,
    ).toBe(422);

    expect(
      (await admin("PUT", `${SWITCHES}/banner`, { message: PAUSE, ...WINDOW })).statusCode,
    ).toBe(204);
    expect((await notices()).banner).toEqual({ message: PAUSE, ...WINDOW });
    const config = (await test.app.inject({ method: "GET", url: "/v1/config" })).json<Json>();
    expect(config["banner"]).toEqual({ message: PAUSE, ...WINDOW });
    // A banner never pauses play.
    expect(code(await player("POST", `/v1/quests/${questA}/complete`, {}))).not.toBe("maintenance");

    expect((await admin("DELETE", `${SWITCHES}/banner`)).statusCode).toBe(204);
    expect((await notices()).banner).toBeNull();
    const cleared = (await test.app.inject({ method: "GET", url: "/v1/config" })).json<Json>();
    expect(cleared["banner"]).toBeNull();
    expect((await audits("banner")).map((row) => row.after)).toEqual([
      { banner: { message: PAUSE, ...WINDOW } },
      { banner: {} },
    ]);
  });
});
