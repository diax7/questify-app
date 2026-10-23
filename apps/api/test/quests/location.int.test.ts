import type { LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const EVENT = {
  name: { en: "Najd Meetup" },
  timezone: "Asia/Riyadh",
  startsAt: "2030-11-01T09:00",
  endsAt: "2030-11-01T17:00",
};
const PLACE = { lat: 24.7136, lng: 46.6753, radiusM: 50 };

const quest = (general: string, type: string, extra: object = {}) => ({
  categoryId: general,
  type,
  title: { en: "The fountain" },
  points: 10,
  ...extra,
});

const key = () => ({ "idempotency-key": `k-${Math.random()}` });

/**
 * The builder's side of location quests (T-303b, ADR-206, ADR-208): a quest's place on the spot types, the type behind
 * the platform's switch, and the event's venue pin and radius.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("location in the builder (T-303b)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(db, false, {}, { settings });
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);
  const switchLocation = async (enabled: boolean) => {
    await owner(
      `INSERT INTO platform_setting (key, value) VALUES ('features', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ locationQuests: { enabled } })],
    );
    settings.forget();
  };
  const call = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    cookie: string,
    payload?: object,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, method === "POST" ? key() : {}),
      ...(payload === undefined ? {} : { payload }),
    });
  const newEvent = async () => {
    counter += 1;
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', $1) RETURNING id",
      [`location-${counter}`],
    );
    const orgId = org?.id ?? "";
    const email = `owner${counter}@location.test`;
    const staff = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [orgId, staff],
    );
    const cookie = await signInFully(test, email);
    const made = await call("POST", `/v1/organizers/${orgId}/events`, cookie, EVENT);
    const eventId = made.json<{ event: { id: string } }>().event.id;
    const base = `/v1/organizers/${orgId}/events/${eventId}`;
    const read = await call("GET", `${base}/quests`, cookie);
    const general = read.json<{ categories: { id: string }[] }>().categories[0]?.id ?? "";
    return { orgId, eventId, cookie, base, general };
  };

  it("refuses a location quest while the platform switch is off, and takes one with its place when on", async () => {
    const s = await newEvent();
    await switchLocation(false);
    const off = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      quest(s.general, "location", { place: PLACE }),
    );
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: "feature_off" });

    await switchLocation(true);
    const on = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      quest(s.general, "location", { place: PLACE }),
    );
    expect(on.statusCode, on.body).toBe(201);
    expect(on.json()).toMatchObject({
      quest: { type: "location", place: PLACE, verification: ["quest_qr"] },
    });
    const codes = await call("GET", `${s.base}/codes`, s.cookie);
    expect(JSON.stringify(codes.json())).toContain(on.json<{ quest: { id: string } }>().quest.id);
  });

  it("requires a place on a location quest, takes one on spot types only, and checks its radius", async () => {
    const s = await newEvent();
    await switchLocation(true);
    const missing = await call("POST", `${s.base}/quests`, s.cookie, quest(s.general, "location"));
    expect(missing.json()).toMatchObject({ code: "invalid_quest", details: { field: "place" } });
    const typed = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      quest(s.general, "enter_code", { place: PLACE, config: { code: "ABCD1" } }),
    );
    expect(typed.json()).toMatchObject({ code: "invalid_quest", details: { field: "place" } });
    const tiny = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      quest(s.general, "scan_qr", { place: { ...PLACE, radiusM: 10 } }),
    );
    expect(tiny.statusCode).toBe(400);
    const scan = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      quest(s.general, "scan_qr", { place: PLACE }),
    );
    expect(scan.statusCode).toBe(201);
    const id = scan.json<{ quest: { id: string } }>().quest.id;
    const cleared = await call("PATCH", `${s.base}/quests/${id}`, s.cookie, { place: null });
    expect(cleared.json()).toMatchObject({ quest: { place: null } });
  });

  it("keeps an existing location quest editable while the switch is off", async () => {
    const s = await newEvent();
    await switchLocation(true);
    const made = await call(
      "POST",
      `${s.base}/quests`,
      s.cookie,
      quest(s.general, "location", { place: PLACE }),
    );
    const id = made.json<{ quest: { id: string } }>().quest.id;
    await switchLocation(false);
    const edited = await call("PATCH", `${s.base}/quests/${id}`, s.cookie, { points: 20 });
    expect(edited.json()).toMatchObject({ quest: { points: 20, place: PLACE } });
  });

  it("sets, reads and clears the event's venue pin and radius", async () => {
    const s = await newEvent();
    const event = `/v1/organizers/${s.orgId}/events/${s.eventId}`;
    const pinned = await call("PATCH", event, s.cookie, {
      venuePin: { lat: 24.7136, lng: 46.6753 },
      venueRadiusM: 600,
    });
    expect(pinned.json()).toMatchObject({
      event: { venuePin: { lat: 24.7136, lng: 46.6753 }, venueRadiusM: 600 },
    });
    expect((await call("PATCH", event, s.cookie, { venueRadiusM: 50 })).statusCode).toBe(400);
    const cleared = await call("PATCH", event, s.cookie, { venuePin: null });
    expect(cleared.json()).toMatchObject({ event: { venuePin: null, venueRadiusM: 600 } });
  });
});
