import { randomUUID } from "node:crypto";
import { switchesViewSchema, type SwitchesView } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInConsole,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Method = "GET" | "PUT" | "DELETE";
type Json = Record<string, unknown>;

const MESSAGE = { ar: "الخدمة متوقفة مؤقتا.", en: "Paused for now." };

/**
 * The console's switches and tuning numbers over HTTP (T-703, FR-1405, FR-1769, FR-1770): the door is for an active
 * admin only (404 to anyone else), each key is saved on its own and audited, a value the app cannot use is refused with
 * its range, and a change reaches the composed configuration the apps read at once.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console switches over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let ownerCookie = "";
  let editorCookie = "";
  let adminId = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    adminId = await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const ownerId = await createStaff(db.owner, { email: "owner@najd.test" });
    const editorId = await createStaff(db.owner, { email: "editor@najd.test" });
    const [row] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd') RETURNING id",
      )
    ).rows;
    for (const [staff, role] of [
      [ownerId, "owner"],
      [editorId, "editor"],
    ] as const) {
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, $3)",
        [row?.id, staff, role],
      );
    }
    adminCookie = await signInConsole(test, "admin@questify.test");
    ownerCookie = await signInFully(test, "owner@najd.test");
    editorCookie = await signInFully(test, "editor@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }, url),
      ...(payload === undefined ? {} : { payload }),
    });
  const admin = (method: Method, url: string, payload?: object) =>
    call(method, url, adminCookie, payload);
  const view = async (): Promise<SwitchesView> =>
    switchesViewSchema.parse((await admin("GET", "/v1/admin/switches")).json());
  const feature = async (key: string) => (await view()).features.find((row) => row.key === key);
  const number = async (key: string) => (await view()).tuning.find((row) => row.key === key);
  const composed = async () =>
    (await test.app.inject({ method: "GET", url: "/v1/config" })).json<{
      features: Record<string, { enabled: boolean; message: unknown }>;
      tuning: Record<string, number>;
    }>();
  const audits = async (key: string) =>
    (
      await db.owner.query<{ actor_id: string; before: Json | null; after: Json }>(
        `SELECT actor_id, before, after FROM audit_log
         WHERE action = 'platform_settings.update' AND (after ? $1 OR before ? $1) ORDER BY id`,
        [key],
      )
    ).rows;

  it("answers 404 to a member and 401 to nobody signed in, on every door", async () => {
    const doors: [Method, string, object?][] = [
      ["GET", "/v1/admin/switches"],
      ["PUT", "/v1/admin/switches/features/shop", { enabled: false, message: null }],
      ["DELETE", "/v1/admin/switches/features/shop"],
      ["PUT", "/v1/admin/switches/tuning/livePollSeconds", { value: 20 }],
      ["DELETE", "/v1/admin/switches/tuning/livePollSeconds"],
    ];
    for (const [method, url, payload] of doors) {
      for (const cookie of [ownerCookie, editorCookie]) {
        expect((await call(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(404);
      }
      const signedOut = await test.app.inject({
        method,
        url,
        headers: withSession("", { "idempotency-key": randomUUID() }, url),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(signedOut.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await feature("shop"))?.enabled).toBe(true);
    expect((await number("livePollSeconds"))?.value).toBe(10);
  });

  it("lists every feature and tuning number of the app, nothing changed at the start", async () => {
    const list = await view();
    expect(list.features.length).toBeGreaterThan(20);
    expect(list.features.every((row) => !row.changed)).toBe(true);
    expect(list.tuning.map((row) => row.key)).toEqual(
      expect.arrayContaining([
        "flagBurstCount",
        "flagBurstMinutes",
        "readinessDays",
        "rehearsalCap",
        "usernameChangeDays",
      ]),
    );
    expect(list.tuning.find((row) => row.key === "rehearsalCap")).toMatchObject({
      value: 25,
      min: 1,
      max: 100,
      serverOnly: true,
    });
  });

  it("switches a feature off with a message at once, and on again without it", async () => {
    expect(
      (
        await admin("PUT", "/v1/admin/switches/features/shareQuests", {
          enabled: false,
          message: MESSAGE,
        })
      ).statusCode,
    ).toBe(204);
    expect(await feature("shareQuests")).toMatchObject({
      enabled: false,
      changed: true,
      message: MESSAGE,
    });
    expect((await composed()).features["shareQuests"]).toEqual({
      enabled: false,
      minAppVersion: null,
      message: MESSAGE,
    });

    await admin("PUT", "/v1/admin/switches/features/shareQuests", { enabled: true, message: null });
    expect(await feature("shareQuests")).toMatchObject({
      enabled: true,
      changed: false,
      message: null,
    });
    expect((await composed()).features["shareQuests"]?.enabled).toBe(true);
  });

  it("keeps two switches saved by two calls, and puts one back to the app's own", async () => {
    await admin("PUT", "/v1/admin/switches/features/cheers", { enabled: false, message: null });
    await admin("PUT", "/v1/admin/switches/features/maps", { enabled: false, message: MESSAGE });
    expect((await feature("cheers"))?.enabled).toBe(false);
    expect((await feature("maps"))?.enabled).toBe(false);
    expect((await admin("DELETE", "/v1/admin/switches/features/cheers")).statusCode).toBe(204);
    expect((await feature("cheers"))?.enabled).toBe(true);
    expect((await feature("maps"))?.enabled).toBe(false);
    await admin("DELETE", "/v1/admin/switches/features/maps");
  });

  it("switches on a feature that ships off, and shows it as changed", async () => {
    expect((await feature("locationQuests"))?.enabled).toBe(false);
    await admin("PUT", "/v1/admin/switches/features/locationQuests", {
      enabled: true,
      message: null,
    });
    expect(await feature("locationQuests")).toMatchObject({ enabled: true, changed: true });
    await admin("DELETE", "/v1/admin/switches/features/locationQuests");
    expect((await feature("locationQuests"))?.enabled).toBe(false);
  });

  it("refuses what the app cannot use, naming the fields", async () => {
    const bad: [string, string, object][] = [
      ["features/teleporter", "unknown feature", { enabled: false, message: null }],
      ["features/constructor", "inherited name", { enabled: false, message: null }],
      ["features/shop", "message on a switched-on feature", { enabled: true, message: MESSAGE }],
      ["features/shop", "one language", { enabled: false, message: { ar: "x", en: " " } }],
      ["features/shop", "extra field", { enabled: false, message: null, minAppVersion: "1.0" }],
      ["tuning/warp", "unknown number", { value: 3 }],
      ["tuning/toString", "inherited name", { value: 3 }],
      ["tuning/livePollSeconds", "below the range", { value: 4 }],
      ["tuning/livePollSeconds", "above the range", { value: 61 }],
      ["tuning/livePollSeconds", "a fraction", { value: 7.5 }],
      ["tuning/livePollSeconds", "a text", { value: "9" }],
    ];
    for (const [path, name, body] of bad) {
      const refused = await admin("PUT", `/v1/admin/switches/${path}`, body);
      expect(refused.statusCode, name).toBe(422);
      expect(refused.json(), name).toMatchObject({ code: "invalid_catalog" });
    }
    const range = await admin("PUT", "/v1/admin/switches/tuning/livePollSeconds", { value: 4 });
    expect(JSON.stringify(range.json())).toContain("whole number from 5 to 60");
    expect((await admin("DELETE", "/v1/admin/switches/features/teleporter")).statusCode).toBe(404);
    expect((await admin("DELETE", "/v1/admin/switches/tuning/constructor")).statusCode).toBe(404);
    expect((await number("livePollSeconds"))?.value).toBe(10);
  });

  it("saves a tuning number inside its range, sends the app's numbers only, and resets it", async () => {
    expect(
      (await admin("PUT", "/v1/admin/switches/tuning/livePollSeconds", { value: 20 })).statusCode,
    ).toBe(204);
    expect(await number("livePollSeconds")).toMatchObject({ value: 20, changed: true });
    expect((await composed()).tuning["livePollSeconds"]).toBe(20);

    await admin("PUT", "/v1/admin/switches/tuning/flagBurstCount", { value: 25 });
    expect(await number("flagBurstCount")).toMatchObject({ value: 25, serverOnly: true });
    expect(Object.keys((await composed()).tuning)).not.toContain("flagBurstCount");
    const { rows } = await db.owner.query<{ burst_count: number }>(
      "SELECT burst_count FROM flag_tuning()",
    );
    expect(rows[0]?.burst_count).toBe(25);

    await admin("DELETE", "/v1/admin/switches/tuning/livePollSeconds");
    await admin("DELETE", "/v1/admin/switches/tuning/flagBurstCount");
    expect((await number("livePollSeconds"))?.value).toBe(10);
    expect((await number("flagBurstCount"))?.changed).toBe(false);
  });

  it("audits who changed what, once per real change", async () => {
    await admin("PUT", "/v1/admin/switches/tuning/usernameChangeDays", { value: 45 });
    await admin("PUT", "/v1/admin/switches/tuning/usernameChangeDays", { value: 45 });
    await admin("DELETE", "/v1/admin/switches/tuning/usernameChangeDays");
    const entries = await audits("tuning.usernameChangeDays");
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.actor_id === adminId)).toBe(true);
    expect(entries[0]).toMatchObject({
      before: { "tuning.usernameChangeDays": null },
      after: { "tuning.usernameChangeDays": 45 },
    });
    expect(entries[1]).toMatchObject({
      before: { "tuning.usernameChangeDays": 45 },
      after: { "tuning.usernameChangeDays": null },
    });
  });

  it("writes only the features and tuning blocks of the platform settings", async () => {
    const { rows } = await db.owner.query<{ key: string }>(
      "SELECT key FROM platform_setting WHERE updated_by = $1 ORDER BY key",
      [adminId],
    );
    expect(rows.map((row) => row.key).every((key) => key === "features" || key === "tuning")).toBe(
      true,
    );
  });
});
