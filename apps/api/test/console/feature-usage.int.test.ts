import { randomUUID } from "node:crypto";
import {
  eventFeatureKeys,
  featureUsagePageSchema,
  REGISTRIES,
  type FeatureUsageOrganizer,
  type FeatureUsagePage,
} from "@questify/shared";
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

/**
 * The console's feature usage over HTTP (T-714, FR-1839): the door is for an active admin only (404 to anyone else), the
 * answer lays the platform's switch and Questify's override over the counts of the organizer's events, and a read writes
 * nothing to the audit log and shows no one's contact.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console feature usage over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let ownerCookie = "";
  let organizer = "";
  let other = "";
  let event = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const ownerId = await createStaff(db.owner, { email: "owner@najd.test" });
    const one = async (sql: string, values: unknown[] = []) =>
      (await db.owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "";
    organizer = await one(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Usage Events', 'najd-usage') RETURNING id",
    );
    other = await one(
      "INSERT INTO organizer (name, slug) VALUES ('Tabuk Usage Fest', 'tabuk-usage') RETURNING id",
    );
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    event = await one(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'NAJDU1', 'Fest', 'live', now() - interval '1 hour', now() + interval '3 days') RETURNING id`,
      [organizer],
    );
    await db.owner.query(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'TABUKU1', 'Fest', 'live', now() - interval '1 hour', now() + interval '3 days')`,
      [other],
    );
    adminCookie = await signInConsole(test, "admin@questify.test");
    ownerCookie = await signInFully(test, "owner@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const get = (url: string, cookie = adminCookie) =>
    test.app.inject({ method: "GET", url, headers: withSession(cookie, {}, url) });
  const page = async (query = ""): Promise<FeatureUsagePage> => {
    const response = await get(`/v1/admin/feature-usage${query}`);
    expect(response.statusCode, response.body).toBe(200);
    return featureUsagePageSchema.parse(response.json());
  };
  const rowOf = async (name: string): Promise<FeatureUsageOrganizer> => {
    const found = (await page(`?q=${encodeURIComponent(name)}`)).organizers[0];
    if (found === undefined) {
      throw new Error(`no organizer starts with ${name}`);
    }
    return found;
  };
  const feature = async (name: string, key: string) =>
    (await rowOf(name)).features.find((row) => row.key === key);
  const admin = (method: "PUT" | "DELETE", url: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(adminCookie, { "idempotency-key": randomUUID() }, url),
      ...(payload === undefined ? {} : { payload }),
    });

  it("answers 404 to a member and 401 to nobody signed in", async () => {
    expect((await get("/v1/admin/feature-usage", ownerCookie)).statusCode).toBe(404);
    expect((await get("/v1/admin/feature-usage", "")).statusCode).toBe(401);
  });

  it("lists every event-level feature for an organizer, and the Questify-wide ones for none", async () => {
    const row = await rowOf("Najd Usage");
    expect(row).toMatchObject({ id: organizer, name: "Najd Usage Events", slug: "najd-usage" });
    expect(row.events).toBe(1);
    expect(row.features.map((item) => item.key)).toEqual(eventFeatureKeys(REGISTRIES));
    expect(row.features.map((item) => item.key)).not.toContain("dailyStreak");
    expect(row.features.every((item) => item.effective && item.override === null)).toBe(true);
  });

  it("shows Cheers off when Questify switched it off for the organizer (FR-1839)", async () => {
    expect(
      (await admin("PUT", `/v1/admin/organizers/${organizer}/features/cheers`, { enabled: false }))
        .statusCode,
    ).toBe(204);
    try {
      expect(await feature("Najd Usage", "cheers")).toMatchObject({
        platformEnabled: true,
        override: false,
        effective: false,
        eventsOn: 0,
      });
      expect(await feature("Tabuk Usage", "cheers")).toMatchObject({
        override: null,
        effective: true,
        eventsOn: 1,
      });
    } finally {
      await admin("DELETE", `/v1/admin/organizers/${organizer}/features/cheers`);
    }
    expect(await feature("Najd Usage", "cheers")).toMatchObject({
      override: null,
      effective: true,
    });
  });

  it("shows a feature the platform switched off as off for everyone, and an override over it as on", async () => {
    await admin("PUT", "/v1/admin/switches/features/maps", {
      enabled: false,
      message: null,
    });
    try {
      expect(await feature("Najd Usage", "maps")).toMatchObject({
        platformEnabled: false,
        effective: false,
        eventsOn: 0,
      });
      await admin("PUT", `/v1/admin/organizers/${organizer}/features/maps`, { enabled: true });
      expect(await feature("Najd Usage", "maps")).toMatchObject({
        platformEnabled: false,
        override: true,
        effective: true,
        eventsOn: 1,
      });
      expect(await feature("Tabuk Usage", "maps")).toMatchObject({ effective: false });
    } finally {
      await admin("DELETE", `/v1/admin/organizers/${organizer}/features/maps`);
      await admin("DELETE", "/v1/admin/switches/features/maps");
    }
  });

  it("counts the events that switched a feature off and the ones that use it", async () => {
    await db.owner.query(
      `UPDATE event SET config = '{"features": {"shop": false, "questRatings": true}}'::jsonb WHERE id = $1`,
      [event],
    );
    await db.owner.query(
      `INSERT INTO cheers_moment (event_id, organizer_id, ends_at)
       SELECT id, organizer_id, now() + interval '1 minute' FROM event WHERE id = $1`,
      [event],
    );
    expect(await feature("Najd Usage", "shop")).toMatchObject({ eventsOn: 0, eventsUsing: 0 });
    expect(await feature("Najd Usage", "questRatings")).toMatchObject({ eventsOn: 1 });
    expect(await feature("Najd Usage", "cheers")).toMatchObject({ eventsOn: 1, eventsUsing: 1 });
    expect(await feature("Tabuk Usage", "cheers")).toMatchObject({ eventsOn: 1, eventsUsing: 0 });
    expect(await feature("Najd Usage", "ranking")).toMatchObject({ eventsUsing: null });
  });

  it("counts an add-on only where Questify unlocked it", async () => {
    expect(await feature("Najd Usage", "bigScreen")).toMatchObject({ addOn: true, eventsOn: 0 });
    await db.owner.query(
      `INSERT INTO event_entitlement (event_id, organizer_id, feature)
       SELECT id, organizer_id, 'bigScreen' FROM event WHERE id = $1`,
      [event],
    );
    expect(await feature("Najd Usage", "bigScreen")).toMatchObject({ addOn: true, eventsOn: 1 });
  });

  it("pages by name with a cursor that ends on the last page", async () => {
    const first = await page("?q=T&limit=1");
    expect(first.organizers.map((row) => row.slug)).toEqual(["tabuk-usage"]);
    expect(first.nextCursor).toBe(other);
    const next = await page(`?q=T&limit=1&cursor=${other}`);
    expect(next.organizers).toEqual([]);
    expect(next.nextCursor).toBeNull();
    expect((await page("?q=T&limit=5")).nextCursor).toBeNull();
  });

  it("refuses a malformed query and an unknown parameter", async () => {
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?limit=many",
      "?cursor=not-an-id",
      "?q=",
      `?q=${"x".repeat(255)}`,
      "?status=active",
    ]) {
      expect((await get(`/v1/admin/feature-usage${query}`)).statusCode, query).toBe(400);
    }
  });

  it("writes nothing to the audit log and shows no email or contact", async () => {
    const before = (await db.owner.query("SELECT count(*)::int AS n FROM audit_log")).rows[0];
    const response = await get("/v1/admin/feature-usage?limit=50");
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(/@najd\.test|@questify\.test|password/i);
    expect((await db.owner.query("SELECT count(*)::int AS n FROM audit_log")).rows[0]).toEqual(
      before,
    );
  });
});
