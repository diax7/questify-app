import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  DASHBOARD_ORIGIN,
  createStaff,
  freshIp,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Person = Readonly<{ id: string; token: string; username: string }>;
type Response = Readonly<{
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: <T = Row>() => T;
}>;

const MY_KEY = createMyCodeKey(testConfig().qrSecret);
const codeOf = (response: Response) => [
  response.statusCode,
  response.json<{ code?: string }>().code,
];
const cookieOf = (response: Response): string => {
  const header = response.headers["set-cookie"];
  const value = String(Array.isArray(header) ? header[0] : header);
  return value.split(";")[0] ?? "";
};

/**
 * The kiosk over HTTP (T-309b): the player's live code, a kiosk scan's three answers and every refusal, the UUID key,
 * the limits (31st scan, 11th bad code, 7th live code), the `kiosks` switch, the cross-credential walls, and that no
 * code, player id or username reaches a log line.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("kiosks over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;
  const logs: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(
      db,
      { level: "debug", stream: { write: (line: string) => void logs.push(line) } },
      {},
      { settings },
    );
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('kiosk-org', 'kiosk-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@kiosks.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@kiosks.test");
  });
  beforeEach(async () => {
    await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'device_claim'");
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Hall Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `KSKH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, verification = ["kiosk"], repeat = 100) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, verification)
         SELECT $1, id, 'scan_qr', 'Gate', 10, $3, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, verification, repeat],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string | null): Promise<Person> => {
    counter += 1;
    const username = `ksk_http_${counter}`;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== null) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [organizer, event, id],
      );
    }
    return { id, token, username };
  };
  const pair = (kind: string) =>
    test.app.inject({
      method: "POST",
      url: "/v1/device/pairing",
      headers: { origin: DASHBOARD_ORIGIN, "x-forwarded-for": freshIp() },
      payload: { kind },
    }) as Promise<Response>;
  const dashboard = (method: "GET" | "POST", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  /** A kiosk (or a station) paired from the dashboard and activated: its current cookie. */
  const paired = async (event: string, quest: string, kind = "kiosk") => {
    const page = await pair(kind);
    const claimed = await dashboard("POST", `/events/${event}/devices`, {
      code: page.json<{ code: string }>().code,
      kind,
      questId: quest,
      label: "Gate tablet",
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    const activated = await test.app.inject({
      method: "POST",
      url: "/v1/device/activate",
      headers: { cookie: cookieOf(page), origin: DASHBOARD_ORIGIN },
      payload: {},
    });
    return cookieOf(activated as Response);
  };
  const liveCodeOf = (who: Person, headers: Record<string, string> = {}) =>
    test.app.inject({
      method: "GET",
      url: "/v1/me/live-code",
      headers: { authorization: `Bearer ${who.token}`, ...headers },
    }) as Promise<Response>;
  const send = (
    cookie: string,
    code: string,
    headers: Record<string, string | undefined> = {},
  ): Promise<Response> => {
    const all: Record<string, string> = {
      cookie,
      origin: DASHBOARD_ORIGIN,
      "idempotency-key": randomUUID(),
    };
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) {
        delete all[name];
      } else {
        all[name] = value;
      }
    }
    return test.app.inject({
      method: "POST",
      url: "/v1/device/kiosk-scans",
      headers: all,
      payload: { code },
    }) as Promise<Response>;
  };
  const freshCode = async (who: Person) => {
    const answer = await liveCodeOf(who);
    expect(answer.statusCode, answer.body).toBe(200);
    return answer.json<{ code: string; changesInMs: number }>().code;
  };
  const withKiosksOff = async (work: () => Promise<void>) => {
    await owner("INSERT INTO platform_setting (key, value) VALUES ('features', $1)", [
      JSON.stringify({ kiosks: { enabled: false } }),
    ]);
    settings.forget();
    try {
      await work();
    } finally {
      await owner("DELETE FROM platform_setting WHERE key = 'features'");
      settings.forget();
    }
  };

  // ============================================================ the live code
  it("serves the player's live code, no-store, changing within 30 s; 6 a minute", async () => {
    const who = await newPlayer(null);
    const answer = await liveCodeOf(who);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    const body = answer.json<{ code: string; changesInMs: number }>();
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{50}$/);
    expect(body.changesInMs).toBeGreaterThan(0);
    expect(body.changesInMs).toBeLessThanOrEqual(30_000);
    for (let index = 0; index < 5; index += 1) {
      expect((await liveCodeOf(who)).statusCode).toBe(200);
    }
    const held = await liveCodeOf(who);
    expect(codeOf(held)).toEqual([429, "too_many_attempts"]);
    expect(held.headers["retry-after"]).toBeDefined();
  });

  it("answers feature_off for the live code, a scan and the kiosk's state while kiosks are off", async () => {
    const event = await newEvent();
    const cookie = await paired(event, await newQuest(event));
    const who = await newPlayer(event);
    const code = await freshCode(who);
    await withKiosksOff(async () => {
      expect(codeOf(await liveCodeOf(who))).toEqual([403, "feature_off"]);
      expect(codeOf(await send(cookie, code))).toEqual([403, "feature_off"]);
      const state = await test.app.inject({
        method: "GET",
        url: "/v1/device",
        headers: { cookie, origin: DASHBOARD_ORIGIN },
      });
      expect(state.json()).toMatchObject({ kind: "kiosk", shut: "feature_off" });
    });
  });

  // ============================================================ the scan
  it("pays a live code: green with the @username and avatar; a retry replays; the same code again is orange", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const cookie = await paired(event, quest);
    const state = await test.app.inject({
      method: "GET",
      url: "/v1/device",
      headers: { cookie, origin: DASHBOARD_ORIGIN },
    });
    expect(state.json()).toMatchObject({ kind: "kiosk", shut: null, quest: { points: 10 } });
    const who = await newPlayer(event);
    const code = await freshCode(who);
    const key = randomUUID();
    const paid = await send(cookie, code, { "idempotency-key": key });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.headers["cache-control"]).toBe("no-store");
    expect(paid.json()).toEqual({
      result: "completed",
      player: { username: who.username, avatar: expect.any(String) },
      points: 10,
      boosted: false,
      replayed: false,
    });
    const again = await send(cookie, code, { "idempotency-key": key });
    expect(again.json()).toMatchObject({ result: "completed", points: 10 });
    const orange = await send(cookie, code);
    expect(orange.json()).toEqual({
      result: "already_completed",
      player: { username: who.username, avatar: expect.any(String) },
    });
    const [row] = await owner<{ method: string; n: number }>(
      "SELECT method, count(*) OVER ()::int AS n FROM quest_completion WHERE quest_id = $1",
      [quest],
    );
    expect(row).toEqual({ method: "kiosk", n: 1 });
  });

  it("refuses with the reason only, never naming anyone", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const cookie = await paired(event, quest);
    const stranger = await newPlayer(await newEvent());
    expect((await send(cookie, await freshCode(stranger))).json()).toEqual({
      result: "refused",
      reason: "not_in_event",
    });
    const fixed = myCode(MY_KEY, stranger.id, 1);
    expect((await send(cookie, fixed)).json()).toEqual({
      result: "refused",
      reason: "needs_live_code",
    });
    expect((await send(cookie, "not a questify code")).json()).toEqual({
      result: "refused",
      reason: "invalid_code",
    });
    const left = await newPlayer(event);
    await owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1", [left.id]);
    expect((await send(cookie, await freshCode(left))).json()).toEqual({
      result: "refused",
      reason: "not_open",
    });
    await owner("UPDATE quest SET verification = '{quest_qr}' WHERE id = $1", [quest]);
    expect((await send(cookie, await freshCode(await newPlayer(event)))).json()).toEqual({
      result: "refused",
      reason: "method_off",
    });
  });

  it("needs a UUID Idempotency-Key, the dashboard's Origin and a kiosk cookie", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, ["screen_qr", "kiosk"]);
    const cookie = await paired(event, quest);
    const code = await freshCode(await newPlayer(event));
    expect(codeOf(await send(cookie, code, { "idempotency-key": "not-a-uuid" }))).toEqual([
      400,
      "invalid_request",
    ]);
    expect((await send(cookie, code, { "idempotency-key": undefined })).statusCode).toBe(400);
    expect((await send(cookie, code, { origin: "https://evil.test" })).statusCode).toBe(403);
    const station = await paired(event, quest, "station");
    expect(codeOf(await send(station, code))).toEqual([401, "device_unpaired"]);
    expect(codeOf(await send("", code))).toEqual([401, "device_unpaired"]);
    const bearer = await test.app.inject({
      method: "POST",
      url: "/v1/device/kiosk-scans",
      headers: {
        authorization: `Bearer ${(await newPlayer(event)).token}`,
        origin: DASHBOARD_ORIGIN,
        "idempotency-key": randomUUID(),
      },
      payload: { code },
    });
    expect(codeOf(bearer as Response)).toEqual([401, "device_unpaired"]);
    const staff = await test.app.inject({
      method: "POST",
      url: "/v1/device/kiosk-scans",
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      payload: { code },
    });
    expect(codeOf(staff as Response)).toEqual([401, "device_unpaired"]);
    const kioskOnLive = await test.app.inject({
      method: "GET",
      url: "/v1/me/live-code",
      headers: { cookie, origin: DASHBOARD_ORIGIN },
    });
    expect(kioskOnLive.statusCode).toBe(401);
  });

  it("answers device_unpaired once the kiosk is revoked", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const cookie = await paired(event, quest);
    const [device] = await owner<{ id: string }>(
      "SELECT id FROM paired_device WHERE quest_id = $1",
      [quest],
    );
    const revoked = await dashboard("POST", `/events/${event}/devices/${device?.id}/revoke`, {});
    expect(revoked.statusCode).toBe(204);
    expect(codeOf(await send(cookie, await freshCode(await newPlayer(event))))).toEqual([
      401,
      "device_unpaired",
    ]);
  });

  // ============================================================ the limits
  it("pauses a kiosk for a minute after 10 bad codes; the fixed My QR is not counted", async () => {
    const event = await newEvent();
    const cookie = await paired(event, await newQuest(event));
    const fixed = myCode(MY_KEY, randomUUID(), 1);
    for (let index = 0; index < 3; index += 1) {
      expect((await send(cookie, fixed)).json()).toMatchObject({ reason: "needs_live_code" });
    }
    for (let index = 0; index < 10; index += 1) {
      expect((await send(cookie, `junk-${index}`)).json()).toMatchObject({
        reason: "invalid_code",
      });
    }
    const held = await send(cookie, fixed);
    expect(codeOf(held)).toEqual([429, "too_many_attempts"]);
    expect(Number(held.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("holds 30 scans a minute per kiosk", async () => {
    const event = await newEvent();
    const cookie = await paired(event, await newQuest(event));
    const fixed = myCode(MY_KEY, randomUUID(), 1);
    for (let index = 0; index < 30; index += 1) {
      expect((await send(cookie, fixed)).statusCode).toBe(200);
    }
    expect(codeOf(await send(cookie, fixed))).toEqual([429, "too_many_attempts"]);
  });

  // ============================================================ the logs
  it("never logs a live code, a player id or a username", async () => {
    const event = await newEvent();
    const cookie = await paired(event, await newQuest(event));
    const who = await newPlayer(event);
    logs.length = 0;
    const code = await freshCode(who);
    await send(cookie, code);
    await send(cookie, code);
    await send(cookie, "junk");
    const all = logs.join("\n");
    expect(all).toContain("kiosk.scan_completed");
    expect(all).toContain("kiosk.scan_refused");
    for (const secret of [code, who.id, who.username]) {
      expect(all).not.toContain(secret);
    }
  });
});
