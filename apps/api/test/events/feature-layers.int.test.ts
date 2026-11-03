import { randomUUID } from "node:crypto";
import { eventLayersSchema, type EventLayers } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { createSettingsService } from "#src/settings/service";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Method = "GET" | "PUT" | "DELETE";

/**
 * The owner's side of the feature layers over HTTP (T-711, FR-1826, FR-1827): the features list shows what the platform
 * (or Questify, for this organizer) leaves on, an add-on Questify has not allowed is locked, and the server refuses an
 * owner's switch-on that a layer keeps off, on every route that saves a switch, writing nothing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event feature layers over HTTP", () => {
  let fixture: PushFixture;
  let test: TestApp;
  let owner = "";
  let editor = "";
  let otherOwner = "";
  let admin = "";

  beforeAll(async () => {
    fixture = await pushFixture();
    test = await startApp(fixture.db);
    await fixture.owner("UPDATE organizer_member SET role = 'editor' WHERE organizer_id = $1", [
      fixture.ids.orgA,
    ]);
    const staff = async (name: string, role: string, organizer: string) => {
      const email = `${name}@layers.test`;
      const id = await createStaff(fixture.db.owner, { email });
      await fixture.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, $3, NULL)",
        [organizer, id, role],
      );
      return signInFully(test, email);
    };
    owner = await staff("owner", "owner", fixture.ids.orgA);
    editor = await staff("editor", "editor", fixture.ids.orgA);
    otherOwner = await staff("other", "owner", fixture.ids.orgB);
    await createStaff(fixture.db.owner, { email: "admin@layers.test", admin: true });
    admin = await signInFully(test, "admin@layers.test");
  });
  afterAll(async () => {
    await test.close();
    await fixture.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const base = (event: string, organizer = fixture.ids.orgA) =>
    `/v1/organizers/${organizer}/events/${event}`;
  const layers = async (event: string, cookie = owner): Promise<EventLayers> =>
    eventLayersSchema.parse((await call("GET", `${base(event)}/features`, cookie)).json());
  const stateOf = async (event: string, key: string) =>
    (await layers(event)).features.find((row) => row.key === key)?.state;
  const platform = (key: string, enabled: boolean | null) =>
    enabled === null
      ? call("DELETE", `/v1/admin/switches/features/${key}`, admin)
      : call("PUT", `/v1/admin/switches/features/${key}`, admin, { enabled, message: null });
  const override = (key: string, enabled: boolean | null) =>
    enabled === null
      ? call("DELETE", `/v1/admin/organizers/${fixture.ids.orgA}/features/${key}`, admin)
      : call("PUT", `/v1/admin/organizers/${fixture.ids.orgA}/features/${key}`, admin, { enabled });
  const stored = async (event: string) =>
    (
      await fixture.owner<{ features: unknown }>(
        "SELECT config -> 'features' AS features FROM event WHERE id = $1",
        [event],
      )
    )[0]?.features ?? null;
  const composed = async (event: string, key: string) =>
    (await test.app.inject({ method: "GET", url: `/v1/config?event=${event}` })).json<{
      features: Record<string, { enabled: boolean }>;
    }>().features[key]?.enabled;

  it("lists the features an owner can see: switches on or off, and the add-on locked", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    const rows = await layers(event);
    const byKey = Object.fromEntries(rows.features.map((row) => [row.key, row]));
    expect(byKey["shop"]).toEqual({ key: "shop", state: "on", addOn: false });
    expect(byKey["questRatings"]?.state).toBe("off");
    expect(byKey["bigScreen"]).toEqual({ key: "bigScreen", state: "locked", addOn: true });
    for (const platformWide of ["dailyStreak", "usernameChanges", "locationQuests", "kiosks"]) {
      expect(byKey[platformWide], platformWide).toBeUndefined();
    }
    expect(
      (await call("PUT", `/v1/admin/events/${event}/addons/bigScreen`, admin)).statusCode,
    ).toBe(204);
    expect((await layers(event)).features.find((row) => row.key === "bigScreen")?.state).toBe("on");
  });

  it("shows an editor the list and gives a stranger and another organizer's owner nothing", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    expect((await layers(event, editor)).features.length).toBeGreaterThan(5);
    // Another organizer asking through its own path, and through ours: a public event is no exception.
    expect(
      (await call("GET", `${base(event, fixture.ids.orgB)}/features`, otherOwner)).statusCode,
    ).toBe(404);
    expect((await call("GET", `${base(event)}/features`, otherOwner)).statusCode).toBe(404);
    expect((await call("GET", `${base(event)}/features`, "")).statusCode).toBe(401);
  });

  it("hides what the platform turns off and refuses the owner's switch-on, on the generic route and the page's own", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    await call("PUT", `${base(event)}/features/shop`, owner, { enabled: false });
    await platform("shop", false);
    await platform("ranking", false);
    expect(await stateOf(event, "shop")).toBeUndefined();
    expect(await stateOf(event, "ranking")).toBeUndefined();

    const refusals = await Promise.all([
      call("PUT", `${base(event)}/features/shop`, owner, { enabled: true }),
      call("PUT", `${base(event)}/ranking`, owner, { enabled: true }),
    ]);
    for (const refused of refusals) {
      expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        403,
        "feature_not_allowed",
      ]);
    }
    expect(await stored(event)).toEqual({ shop: false });
    // Switching off is always allowed.
    expect(
      (await call("PUT", `${base(event)}/ranking`, owner, { enabled: false })).statusCode,
    ).toBe(200);
    expect(await composed(event, "shop")).toBe(false);

    await platform("shop", null);
    await platform("ranking", null);
    expect(await stateOf(event, "shop")).toBe("off");
    expect(
      (await call("PUT", `${base(event)}/features/shop`, owner, { enabled: true })).statusCode,
    ).toBe(200);
    expect(await composed(event, "shop")).toBe(true);
  });

  it("follows Questify's override for the organizer: On brings a platform-off feature back, Off takes it away", async () => {
    const mine = await fixture.newEvent({ phase: "live" });
    const theirs = await fixture.newEvent({ phase: "live", organizer: fixture.ids.orgB });
    await platform("maps", false);
    expect(await stateOf(mine, "maps")).toBeUndefined();

    expect((await override("maps", true)).statusCode).toBe(204);
    expect(await stateOf(mine, "maps")).toBe("on");
    expect(await composed(mine, "maps")).toBe(true);
    expect(await composed(theirs, "maps")).toBe(false);
    expect(
      (await call("PUT", `${base(mine)}/features/maps`, owner, { enabled: true })).statusCode,
    ).toBe(200);

    await platform("maps", null);
    expect((await override("maps", false)).statusCode).toBe(204);
    expect(await stateOf(mine, "maps")).toBeUndefined();
    expect(await composed(mine, "maps")).toBe(false);
    expect(await composed(theirs, "maps")).toBe(true);
    const refused = await call("PUT", `${base(mine)}/features/maps`, owner, { enabled: true });
    expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
      403,
      "feature_not_allowed",
    ]);

    expect((await override("maps", null)).statusCode).toBe(204);
    expect(await stateOf(mine, "maps")).toBe("on");
    expect(await composed(mine, "maps")).toBe(true);
  });

  it("refuses an add-on Questify has not allowed, and has no owner switch for it", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    expect(
      (await call("PUT", `${base(event)}/features/bigScreen`, owner, { enabled: true })).statusCode,
    ).toBe(404);
    expect(await stored(event)).toBeNull();
    // The bulk replace is not on a route, but it takes the same wall: only a switch newly turned on is checked.
    const settings = createSettingsService({ pool: fixture.pool, ttlMs: 0 });
    const actor = {
      staffUserId: await staffIdOf("owner@layers.test"),
      organizerId: fixture.ids.orgA,
    };
    const save = (features: Record<string, boolean>) =>
      settings.saveEventSwitches(actor, event, { features });
    expect((await save({ cheers: true })).ok).toBe(true);
    await platform("cheers", false);
    await platform("polls", false);
    expect(await save({ cheers: true, polls: true })).toEqual({ ok: false, reason: "not_allowed" });
    expect(await stored(event)).toEqual({ cheers: true });
    expect((await save({ cheers: true, shop: false })).ok).toBe(true);
    await platform("cheers", null);
    await platform("polls", null);
  });

  it("answers 404 for a switch that does not exist or that Questify sets for everyone, and 403 to an editor", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    for (const feature of ["dailyStreak", "locationQuests", "teleporter", "constructor"]) {
      const refused = await call("PUT", `${base(event)}/features/${feature}`, owner, {
        enabled: true,
      });
      expect(refused.statusCode, feature).toBe(404);
    }
    expect(
      (await call("PUT", `${base(event)}/features/shop`, editor, { enabled: false })).statusCode,
    ).toBe(403);
    expect(
      (
        await call("PUT", `${base(event, fixture.ids.orgB)}/features/shop`, otherOwner, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(404);
    expect(await stored(event)).toBeNull();
  });

  const staffIdOf = async (email: string) =>
    (await fixture.owner<{ id: string }>("SELECT id FROM staff_user WHERE email = $1", [email]))[0]
      ?.id ?? "";
});
