import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { createScreenCodeKey, screenCode } from "#src/quests/qr";
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
type Person = Readonly<{ id: string; token: string }>;
type Shown = Readonly<{ state: string; kind: string; code: string; expiresAt: string }>;
type Response = Readonly<{
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: <T = Row>() => T;
}>;

const KEYS = createAuthKeys(testConfig().auth.secret);
const SCREEN_KEY = createScreenCodeKey(testConfig().qrSecret);
const codeOf = (response: Response) => [
  response.statusCode,
  response.json<{ code?: string }>().code,
];
const cookieOf = (response: Response): string => {
  const header = response.headers["set-cookie"];
  const value = String(Array.isArray(header) ? header[0] : header);
  return value.split(";")[0] ?? "";
};
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

/**
 * Device pairing and the screen code over HTTP (T-309): the public pairing request and its cookie, the reload case
 * (CTO 4), the device's state, renew and activation (CTO 2), a station's code and a player scanning it, the operator's
 * and the team's preview, claim, list and revoke, the limits, the switch, the cross-credential walls (CTO 11) and that no
 * secret, code or token reaches a log line or an audit row.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("devices over HTTP", () => {
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
          "INSERT INTO organizer (name, slug) VALUES ('dev-org', 'dev-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@devices.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@devices.test");
  });
  // The owner claims in most tests; the 10-a-minute claim limit is tested on its own with another member.
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
      [organizer, `DEVH${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, verification = ["screen_qr"]) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, verification)
         SELECT $1, id, 'scan_qr', 'Hall B', 10, 100, $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, verification],
      )
    )[0]?.id ?? "";
  const newPerson = async (event: string, role: "player" | "operator"): Promise<Person> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`dev_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    await owner(
      role === "player"
        ? "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)"
        : "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
      [organizer, event, id],
    );
    return { id, token };
  };
  const pair = (kind = "station", headers: Record<string, string> = {}) =>
    test.app.inject({
      method: "POST",
      url: "/v1/device/pairing",
      headers: {
        origin: DASHBOARD_ORIGIN,
        "x-forwarded-for": freshIp(),
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        ...headers,
      },
      payload: { kind },
    }) as Promise<Response>;
  const device = (method: "GET" | "POST", url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { cookie, origin: DASHBOARD_ORIGIN },
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  const call = (method: "GET" | "POST", path: string, who: Person, payload?: object) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${who.token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  const dashboard = (method: "GET" | "POST", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    }) as Promise<Response>;
  /** A pending page: its cookie and the code it shows. */
  const pending = async (kind = "station") => {
    const made = await pair(kind);
    expect(made.statusCode, made.body).toBe(201);
    return { cookie: cookieOf(made), code: made.json<Shown>().code };
  };
  /** A station paired from the dashboard and activated: its current cookie. */
  const station = async (event: string, quest: string) => {
    const page = await pending();
    const claimed = await dashboard("POST", `/events/${event}/devices`, {
      code: page.code,
      kind: "station",
      questId: quest,
      label: "Hall B TV",
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    const activated = await device("POST", "/v1/device/activate", page.cookie, {});
    expect(activated.statusCode, activated.body).toBe(200);
    return { cookie: cookieOf(activated), old: page.cookie, id: claimed.json<{ id: string }>().id };
  };
  const withStationsOff = async (work: () => Promise<void>) => {
    await owner("INSERT INTO platform_setting (key, value) VALUES ('features', $1)", [
      JSON.stringify({ stations: { enabled: false } }),
    ]);
    settings.forget();
    try {
      await work();
    } finally {
      await owner("DELETE FROM platform_setting WHERE key = 'features'");
      settings.forget();
    }
  };

  // ============================================================ the device's own calls
  it("answers a pairing request with its code and an HttpOnly __Host- cookie, no-store", async () => {
    const made = await pair();
    expect(made.statusCode).toBe(201);
    expect(made.headers["cache-control"]).toBe("no-store");
    const shown = made.json<Shown>();
    expect(shown).toMatchObject({ state: "pending", kind: "station" });
    expect(shown.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
    const cookie = String(made.headers["set-cookie"]);
    expect(cookie).toMatch(
      /^__Host-qs_device=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=34560000$/,
    );
    const [row] = await owner<{ client: string }>(
      "SELECT client FROM device_request WHERE secret_hash = $1",
      [
        createHash("sha256")
          .update(cookieOf(made).split("=")[1] ?? "")
          .digest(),
      ],
    );
    expect(row?.client).toBe("Chrome on Android");
  });

  it("refuses a pairing request without the dashboard's Origin (CTO 10)", async () => {
    const other = await pair("station", { origin: "https://evil.test" });
    expect(codeOf(other)).toEqual([403, "csrf_rejected"]);
    const none = await test.app.inject({
      method: "POST",
      url: "/v1/device/pairing",
      headers: { "x-forwarded-for": freshIp() },
      payload: { kind: "station" },
    });
    expect(none.statusCode).toBe(403);
  });

  it("a reload with a live cookie answers its state, makes nothing and is not counted (CTO 4)", async () => {
    const page = await pending();
    const before = await owner<{ n: number }>("SELECT count(*)::int AS n FROM device_request");
    const again = await pair("station", { cookie: page.cookie });
    expect(again.statusCode).toBe(200);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(again.json()).toMatchObject({ state: "pending", kind: "station" });
    const after = await owner<{ n: number }>("SELECT count(*)::int AS n FROM device_request");
    expect(after[0]?.n).toBe(before[0]?.n);
    const state = await device("GET", "/v1/device", page.cookie);
    expect(state.json()).toMatchObject({ state: "pending", kind: "station" });
    expect(state.json()["code"]).toBeUndefined();
    const renewed = await device("POST", "/v1/device/pairing/renew", page.cookie, {});
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json<Shown>().code).not.toBe(page.code);
  });

  it("a page of another kind with a pending cookie asks afresh", async () => {
    const page = await pending("station");
    const screen = await pair("screen", { cookie: page.cookie });
    expect(screen.statusCode).toBe(201);
    expect(screen.json()).toMatchObject({ kind: "screen" });
  });

  it("holds renews and activations at 10 a minute per device (CTO code review 1)", async () => {
    const page = await pending("screen");
    const answers: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      answers.push((await device("POST", "/v1/device/pairing/renew", page.cookie, {})).statusCode);
    }
    expect(answers.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(answers[10]).toBe(429);
    expect(codeOf(await device("POST", "/v1/device/activate", page.cookie, {}))).toEqual([
      429,
      "too_many_attempts",
    ]);
  });

  it("holds 60 pairing requests per 10 minutes from one address bucket", async () => {
    const address = freshIp();
    for (let index = 0; index < 60; index += 1) {
      expect((await pair("screen", { "x-forwarded-for": address })).statusCode).toBe(201);
    }
    const held = await pair("screen", { "x-forwarded-for": address });
    expect(codeOf(held)).toEqual([429, "too_many_attempts"]);
    expect(held.headers["retry-after"]).toBeDefined();
  });

  it("answers device_unpaired without a cookie, with an unknown one, and a pending one on a paired-only route", async () => {
    expect(codeOf(await device("GET", "/v1/device", ""))).toEqual([401, "device_unpaired"]);
    const fake = `__Host-qs_device=${randomBytes(32).toString("base64url")}`;
    expect(codeOf(await device("GET", "/v1/device", fake))).toEqual([401, "device_unpaired"]);
    const page = await pending();
    const code = await device("GET", "/v1/device/screen-code", page.cookie);
    expect(codeOf(code)).toEqual([401, "device_unpaired"]);
    expect(code.headers["cache-control"]).toBe("no-store");
    expect(
      (
        await test.app.inject({
          method: "POST",
          url: "/v1/device/activate",
          headers: { cookie: page.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  // ============================================================ pairing and activation
  it("pairs from the dashboard: preview shows the client; paired, then activated with a new secret (CTO 2)", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const page = await pending();
    const preview = await dashboard("POST", `/events/${event}/devices/preview`, {
      code: page.code.toLowerCase(),
    });
    expect(preview.json()).toMatchObject({ kind: "station", client: "Chrome on Android" });
    const claimed = await dashboard("POST", `/events/${event}/devices`, {
      code: page.code,
      kind: "station",
      questId: quest,
      label: "Hall B TV",
    });
    expect(claimed.statusCode).toBe(201);
    expect((await device("GET", "/v1/device", page.cookie)).json()).toEqual({
      state: "paired",
      activated: false,
    });
    const activated = await device("POST", "/v1/device/activate", page.cookie, {});
    const fresh = cookieOf(activated);
    expect(fresh).not.toBe(page.cookie);
    expect(String(activated.headers["set-cookie"])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect((await device("GET", "/v1/device", page.cookie)).json()).toEqual({
      state: "paired",
      activated: false,
    });
    expect((await device("GET", "/v1/device", fresh)).json()).toEqual({
      state: "paired",
      activated: true,
      kind: "station",
      label: "Hall B TV",
      shut: null,
      event: { name: { ar: null, en: "Hall Fest" } },
      quest: { title: { ar: null, en: "Hall B" }, points: 10 },
    });
    expect(codeOf(await device("GET", "/v1/device", page.cookie))).toEqual([
      401,
      "device_unpaired",
    ]);
    const again = await device("POST", "/v1/device/activate", fresh, {});
    expect(again.statusCode).toBe(200);
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("answers each claim refusal", async () => {
    const event = await newEvent();
    const printed = await newQuest(event, ["quest_qr"]);
    const quest = await newQuest(event);
    const page = await pending();
    const claim = (body: Row) =>
      dashboard("POST", `/events/${event}/devices`, {
        code: page.code,
        kind: "station",
        questId: quest,
        label: "TV",
        ...body,
      });
    expect(codeOf(await claim({ questId: printed }))).toEqual([409, "not_screen_qr"]);
    expect(codeOf(await claim({ kind: "screen", questId: null }))).toEqual([409, "wrong_kind"]);
    expect(codeOf(await claim({ label: "" }))).toEqual([422, "invalid_device"]);
    expect((await claim({ label: "" })).json()).toMatchObject({ details: { field: "label" } });
    expect(codeOf(await claim({ code: "ZZZZ-ZZZZ" }))).toEqual([404, "unknown_code"]);
    expect(codeOf(await claim({ code: "OOOO-OOOO" }))).toEqual([404, "unknown_code"]);
    expect(codeOf(await claim({ questId: randomUUID() }))).toEqual([404, "not_found"]);
    const kiosk = await pending("kiosk");
    expect(codeOf(await claim({ code: kiosk.code, kind: "kiosk" }))).toEqual([409, "not_kiosk"]);
  });

  it("holds 10 claims a minute per staff member, and 30 unknown codes an hour per event (CTO 8)", async () => {
    const event = await newEvent();
    const crowded = await newEvent();
    for (let index = 0; index < 30; index += 1) {
      await owner(
        "INSERT INTO auth_throttle (bucket, key, at) VALUES ('device_miss_event', $1, now() - make_interval(secs => $2))",
        [KEYS.eventKey(crowded), index],
      );
    }
    expect(
      codeOf(await dashboard("POST", `/events/${crowded}/devices/preview`, { code: "ABCD-EFGH" })),
    ).toEqual([429, "too_many_attempts"]);
    const staff = await createStaff(db.owner, { email: "editor@devices.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [organizer, staff],
    );
    const editor = await signInFully(test, "editor@devices.test");
    const answers: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await test.app.inject({
        method: "POST",
        url: `/v1/organizers/${organizer}/events/${event}/devices/preview`,
        headers: withSession(editor),
        payload: { code: "ABCD-EFGH" },
      });
      answers.push(response.statusCode);
    }
    expect(answers.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(answers[10]).toBe(429);
    const misses = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = 'device_miss_event' AND key = $1",
      [KEYS.eventKey(event)],
    );
    expect(misses[0]?.n).toBe(10);
  });

  // ============================================================ the station's code
  it("serves a station's code; a player scanning it is paid as method screen_qr", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const made = await station(event, quest);
    const code = await device("GET", "/v1/device/screen-code", made.cookie);
    expect(code.statusCode, code.body).toBe(200);
    expect(code.headers["cache-control"]).toBe("no-store");
    const body = code.json<{ state: string; code: string; url: string; changesInMs: number }>();
    expect(body).toMatchObject({ state: "open", quest: { title: { en: "Hall B" }, points: 10 } });
    expect(body.url).toBe(`${DASHBOARD_ORIGIN}/s/${body.code}`);
    expect(body.changesInMs).toBeGreaterThan(0);
    const who = await newPerson(event, "player");
    const logged = logs.length;
    const paid = await call("POST", `/v1/quests/${quest}/complete`, who, {
      proof: { type: "screen", code: tokenOf(body.url) },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json()).toMatchObject({ points: 10, replayed: false });
    expect(logs.slice(logged).join("\n")).not.toContain(body.code);
    const other = await newQuest(event);
    expect(
      codeOf(
        await call("POST", `/v1/quests/${other}/complete`, who, {
          proof: { type: "screen", code: body.code },
        }),
      ),
    ).toEqual([422, "invalid_code"]);
  });

  it("answers code_expired for a code two windows old, and invalid_code for a forged one", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const who = await newPerson(event, "player");
    const window = Math.floor(Date.now() / 30_000);
    const old = screenCode(SCREEN_KEY, quest, window - 2);
    expect(
      codeOf(
        await call("POST", `/v1/quests/${quest}/complete`, who, {
          proof: { type: "screen", code: old },
        }),
      ),
    ).toEqual([422, "code_expired"]);
    const forged = screenCode(createScreenCodeKey("x".repeat(40)), quest, window);
    expect(
      codeOf(
        await call("POST", `/v1/quests/${quest}/complete`, who, {
          proof: { type: "screen", code: forged },
        }),
      ),
    ).toEqual([422, "invalid_code"]);
  });

  it("answers why a station shows nothing, and feature_off while the platform's switch is off", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const made = await station(event, quest);
    await owner("UPDATE quest SET opens_at = now() + interval '1 hour' WHERE id = $1", [quest]);
    const shut = await device("GET", "/v1/device/screen-code", made.cookie);
    expect(shut.json()).toEqual({
      state: "not_started",
      quest: { title: { ar: null, en: "Hall B" }, points: 10 },
    });
    const op = await newPerson(event, "operator");
    await withStationsOff(async () => {
      expect(codeOf(await device("GET", "/v1/device/screen-code", made.cookie))).toEqual([
        403,
        "feature_off",
      ]);
      expect(
        codeOf(await call("GET", `/v1/operator/events/${event}/quests/${quest}/screen-code`, op)),
      ).toEqual([403, "feature_off"]);
      expect((await dashboard("GET", `/events/${event}/devices`)).statusCode).toBe(200);
    });
  });

  it("revoked from the dashboard: the page's next call is device_unpaired", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const made = await station(event, quest);
    const listed = await dashboard("GET", `/events/${event}/devices`);
    expect(listed.json<{ devices: Row[] }>().devices[0]).toMatchObject({
      id: made.id,
      kind: "station",
      label: "Hall B TV",
      client: "Chrome on Android",
      pairedBy: { type: "staff", name: "owner@devices.test" },
      status: "active",
    });
    expect(
      (await dashboard("POST", `/events/${event}/devices/${made.id}/revoke`, {})).statusCode,
    ).toBe(204);
    expect(codeOf(await device("GET", "/v1/device/screen-code", made.cookie))).toEqual([
      401,
      "device_unpaired",
    ]);
    expect(
      codeOf(await dashboard("POST", `/events/${event}/devices/${made.id}/revoke`, {})),
    ).toEqual([404, "unknown_device"]);
    const screen = await pending("screen");
    await dashboard("POST", `/events/${event}/devices`, {
      code: screen.code,
      kind: "screen",
      label: "Main hall",
    });
    const all = await dashboard("POST", `/events/${event}/devices/revoke`, { kind: "screen" });
    expect(all.json()).toEqual({ revoked: 1 });
  });

  // ============================================================ staff mode
  it("an operator previews, claims, lists, shows and revokes a station", async () => {
    const event = await newEvent();
    const quest = await newQuest(event);
    const op = await newPerson(event, "operator");
    const page = await pending();
    const base = `/v1/operator/events/${event}/devices`;
    expect((await call("POST", `${base}/preview`, op, { code: page.code })).json()).toMatchObject({
      kind: "station",
    });
    const claimed = await call("POST", base, op, {
      code: page.code,
      kind: "station",
      questId: quest,
      label: "Gate TV",
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    const id = claimed.json<{ id: string }>().id;
    const list = await call("GET", base, op);
    expect(list.json<{ devices: Row[]; quests: Row[] }>()).toMatchObject({
      devices: [{ id, label: "Gate TV", pairedBy: { type: "operator" } }],
      quests: [{ id: quest, points: 10 }],
    });
    const shown = await call("GET", `/v1/operator/events/${event}/quests/${quest}/screen-code`, op);
    expect(shown.json()).toMatchObject({ state: "open" });
    const screen = await pending("screen");
    expect(
      codeOf(await call("POST", base, op, { code: screen.code, kind: "screen", label: "Hall" })),
    ).toEqual([422, "invalid_device"]);
    expect((await call("POST", `${base}/${id}/revoke`, op, {})).statusCode).toBe(204);
    const stranger = await newPerson(event, "player");
    expect(codeOf(await call("GET", base, stranger))).toEqual([403, "not_operator"]);
  });

  // ============================================================ cross-credential walls (CTO 11)
  it("a device cookie opens no player, staff, member, owner or admin route", async () => {
    const event = await newEvent();
    const made = await station(event, await newQuest(event));
    const closed = test.app.routeInventory.filter(
      (route) =>
        route.method !== "HEAD" &&
        ["player", "staff", "member", "owner", "admin"].includes(route.access),
    );
    expect(closed.length).toBeGreaterThan(20);
    for (const route of closed) {
      const response = await test.app.inject({
        method: route.method as "GET" | "POST",
        url: route.url
          .replace(":organizerId", organizer)
          .replace(/:[a-zA-Z]+/g, "00000000-0000-4000-8000-000000000000"),
        headers: { cookie: made.cookie, origin: DASHBOARD_ORIGIN, "idempotency-key": randomUUID() },
        ...(route.method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it("a staff cookie or a player bearer opens no device route; /v1/devices is not one", async () => {
    const event = await newEvent();
    const who = await newPerson(event, "player");
    const deviceRoutes = test.app.routeInventory.filter(
      (route) => route.method !== "HEAD" && route.access === "device",
    );
    expect(deviceRoutes.map((route) => `${route.method} ${route.url}`).toSorted()).toEqual([
      "GET /v1/device",
      "GET /v1/device/screen-code",
      "POST /v1/device/activate",
      "POST /v1/device/kiosk-scans",
      "POST /v1/device/pairing/renew",
    ]);
    for (const route of deviceRoutes) {
      for (const headers of [
        withSession(ownerCookie),
        { authorization: `Bearer ${who.token}`, origin: DASHBOARD_ORIGIN },
      ]) {
        const response = await test.app.inject({
          method: route.method as "GET" | "POST",
          url: route.url,
          headers,
          ...(route.method === "GET" ? {} : { payload: {} }),
        });
        expect(codeOf(response), `${route.method} ${route.url}`).toEqual([401, "device_unpaired"]);
      }
    }
    expect(test.app.routeInventory.some((route) => route.url.startsWith("/v1/devices"))).toBe(
      false,
    );
  });

  it("never logs or audits a device secret or a pairing code", async () => {
    const logged = logs.length;
    const event = await newEvent();
    const page = await pending();
    const quest = await newQuest(event);
    await dashboard("POST", `/events/${event}/devices`, {
      code: page.code,
      kind: "station",
      questId: quest,
      label: "TV",
    });
    const activated = await device("POST", "/v1/device/activate", page.cookie, {});
    const lines = logs.slice(logged).join("\n");
    for (const secret of [
      page.cookie.split("=")[1] ?? "",
      cookieOf(activated).split("=")[1] ?? "",
    ]) {
      expect(secret).toHaveLength(43);
      expect(lines).not.toContain(secret);
    }
    expect(lines).not.toContain(page.code);
    expect(lines).not.toContain(page.code.replace("-", ""));
    const audits = await owner<{ row: string }>(
      "SELECT row_to_json(a)::text AS row FROM audit_log a WHERE event_id = $1",
      [event],
    );
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      expect(audit.row).not.toContain(page.code.replace("-", ""));
      expect(audit.row).not.toContain(page.cookie.split("=")[1] ?? "");
    }
  });
});
