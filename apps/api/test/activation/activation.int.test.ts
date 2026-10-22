import { createHash, randomBytes, randomUUID } from "node:crypto";
import { joinCard } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/** Activation over HTTP (T-210): the owner's request, the console's activate, reject, limit and add-ons, and joining. */
describe.skipIf(TEST_DATABASE_URL === undefined)("event activation over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer: string;
  let ownerCookie: string;
  let editorCookie: string;
  let adminCookie: string;
  let strangerCookie: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Activation Co', 'act-co') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@act.test" });
    const editorId = await createStaff(db.owner, { email: "editor@act.test" });
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    await createStaff(db.owner, { email: "stranger@act.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
      [organizer, ownerId, editorId],
    );
    ownerCookie = await signInFully(test, "owner@act.test");
    editorCookie = await signInFully(test, "editor@act.test");
    adminCookie = await signInFully(test, "admin@questify.test");
    strangerCookie = await signInFully(test, "stranger@act.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newDraft = async (): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `ACTH${counter}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, venue_en, starts_at, ends_at)
       VALUES ($1, $2, 'Spring Fest', 'Riyadh Front', now() - interval '1 hour', now() + interval '2 days')
       RETURNING id`,
      [organizer, code],
    );
    return { id: event?.id ?? "", code };
  };

  const call = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    cookie: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    });
  const team = (method: "GET" | "POST" | "DELETE", event: string, cookie = ownerCookie) =>
    call(method, `/v1/organizers/${organizer}/events/${event}/activation`, cookie);
  const activate = (event: string, payload: object, cookie = adminCookie) =>
    call("POST", `/v1/admin/events/${event}/activate`, cookie, payload, {
      "idempotency-key": randomUUID(),
    });

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`act_http_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [made?.id, createHash("sha256").update(token).digest()],
    );
    return token;
  };
  const join = async (code: string) =>
    test.app.inject({
      method: "POST",
      url: "/v1/join",
      headers: { authorization: `Bearer ${await newPlayer()}`, "x-forwarded-for": freshIp() },
      payload: { joinCode: code, via: "code", cardVersion: joinCard().version },
    });

  describe("the owner's side", () => {
    it("requests once, shows it to the team, and withdraws", async () => {
      const { id } = await newDraft();
      expect((await team("GET", id)).json()).toMatchObject({
        activation: { state: "not_requested", requestedAt: null, limit: { mode: "none" } },
      });
      const first = await team("POST", id);
      expect(first.statusCode).toBe(201);
      expect((await team("POST", id)).statusCode).toBe(200);
      expect((await team("GET", id, editorCookie)).json()).toMatchObject({
        activation: {
          state: "requested",
          requestedAt: first.json<{ requestedAt: string }>().requestedAt,
        },
      });
      expect((await team("DELETE", id)).statusCode).toBe(204);
      expect((await team("DELETE", id)).statusCode).toBe(404);
    });

    it("keeps the request and withdrawal to the owner", async () => {
      const { id } = await newDraft();
      expect((await team("POST", id, editorCookie)).statusCode).toBe(403);
      expect((await team("DELETE", id, editorCookie)).statusCode).toBe(403);
    });

    it("answers 409 for an event that is already activated, and 404 for one that does not exist", async () => {
      const { id } = await newDraft();
      expect((await activate(id, { limit: { mode: "none" }, addons: [] })).statusCode).toBe(200);
      const again = await team("POST", id);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "already_activated" });
      expect((await team("GET", randomUUID())).statusCode).toBe(404);
      expect((await team("POST", randomUUID())).statusCode).toBe(404);
    });
  });

  describe("the console", () => {
    it("hides itself from anyone but a platform admin", async () => {
      const { id } = await newDraft();
      for (const cookie of [ownerCookie, strangerCookie]) {
        expect((await call("GET", "/v1/admin/activation-requests", cookie)).statusCode).toBe(404);
        expect(
          (await activate(id, { limit: { mode: "none" }, addons: [] }, cookie)).statusCode,
        ).toBe(404);
      }
      const anonymous = await test.app.inject({ url: "/v1/admin/activation-requests" });
      expect(anonymous.statusCode).toBe(401);
      expect(await owner("SELECT status FROM event WHERE id = $1", [id])).toEqual([
        { status: "draft" },
      ]);
    });

    it("queues requests oldest first and finds an event by its join code", async () => {
      const { id, code } = await newDraft();
      await team("POST", id);
      const queue = await call("GET", "/v1/admin/activation-requests", adminCookie);
      expect(queue.statusCode).toBe(200);
      expect(
        queue.json<{ requests: { eventId: string }[] }>().requests.map((r) => r.eventId),
      ).toContain(id);
      const found = await call("GET", `/v1/admin/events?code=${code.toLowerCase()}`, adminCookie);
      expect(found.json()).toEqual({ eventId: id });
      expect((await call("GET", "/v1/admin/events?code=NOPE99", adminCookie)).statusCode).toBe(404);
      const detail = await call("GET", `/v1/admin/events/${id}`, adminCookie);
      expect(detail.json()).toMatchObject({
        event: {
          state: "requested",
          event: { id, ownerEmail: "owner@act.test", organizer: { name: "Activation Co" } },
        },
        availableAddons: ["bigScreen"],
      });
    });

    it("activates with a limit and add-ons, and refuses what is not valid", async () => {
      const { id } = await newDraft();
      expect(
        (await activate(id, { limit: { mode: "hard", value: 0 }, addons: [] })).json(),
      ).toMatchObject({ code: "invalid_limit" });
      expect(
        (await activate(id, { limit: { mode: "none", value: 5 }, addons: [] })).statusCode,
      ).toBe(422);
      expect(
        (await activate(id, { limit: { mode: "none" }, addons: ["shop"] })).json(),
      ).toMatchObject({ code: "unknown_addon", details: { feature: "shop" } });
      const done = await activate(id, {
        limit: { mode: "soft", value: 300 },
        addons: ["bigScreen"],
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({
        event: { state: "activated", limit: { mode: "soft", value: 300 }, addons: ["bigScreen"] },
      });
      // Unlocked now: the composed configuration shows it at once (FR-1729).
      const config = await test.app.inject({ url: `/v1/config?event=${id}` });
      expect(config.json()).toMatchObject({ features: { bigScreen: { enabled: true } } });
      expect((await team("GET", id)).json()).toMatchObject({
        activation: { state: "activated", addons: ["bigScreen"] },
      });
    });

    it("names what an event still needs before activation", async () => {
      const { id } = await newDraft();
      await owner("UPDATE event SET venue_en = NULL WHERE id = $1", [id]);
      const refused = await activate(id, { limit: { mode: "none" }, addons: [] });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "activation_incomplete",
        details: { field: "venue" },
      });
      expect(
        (await activate(randomUUID(), { limit: { mode: "none" }, addons: [] })).statusCode,
      ).toBe(404);
    });

    it("rejects a request with a note the owner reads", async () => {
      const { id } = await newDraft();
      const reject = () =>
        call("POST", `/v1/admin/events/${id}/reject`, adminCookie, { note: "Add the map." });
      expect((await reject()).json()).toMatchObject({ code: "no_pending_request" });
      await team("POST", id);
      expect((await reject()).statusCode).toBe(204);
      expect((await team("GET", id)).json()).toMatchObject({
        activation: { state: "rejected", note: "Add the map." },
      });
    });

    it("changes the limit and the add-ons of an activated event", async () => {
      const { id } = await newDraft();
      const limit = (payload: object) =>
        call("PUT", `/v1/admin/events/${id}/limit`, adminCookie, payload);
      expect((await limit({ mode: "hard", value: 10 })).json()).toMatchObject({
        code: "not_activated",
      });
      await activate(id, { limit: { mode: "none" }, addons: [] });
      expect((await limit({ mode: "hard", value: 10 })).json()).toEqual({
        limit: { mode: "hard", value: 10 },
      });
      expect((await limit({ mode: "soft" })).statusCode).toBe(422);
      const addon = (method: "PUT" | "DELETE", feature: string) =>
        call(method, `/v1/admin/events/${id}/addons/${feature}`, adminCookie);
      expect((await addon("PUT", "shop")).statusCode).toBe(422);
      expect((await addon("PUT", "bigScreen")).statusCode).toBe(204);
      expect((await team("GET", id)).json()).toMatchObject({
        activation: { addons: ["bigScreen"] },
      });
      expect((await addon("DELETE", "bigScreen")).statusCode).toBe(204);
      expect((await addon("DELETE", "bigScreen")).statusCode).toBe(404);
    });
  });

  describe("what the console shows and records", () => {
    it("shows each queued request and the event in full, and 404 for an unknown event", async () => {
      const { id, code } = await newDraft();
      await team("POST", id);
      const queue = await call("GET", "/v1/admin/activation-requests", adminCookie);
      const item = queue
        .json<{ requests: { eventId: string }[] }>()
        .requests.find((request) => request.eventId === id);
      expect(item).toEqual({
        eventId: id,
        name: { ar: null, en: "Spring Fest" },
        organizer: "Activation Co",
        requestedAt: expect.any(String),
        startsAt: expect.any(String),
        timezone: "Asia/Riyadh",
      });
      const detail = await call("GET", `/v1/admin/events/${id}`, adminCookie);
      expect(detail.json()).toMatchObject({
        event: {
          event: {
            joinCode: code,
            name: { ar: null, en: "Spring Fest" },
            venue: { ar: null, en: "Riyadh Front" },
            startsAt: expect.any(String),
            endsAt: expect.any(String),
          },
        },
      });
      expect((await call("GET", `/v1/admin/events/${randomUUID()}`, adminCookie)).statusCode).toBe(
        404,
      );
      const undated = await newDraft();
      await owner("UPDATE event SET starts_at = NULL, ends_at = NULL WHERE id = $1", [undated.id]);
      await team("POST", undated.id);
      const requests = (await call("GET", "/v1/admin/activation-requests", adminCookie)).json<{
        requests: { eventId: string; startsAt: string | null }[];
      }>().requests;
      expect(requests.find((request) => request.eventId === undated.id)?.startsAt).toBeNull();
      expect(
        (await call("GET", `/v1/admin/events/${undated.id}`, adminCookie)).json(),
      ).toMatchObject({ event: { event: { startsAt: null, endsAt: null } } });
    });

    it("keeps the request id of every change in the audit log", async () => {
      const { id } = await newDraft();
      await team("POST", id);
      await team("DELETE", id);
      await team("POST", id);
      await call("POST", `/v1/admin/events/${id}/reject`, adminCookie, { note: "Not yet." });
      await activate(id, { limit: { mode: "none" }, addons: [] });
      await call("PUT", `/v1/admin/events/${id}/limit`, adminCookie, { mode: "hard", value: 9 });
      const entries = await owner<{ action: string; request_id: string | null }>(
        "SELECT action, request_id FROM audit_log WHERE event_id = $1 ORDER BY id",
        [id],
      );
      expect(entries.length).toBeGreaterThanOrEqual(6);
      expect(entries.filter((entry) => entry.request_id === null)).toEqual([]);
    });

    it("shows an add-on in the app's configuration as soon as it is unlocked or locked", async () => {
      const { id } = await newDraft();
      const bigScreen = async () =>
        (await test.app.inject({ url: `/v1/config?event=${id}` })).json<{
          features: { bigScreen: { enabled: boolean } };
        }>().features.bigScreen.enabled;
      await activate(id, { limit: { mode: "none" }, addons: [] });
      expect(await bigScreen()).toBe(false);
      await call("PUT", `/v1/admin/events/${id}/addons/bigScreen`, adminCookie);
      expect(await bigScreen()).toBe(true);
      await call("DELETE", `/v1/admin/events/${id}/addons/bigScreen`, adminCookie);
      expect(await bigScreen()).toBe(false);
      await call("PUT", `/v1/admin/events/${id}/addons/bigScreen`, adminCookie);
      expect(await bigScreen()).toBe(true);
      await call("DELETE", `/v1/admin/events/${id}/addons/bigScreen`, adminCookie);
      expect(await bigScreen()).toBe(false);
    });
  });

  describe("joining", () => {
    it("has no working join for a draft; activation opens it; a full hard limit closes it", async () => {
      const { id, code } = await newDraft();
      expect((await join(code)).statusCode).toBe(404);
      await activate(id, { limit: { mode: "hard", value: 1 }, addons: [] });
      expect((await join(code)).statusCode).toBe(200);
      const full = await join(code);
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ code: "event_full" });
      expect((await team("GET", id)).json()).toMatchObject({
        activation: { players: 1, alerts: [80, 100] },
      });
    });
  });
});
