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

type Method = "GET" | "PUT" | "DELETE" | "POST";

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

  const ask = (event: string, cookie = owner, feature = "bigScreen", organizer?: string) =>
    call("POST", `${base(event, organizer)}/feature-requests`, cookie, { feature });
  const bigScreen = async (event: string) =>
    (await layers(event)).features.find((row) => row.key === "bigScreen");
  const queue = async () =>
    (await call("GET", "/v1/admin/feature-requests", admin)).json<{
      requests: { id: string; eventId: string }[];
    }>().requests;

  it("lists the features an owner can see: switches on or off, and the add-on locked", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    const rows = await layers(event);
    const byKey = Object.fromEntries(rows.features.map((row) => [row.key, row]));
    expect(byKey["shop"]).toEqual({ key: "shop", state: "on", addOn: false, request: null });
    expect(byKey["questRatings"]?.state).toBe("off");
    expect(byKey["bigScreen"]).toEqual({
      key: "bigScreen",
      state: "locked",
      addOn: true,
      request: null,
    });
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

  it("hides what the platform turns off and refuses the owner's switch-on, on the shop's route and the ranking's", async () => {
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

  it("has no owner route for a switch Questify sets for everyone, and answers 403 to an editor", async () => {
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

  it("follows the override for boosts, community, meet-someone and mini-games too (T-711b)", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    for (const [key, path] of [
      ["boosts", "double-points"],
      ["community", "community"],
      ["meetSomeone", "meet-someone"],
      ["miniGames", "mini-games"],
    ] as const) {
      expect(await stateOf(event, key), key).toBe("on");
      expect(
        (await call("PUT", `${base(event)}/${path}`, owner, { enabled: false })).statusCode,
      ).toBe(200);
      expect((await override(key, false)).statusCode).toBe(204);
      expect(await stateOf(event, key), key).toBeUndefined();
      expect(await composed(event, key)).toBe(false);
      const refused = await call("PUT", `${base(event)}/${path}`, owner, { enabled: true });
      expect([key, refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        key,
        403,
        "feature_not_allowed",
      ]);
      expect((await override(key, null)).statusCode).toBe(204);
    }
  });

  it("refuses a boost or a community goal saved under the override Off, and saves one under an override On", async () => {
    const event = await fixture.newEvent({ phase: "live" });
    const [category] = await fixture.owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1",
      [event],
    );
    const boost = { categoryId: category?.id, minutes: 30, startsAt: null };
    const goal = {
      title: { en: "Light the tower" },
      measure: "points",
      target: 100,
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      reward: { kind: "points", points: 20 },
    };
    await override("boosts", false);
    await override("community", false);
    for (const [path, body] of [
      ["boosts", boost],
      ["community-goals", goal],
    ] as const) {
      const refused = await call("POST", `${base(event)}/${path}`, owner, body);
      expect([path, refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        path,
        403,
        "feature_off",
      ]);
    }
    // Another organizer's event answers as before: not found, nothing said about its layer.
    const theirs = await fixture.newEvent({ phase: "live", organizer: fixture.ids.orgB });
    expect((await call("POST", `${base(theirs)}/boosts`, owner, boost)).statusCode).toBe(404);
    await platform("boosts", false);
    await platform("community", false);
    await override("boosts", true);
    await override("community", true);
    expect((await call("POST", `${base(event)}/boosts`, owner, boost)).statusCode).toBe(201);
    expect((await call("POST", `${base(event)}/community-goals`, owner, goal)).statusCode).toBe(
      201,
    );
    await platform("boosts", null);
    await platform("community", null);
    await override("boosts", null);
    await override("community", null);
  });

  describe("Ask Questify (FR-1827)", () => {
    it("records the owner's request once, shows it on the card, and refuses the others", async () => {
      const event = await fixture.newEvent({ phase: "live" });
      const first = await ask(event);
      expect(first.statusCode).toBe(201);
      const { request } = first.json<{ request: { id: string; status: string } }>();
      expect(request.status).toBe("open");
      const again = await ask(event);
      expect([again.statusCode, again.json<{ request: { id: string } }>().request.id]).toEqual([
        200,
        request.id,
      ]);
      expect((await bigScreen(event))?.request?.status).toBe("open");
      expect((await ask(event, editor)).statusCode).toBe(403);
      expect((await ask(event, otherOwner)).statusCode).toBe(404);
      expect((await ask(event, otherOwner, "bigScreen", fixture.ids.orgB)).statusCode).toBe(404);
      expect((await ask(event, "")).statusCode).toBe(401);
      const unknown = await ask(event, owner, "shop");
      expect([unknown.statusCode, unknown.json<{ code: string }>().code]).toEqual([
        422,
        "unknown_addon",
      ]);
    });

    it("lists it for admins until Allow (the unlock) closes it; a lock never reopens it", async () => {
      const event = await fixture.newEvent({ phase: "live" });
      const { request } = (await ask(event)).json<{ request: { id: string } }>();
      expect((await queue()).map((row) => row.id)).toContain(request.id);
      expect((await call("GET", "/v1/admin/feature-requests", owner)).statusCode).toBe(404);
      expect(
        (await call("PUT", `/v1/admin/events/${event}/addons/bigScreen`, admin)).statusCode,
      ).toBe(204);
      expect((await queue()).map((row) => row.id)).not.toContain(request.id);
      expect(await bigScreen(event)).toMatchObject({ state: "on", request: { status: "allowed" } });
      const closed = await fixture.owner<{ status: string; decided_by: string }>(
        "SELECT status, decided_by FROM feature_request WHERE id = $1",
        [request.id],
      );
      expect(closed).toEqual([
        { status: "allowed", decided_by: await staffIdOf("admin@layers.test") },
      ]);
      const unlocked = await ask(event);
      expect([unlocked.statusCode, unlocked.json<{ code: string }>().code]).toEqual([
        409,
        "addon_unlocked",
      ]);
      expect(
        (await call("DELETE", `/v1/admin/events/${event}/addons/bigScreen`, admin)).statusCode,
      ).toBe(204);
      expect((await bigScreen(event))?.request?.status).toBe("allowed");
      expect((await queue()).map((row) => row.eventId)).not.toContain(event);
    });

    it("hides an open request whose add-on is already unlocked, and declines one with a 24-hour wait", async () => {
      const raced = await fixture.newEvent({ phase: "live" });
      const { request: open } = (await ask(raced)).json<{ request: { id: string } }>();
      await fixture.owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [raced, fixture.ids.orgA],
      );
      expect((await queue()).map((row) => row.id)).not.toContain(open.id);

      const event = await fixture.newEvent({ phase: "live" });
      const { request } = (await ask(event)).json<{ request: { id: string } }>();
      const decline = (cookie: string) =>
        call("POST", `/v1/admin/feature-requests/${request.id}/decline`, cookie, {});
      expect((await decline(owner)).statusCode).toBe(404);
      expect((await decline(admin)).statusCode).toBe(204);
      expect((await decline(admin)).statusCode).toBe(404);
      expect(await bigScreen(event)).toMatchObject({
        state: "locked",
        request: { status: "declined" },
      });
      const wait = await ask(event);
      expect([wait.statusCode, wait.json<{ code: string }>().code]).toEqual([
        429,
        "request_declined_recently",
      ]);
      expect(Number(wait.headers["retry-after"])).toBeGreaterThan(86_000);
      const audit = await fixture.owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id",
        [request.id],
      );
      expect(audit.map((row) => row.action)).toEqual([
        "feature_request.create",
        "feature_request.decline",
      ]);
    });

    it("lets an editor scoped to one event read only that event's requests; the owner and an admin read both (0189)", async () => {
      const kept = await fixture.newEvent({ phase: "live" });
      const other = await fixture.newEvent({ phase: "live" });
      const ownerId = await staffIdOf("owner@layers.test");
      const made = await fixture.owner<{ id: string; event_id: string }>(
        `INSERT INTO feature_request (organizer_id, event_id, feature, requested_by)
         SELECT $1, e, 'bigScreen', $2 FROM unnest($3::uuid[]) e RETURNING id, event_id`,
        [fixture.ids.orgA, ownerId, [kept, other]],
      );
      const idOf = (event: string) => made.find((row) => row.event_id === event)?.id;
      const scoped = await createStaff(fixture.db.owner, { email: "scoped@layers.test" });
      await fixture.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
        [fixture.ids.orgA, scoped, [kept]],
      );
      const read = async (context: Parameters<typeof fixture.run>[0]) =>
        (
          await fixture.run<{ id: string }>(
            context,
            "SELECT id FROM feature_request WHERE event_id = ANY ($1) ORDER BY id",
            [[kept, other]],
          )
        ).map((row) => row.id);
      const both = made.map((row) => row.id).toSorted();
      expect(await read({ organizerId: fixture.ids.orgA, staffUserId: scoped })).toEqual([
        idOf(kept),
      ]);
      expect(await read({ organizerId: fixture.ids.orgA, staffUserId: ownerId })).toEqual(both);
      expect(
        await read({ isAdmin: true, staffUserId: await staffIdOf("admin@layers.test") }),
      ).toEqual(both);
    });

    it("holds an owner to 20 requests an hour", async () => {
      const event = await fixture.newEvent({ phase: "live" });
      await fixture.owner("DELETE FROM auth_throttle WHERE bucket = 'feature_request'");
      for (let sent = 0; sent < 20; sent += 1) {
        expect((await ask(event)).statusCode).toBeLessThan(300);
      }
      const held = await ask(event);
      expect([held.statusCode, held.json<{ code: string }>().code]).toEqual([
        429,
        "too_many_attempts",
      ]);
      await fixture.owner("DELETE FROM auth_throttle WHERE bucket = 'feature_request'");
    });
  });

  const staffIdOf = async (email: string) =>
    (await fixture.owner<{ id: string }>("SELECT id FROM staff_user WHERE email = $1", [email]))[0]
      ?.id ?? "";
});
