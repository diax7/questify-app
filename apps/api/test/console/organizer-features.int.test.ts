import { randomUUID } from "node:crypto";
import { organizerFeaturesViewSchema, type OrganizerFeaturesView } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Method = "GET" | "PUT" | "DELETE";
type Json = Record<string, unknown>;

/**
 * The console's per-organizer feature overrides over HTTP (T-711, FR-1826): the door is for an active admin only (404 to
 * anyone else), a Questify-wide feature is refused, each change is audited once, and it
 * reaches the composed configuration of that organizer's events at once and no one else's.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console organizer features over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let ownerCookie = "";
  let adminId = "";
  let organizer = "";
  let other = "";
  let event = "";
  let otherEvent = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    adminId = await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const ownerId = await createStaff(db.owner, { email: "owner@najd.test" });
    const one = async (sql: string, values: unknown[] = []) =>
      (await db.owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "";
    organizer = await one(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd') RETURNING id",
    );
    other = await one(
      "INSERT INTO organizer (name, slug) VALUES ('Tabuk Fest', 'tabuk') RETURNING id",
    );
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    const newEvent = (org: string, code: string) =>
      one(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Fest', 'live', now() - interval '1 hour', now() + interval '3 days') RETURNING id`,
        [org, code],
      );
    event = await newEvent(organizer, "NAJD1");
    otherEvent = await newEvent(other, "TABUK1");
    adminCookie = await signInFully(test, "admin@questify.test");
    ownerCookie = await signInFully(test, "owner@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const path = (org = organizer, key = "") => `/v1/admin/organizers/${org}/features${key}`;
  const admin = (method: Method, url: string, payload?: object) =>
    call(method, url, adminCookie, payload);
  const view = async (org = organizer): Promise<OrganizerFeaturesView> =>
    organizerFeaturesViewSchema.parse((await admin("GET", path(org))).json());
  const row = async (key: string) => (await view()).features.find((item) => item.key === key);
  const composed = async (id: string, key: string) =>
    (await test.app.inject({ method: "GET", url: `/v1/config?event=${id}` })).json<{
      features: Record<string, { enabled: boolean; message: unknown }>;
    }>().features[key];
  const audits = async (key: string) =>
    (
      await db.owner.query<{
        actor_id: string;
        organizer_id: string;
        before: Json;
        after: Json;
        action: string;
      }>(
        `SELECT actor_id, organizer_id, before, after, action FROM audit_log
         WHERE action LIKE 'organizer.feature_override.%' AND (after ? $1 OR before ? $1) ORDER BY id`,
        [key],
      )
    ).rows;

  it("answers 404 to a member and 401 to nobody signed in, on every door", async () => {
    const doors: [Method, string, object?][] = [
      ["GET", path()],
      ["PUT", path(organizer, "/shop"), { enabled: false }],
      ["DELETE", path(organizer, "/shop")],
    ];
    for (const [method, url, payload] of doors) {
      expect((await call(method, url, ownerCookie, payload)).statusCode, `${method} ${url}`).toBe(
        404,
      );
      const signedOut = await test.app.inject({
        method,
        url,
        headers: withSession("", { "idempotency-key": randomUUID() }),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(signedOut.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await row("shop")).toMatchObject({ override: null, effective: true });
  });

  it("lists the sixteen features an override can act on, none of the others (T-711b)", async () => {
    const list = await view();
    expect(list.features.map((item) => item.key)).toEqual([
      "agenda",
      "bigScreen",
      "boosts",
      "cheers",
      "community",
      "flashQuests",
      "helpDesk",
      "maps",
      "meetSomeone",
      "miniGames",
      "polls",
      "questRatings",
      "ranking",
      "rankingToday",
      "shareQuests",
      "shop",
    ]);
    expect(list.features.every((item) => item.override === null && item.effective)).toBe(true);
    expect((await admin("GET", path(randomUUID()))).statusCode).toBe(404);
    expect((await admin("GET", "/v1/admin/organizers/not-an-id/features")).statusCode).toBe(400);
  });

  it("sets an override at once for that organizer's events only, and puts it back", async () => {
    expect(
      (
        await admin("PUT", "/v1/admin/switches/features/shareQuests", {
          enabled: false,
          message: { ar: "متوقفة", en: "Paused" },
        })
      ).statusCode,
    ).toBe(204);
    expect(await row("shareQuests")).toMatchObject({ platformEnabled: false, effective: false });
    expect(await composed(event, "shareQuests")).toMatchObject({
      enabled: false,
      message: { en: "Paused" },
    });

    expect(
      (await admin("PUT", path(organizer, "/shareQuests"), { enabled: true })).statusCode,
    ).toBe(204);
    expect(await row("shareQuests")).toEqual({
      key: "shareQuests",
      platformEnabled: false,
      override: true,
      effective: true,
    });
    expect(await composed(event, "shareQuests")).toEqual({
      enabled: true,
      minAppVersion: null,
      message: null,
    });
    expect((await composed(otherEvent, "shareQuests"))?.enabled).toBe(false);
    expect((await view(other)).features.find((item) => item.key === "shareQuests")).toMatchObject({
      override: null,
      effective: false,
    });

    expect((await admin("DELETE", path(organizer, "/shareQuests"))).statusCode).toBe(204);
    expect(await row("shareQuests")).toMatchObject({ override: null, effective: false });
    expect((await composed(event, "shareQuests"))?.enabled).toBe(false);
    await admin("DELETE", "/v1/admin/switches/features/shareQuests");
  });

  it("switches a feature off for one organizer while the platform leaves it on", async () => {
    await admin("PUT", path(organizer, "/helpDesk"), { enabled: false });
    expect(await composed(event, "helpDesk")).toMatchObject({ enabled: false, message: null });
    expect((await composed(otherEvent, "helpDesk"))?.enabled).toBe(true);
    await admin("DELETE", path(organizer, "/helpDesk"));
    expect((await composed(event, "helpDesk"))?.enabled).toBe(true);
  });

  it("refuses a Questify-wide feature, an unknown one, and a bad body", async () => {
    for (const key of [
      "nfcTags",
      "kiosks",
      "dailyStreak",
      "locationQuests",
      "teleporter",
      "constructor",
    ]) {
      const put = await admin("PUT", path(organizer, `/${key}`), { enabled: true });
      expect([key, put.statusCode, put.json<{ code: string }>().code]).toEqual([
        key,
        422,
        "invalid_catalog",
      ]);
      const del = await admin("DELETE", path(organizer, `/${key}`));
      expect([key, del.statusCode]).toEqual([key, 422]);
    }
    for (const body of [{}, { enabled: "yes" }, { enabled: true, message: null }]) {
      expect((await admin("PUT", path(organizer, "/shop"), body)).statusCode).toBe(422);
    }
    expect((await admin("PUT", path(randomUUID(), "/shop"), { enabled: false })).statusCode).toBe(
      404,
    );
    expect((await db.owner.query("SELECT 1 FROM organizer_feature_override")).rowCount).toBe(0);
  });

  it("audits who changed what, once per real change", async () => {
    await admin("PUT", path(organizer, "/polls"), { enabled: false });
    await admin("PUT", path(organizer, "/polls"), { enabled: false });
    await admin("PUT", path(organizer, "/polls"), { enabled: true });
    await admin("DELETE", path(organizer, "/polls"));
    await admin("DELETE", path(organizer, "/polls"));
    const entries = await audits("polls");
    expect(entries.map((entry) => [entry.action, entry.before, entry.after])).toEqual([
      ["organizer.feature_override.set", { polls: null }, { polls: false }],
      ["organizer.feature_override.set", { polls: false }, { polls: true }],
      ["organizer.feature_override.clear", { polls: true }, { polls: null }],
    ]);
    expect(
      entries.every((entry) => entry.actor_id === adminId && entry.organizer_id === organizer),
    ).toBe(true);
  });

  it("keeps two admins on two features, and two on one feature, exact", async () => {
    await Promise.all([
      admin("PUT", path(organizer, "/maps"), { enabled: false }),
      admin("PUT", path(organizer, "/agenda"), { enabled: false }),
    ]);
    expect(await row("maps")).toMatchObject({ override: false });
    expect(await row("agenda")).toMatchObject({ override: false });
    await Promise.all([
      admin("PUT", path(organizer, "/maps"), { enabled: true }),
      admin("PUT", path(organizer, "/maps"), { enabled: false }),
    ]);
    const entries = await audits("maps");
    const last = entries.at(-1);
    expect(last?.after).toEqual({ maps: (await row("maps"))?.override });
    // Every entry's "before" is the previous entry's "after": no two admins wrote from the same reading.
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]?.before, `entry ${index}`).toEqual(entries[index - 1]?.after);
    }
    await admin("DELETE", path(organizer, "/maps"));
    await admin("DELETE", path(organizer, "/agenda"));
  });
});
