import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/** The test config's QR secret (test/support/auth-app.ts), so a test can show a real My QR. */
const MY_KEY = createMyCodeKey("q".repeat(40));

/**
 * The prize desk over HTTP (T-206): the dashboard's desk settings and the item-reward rule, the operator's header,
 * lookup, handover in both modes, the poll, cancel, the player's Collect, Accept and Not now, and My QR's items.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("prize desk over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('desk-org', 'desk-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@desk.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@desk.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (mode = "collect_first"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, timezone,
                          desk_location_en, handover_confirm)
       VALUES ($1, $2, 'Desk Fest', 'live', now() - interval '1 hour', now() + interval '1 day', 'Asia/Riyadh',
               'Hall B', $3)
       RETURNING id`,
      [organizer, `DESKH${counter}`, mode],
    );
    return event?.id ?? "";
  };

  const fund = async (event: string, enrollment: string, points: number) => {
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points)
       SELECT $1, id, 'scan_qr', 'Q', $2 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [event, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [organizer, event, enrollment, quest?.id, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
      [organizer, event, enrollment, points, done?.id, quest?.id],
    );
  };

  /** A signed-in player; enrolled with 1000 points when an event is given. */
  const newPlayer = async (event?: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`desk_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== undefined) {
      const [enrolled] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [organizer, event, id],
      );
      await fund(event, enrolled?.id ?? "", 1000);
    }
    return { id, token, code: myCode(MY_KEY, id, 1) };
  };

  const newOperator = async (event: string, abilities = ["hand_over"]) => {
    const person = await newPlayer();
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [organizer, event, person.id, abilities],
    );
    return person;
  };

  const newReward = async (event: string, kind = "item") =>
    (
      await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, $2, 'Hoodie', 100, 5) RETURNING id",
        [event, kind],
      )
    )[0]?.id ?? "";

  const app = (
    method: "GET" | "POST",
    path: string,
    token?: string,
    payload?: object,
    key: string | null = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  const dashboard = (method: "GET" | "PUT" | "POST", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });

  const reserve = async (token: string, reward: string): Promise<string> =>
    (await app("POST", `/v1/rewards/${reward}/reserve`, token)).json<{
      redemption: { id: string };
    }>().redemption.id;

  describe("the dashboard's desk (FR-1716, ADR-150)", () => {
    it("saves the place, pin, hours and mode, and answers them back", async () => {
      const event = await newEvent();
      const saved = await dashboard("PUT", `/events/${event}/shop`, {
        desk: {
          location: { ar: "القاعة ب", en: "Hall B" },
          pin: { lat: 24.7136, lng: 46.6753 },
          hours: [
            { opensAt: "2030-01-01T16:00", closesAt: "2030-01-01T22:00" },
            { opensAt: "2030-01-02T10:00", closesAt: "2030-01-02T18:00" },
          ],
        },
        handoverConfirm: "desk_offer",
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ shop: Row }>().shop).toMatchObject({
        desk: {
          location: { ar: "القاعة ب", en: "Hall B" },
          pin: { lat: 24.7136, lng: 46.6753 },
          hours: [
            { opensAt: "2030-01-01T13:00:00.000Z", closesAt: "2030-01-01T19:00:00.000Z" },
            { opensAt: "2030-01-02T07:00:00.000Z", closesAt: "2030-01-02T15:00:00.000Z" },
          ],
        },
        handoverConfirm: "desk_offer",
      });
      const listed = await dashboard("GET", `/events/${event}/rewards`);
      expect(listed.json<{ shop: { desk: Row } }>().shop.desk["hours"]).toHaveLength(2);

      const off = await dashboard("PUT", `/events/${event}/shop`, { desk: { hours: null } });
      expect(off.json<{ shop: { desk: Row } }>().shop.desk).toMatchObject({
        hours: null,
        location: { en: "Hall B" },
      });
    });

    it("refuses overlapping, reversed or too many windows", async () => {
      const event = await newEvent();
      const put = (hours: object[]) =>
        dashboard("PUT", `/events/${event}/shop`, { desk: { hours } });
      const overlap = await put([
        { opensAt: "2030-01-01T10:00", closesAt: "2030-01-01T14:00" },
        { opensAt: "2030-01-01T13:00", closesAt: "2030-01-01T18:00" },
      ]);
      expect(overlap.statusCode).toBe(422);
      expect(overlap.json()).toMatchObject({ details: { field: "deskHours" } });
      expect(
        (await put([{ opensAt: "2030-01-01T14:00", closesAt: "2030-01-01T10:00" }])).statusCode,
      ).toBe(422);
      const many = Array.from({ length: 15 }, (_, day) => ({
        opensAt: `2030-01-${String(day + 1).padStart(2, "0")}T10:00`,
        closesAt: `2030-01-${String(day + 1).padStart(2, "0")}T12:00`,
      }));
      expect((await put(many)).statusCode).toBe(400);
      expect((await put(many.slice(0, 14))).statusCode).toBe(200);
    });

    it("asks for the place before an item reward, and keeps it while one is active", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]);
      const item = { kind: "item", name: { en: "Mug" }, price: 5, stock: 1 };
      const refused = await dashboard("POST", `/events/${event}/rewards`, item);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "desk_needed" });
      const experience = await dashboard("POST", `/events/${event}/rewards`, {
        ...item,
        kind: "experience",
      });
      expect(experience.statusCode).toBe(201);

      await dashboard("PUT", `/events/${event}/shop`, { desk: { location: { en: "Gate 3" } } });
      expect((await dashboard("POST", `/events/${event}/rewards`, item)).statusCode).toBe(201);
      const cleared = await dashboard("PUT", `/events/${event}/shop`, {
        desk: { location: { en: "" } },
      });
      expect(cleared.json()).toMatchObject({ code: "desk_needed" });
      expect(
        (await dashboard("PUT", `/events/${event}/shop`, { pickupMinutes: 30 })).statusCode,
      ).toBe(200);
    });
  });

  describe("collect first", () => {
    it("shows the desk on the shop, then Collect, lookup and Handed over", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const fan = await newPlayer(event);
      const reward = await newReward(event);
      const id = await reserve(fan.token, reward);

      const shop = await app("GET", `/v1/events/${event}/shop`, fan.token, undefined, null);
      expect(shop.json<{ shop: Row }>().shop["desk"]).toEqual({
        location: { ar: null, en: "Hall B" },
        pin: null,
        hours: null,
        state: "open",
        confirm: "collect_first",
        timeZone: "Asia/Riyadh",
      });

      const header = await app(
        "GET",
        `/v1/operator/events/${event}/desk`,
        desk.token,
        undefined,
        null,
      );
      expect(header.json<{ desk: Row }>().desk).toMatchObject({
        state: "open",
        confirm: "collect_first",
      });

      const early = await app("POST", `/v1/operator/redemptions/${id}/hand-over`, desk.token);
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ code: "not_ready" });

      const collected = await app(
        "POST",
        `/v1/redemptions/${id}/collect`,
        fan.token,
        undefined,
        null,
      );
      expect(collected.statusCode).toBe(200);
      expect(collected.json<{ collectUntil: string }>().collectUntil).toMatch(/Z$/);
      const items = await app("GET", "/v1/me/desk-items", fan.token, undefined, null);
      expect(items.json()).toMatchObject({ items: [{ id, state: "collecting" }], watch: false });

      const looked = await app("POST", "/v1/operator/desk/lookup", desk.token, {
        eventId: event,
        code: fan.code,
      });
      expect(looked.json()).toMatchObject({
        result: "found",
        player: { username: expect.stringMatching(/^desk_/) },
        active: true,
        hold: null,
        items: [{ id, kind: "item", ready: true, offered: false }],
      });
      expect(JSON.stringify(looked.json())).not.toContain("price");

      const key = randomUUID();
      const handed = await app(
        "POST",
        `/v1/operator/redemptions/${id}/hand-over`,
        desk.token,
        undefined,
        key,
      );
      expect(handed.json()).toEqual({ status: "handed_over", offerUntil: null, replayed: false });
      const again = await app(
        "POST",
        `/v1/operator/redemptions/${id}/hand-over`,
        desk.token,
        undefined,
        key,
      );
      expect(again.json()).toEqual(handed.json());

      const after = await app("GET", `/v1/events/${event}/shop`, fan.token, undefined, null);
      expect(after.json<{ redemptions: Row[]; balance: number }>()).toMatchObject({
        balance: 900,
        redemptions: [{ id, status: "handed_over", collectUntil: null }],
      });
      const cancel = await app("POST", `/v1/operator/redemptions/${id}/cancel`, desk.token);
      expect(cancel.json()).toMatchObject({
        code: "reservation_ended",
        details: { status: "handed_over" },
      });
    });
  });

  describe("desk offer", () => {
    it("offers, polls, lets the player decline and accept", async () => {
      const event = await newEvent("desk_offer");
      const desk = await newOperator(event);
      const fan = await newPlayer(event);
      const id = await reserve(fan.token, await newReward(event, "experience"));

      const watching = await app("GET", "/v1/me/desk-items", fan.token, undefined, null);
      expect(watching.json()).toEqual({ items: [], watch: true });
      const collect = await app(
        "POST",
        `/v1/redemptions/${id}/collect`,
        fan.token,
        undefined,
        null,
      );
      expect(collect.json()).toMatchObject({ code: "handover_mode" });
      const early = await app("POST", `/v1/redemptions/${id}/accept`, fan.token);
      expect(early.json()).toMatchObject({ code: "offer_gone" });

      const offered = await app("POST", `/v1/operator/redemptions/${id}/hand-over`, desk.token);
      expect(offered.json()).toMatchObject({ status: "offered", replayed: false });
      const poll = await app("GET", `/v1/operator/redemptions/${id}`, desk.token, undefined, null);
      expect(poll.headers["cache-control"]).toBe("no-store");
      expect(poll.json()).toMatchObject({ status: "reserved", offered: true });

      const declined = await app(
        "POST",
        `/v1/redemptions/${id}/decline`,
        fan.token,
        undefined,
        null,
      );
      expect(declined.statusCode).toBe(204);
      await app("POST", `/v1/operator/redemptions/${id}/hand-over`, desk.token);
      const accepted = await app("POST", `/v1/redemptions/${id}/accept`, fan.token);
      expect(accepted.json()).toEqual({ status: "handed_over", replayed: false });
      const polled = await app(
        "GET",
        `/v1/operator/redemptions/${id}`,
        desk.token,
        undefined,
        null,
      );
      expect(polled.json()).toMatchObject({ status: "handed_over", offered: false });
    });
  });

  describe("refusals", () => {
    it("answers each lookup refusal as a result, and a non-operator with 403", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const scanner = await newOperator(event, ["scan_quests"]);
      const fan = await newPlayer(event);
      const stranger = await newPlayer(await newEvent());
      const look = (token: string, code: string) =>
        app("POST", "/v1/operator/desk/lookup", token, { eventId: event, code });
      expect((await look(desk.token, "nonsense")).json()).toEqual({
        result: "refused",
        reason: "invalid_code",
      });
      expect((await look(desk.token, myCode(MY_KEY, fan.id, 2))).json()).toEqual({
        result: "refused",
        reason: "old_code",
      });
      expect((await look(desk.token, desk.code)).json()).toEqual({
        result: "refused",
        reason: "self_scan",
      });
      expect((await look(desk.token, stranger.code)).json()).toEqual({
        result: "refused",
        reason: "not_in_event",
      });
      expect((await look(scanner.token, fan.code)).json()).toEqual({
        result: "refused",
        reason: "ability_off",
      });
      const outsider = await look(fan.token, fan.code);
      expect(outsider.statusCode).toBe(403);
      expect(outsider.json()).toMatchObject({ code: "not_operator" });
    });

    it("maps the handover refusals", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const scanner = await newOperator(event, ["scan_quests"]);
      const fan = await newPlayer(event);
      const id = await reserve(fan.token, await newReward(event));
      await app("POST", `/v1/redemptions/${id}/collect`, fan.token, undefined, null);

      const off = await app("POST", `/v1/operator/redemptions/${id}/hand-over`, scanner.token);
      expect(off.statusCode).toBe(403);
      expect(off.json()).toMatchObject({ code: "ability_off" });
      const unknown = await app(
        "POST",
        `/v1/operator/redemptions/${randomUUID()}/hand-over`,
        desk.token,
      );
      expect(unknown.statusCode).toBe(404);

      await owner(
        `UPDATE event SET desk_hours = tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours'))
         WHERE id = $1`,
        [event],
      );
      const closed = await app("POST", `/v1/operator/redemptions/${id}/hand-over`, desk.token);
      expect(closed.statusCode).toBe(403);
      expect(closed.json()).toMatchObject({ code: "desk_closed" });
      await owner("UPDATE event SET desk_hours = NULL WHERE id = $1", [event]);

      await owner("UPDATE enrollment SET status = 'banned' WHERE player_id = $1", [fan.id]);
      const banned = await app("POST", `/v1/operator/redemptions/${id}/hand-over`, desk.token);
      expect(banned.statusCode).toBe(409);
      expect(banned.json()).toMatchObject({ code: "held" });
      const held = await app("POST", "/v1/operator/desk/lookup", desk.token, {
        eventId: event,
        code: fan.code,
      });
      expect(held.json()).toMatchObject({ active: true, hold: "held" });
      for (const answer of [banned, held]) {
        expect(JSON.stringify(answer.json())).not.toContain("banned");
      }
      await owner(
        "UPDATE enrollment SET status = 'active', redeem_paused_at = now() WHERE player_id = $1",
        [fan.id],
      );
      const paused = await app("POST", `/v1/operator/redemptions/${id}/hand-over`, desk.token);
      expect(paused.statusCode).toBe(409);
      expect(paused.json()).toMatchObject({ code: "paused" });
      const collect = await app(
        "POST",
        `/v1/redemptions/${id}/collect`,
        fan.token,
        undefined,
        null,
      );
      expect(collect.statusCode).toBe(403);
      expect(collect.json()).toMatchObject({ code: "redeem_paused" });
      const reserveAgain = await app(
        "POST",
        `/v1/rewards/${await newReward(event)}/reserve`,
        fan.token,
      );
      expect(reserveAgain.statusCode).toBe(403);
      expect(reserveAgain.json()).toMatchObject({ code: "redeem_paused" });

      const cancelled = await app("POST", `/v1/operator/redemptions/${id}/cancel`, desk.token);
      expect(cancelled.json()).toMatchObject({ status: "cancelled", replayed: false });
    });

    it("needs a session, and an Idempotency-Key on the unsafe desk calls", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const id = randomUUID();
      expect(
        (await app("GET", `/v1/operator/events/${event}/desk`, undefined, undefined, null))
          .statusCode,
      ).toBe(401);
      expect((await app("GET", "/v1/me/desk-items", undefined, undefined, null)).statusCode).toBe(
        401,
      );
      expect(
        (await app("POST", `/v1/redemptions/${id}/collect`, undefined, undefined, null)).statusCode,
      ).toBe(401);
      for (const path of [
        `/v1/operator/redemptions/${id}/hand-over`,
        `/v1/operator/redemptions/${id}/cancel`,
        `/v1/redemptions/${id}/accept`,
      ]) {
        expect((await app("POST", path, desk.token, undefined, null)).statusCode).toBe(400);
      }
    });
  });

  const find = (token: string, event: string, query: string) =>
    app("POST", `/v1/operator/events/${event}/desk/find`, token, { query }, null);

  describe("find by username or phone (FR-1848)", () => {
    it("finds by username, @username or a local mobile, and answers none for nobody", async () => {
      const event = await newEvent();
      const desk = await newOperator(event);
      const fan = await newPlayer(event);
      const [named] = await owner<{ username: string }>(
        "SELECT username FROM player WHERE id = $1",
        [fan.id],
      );
      await owner(
        "INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, '+966598765432')",
        [fan.id],
      );
      const id = await reserve(fan.token, await newReward(event));
      for (const query of [named?.username ?? "", `@${named?.username ?? ""}`, "0598765432"]) {
        expect((await find(desk.token, event, query)).json()).toMatchObject({
          result: "found",
          player: { username: named?.username },
          active: true,
          hold: null,
          items: [{ id }],
        });
      }
      expect((await find(desk.token, event, "nobody_here")).json()).toEqual({ result: "none" });
      // Only a leading @ is dropped: an @ inside the name is searched as typed.
      const inside = `${named?.username.slice(0, 2) ?? ""}@${named?.username.slice(2) ?? ""}`;
      expect((await find(desk.token, event, inside)).json()).toEqual({ result: "none" });
      expect((await find(desk.token, event, "")).statusCode).toBe(400);
    });

    it("needs the hand-over ability and stops at 30 finds in 10 minutes", async () => {
      const event = await newEvent();
      const awarder = await newOperator(event, ["award"]);
      const off = await find(awarder.token, event, "someone");
      expect(off.statusCode).toBe(403);
      expect(off.json()).toMatchObject({ code: "ability_off" });
      const desk = await newOperator(event);
      for (let i = 0; i < 30; i += 1) {
        expect((await find(desk.token, event, `nobody_${i}`)).statusCode).toBe(200);
      }
      const limited = await find(desk.token, event, "nobody");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    });
  });
});
