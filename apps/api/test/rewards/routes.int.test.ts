import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Reward = {
  id: string;
  stock: number;
  unitsOut: number;
  stockLeft: number;
  price: number;
  opensAt: string | null;
};

const key = () => ({ "idempotency-key": randomUUID() });

describe.skipIf(TEST_DATABASE_URL === undefined)("rewards over HTTP (T-201, T-202)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  let orgId = "";
  let eventId = "";
  let cookie = "";
  let base = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'rewards') RETURNING id",
    );
    orgId = org?.id ?? "";
    const staff = await createStaff(db.owner, { email: "owner@rewards.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [orgId, staff],
    );
    cookie = await signInFully(test, "owner@rewards.test");
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'SHOP1', 'Shop Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [orgId],
    );
    eventId = event?.id ?? "";
    base = `/v1/organizers/${orgId}/events/${eventId}`;
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  async function owner<T extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
    return (await db.owner.query<T>(sql, values)).rows;
  }

  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    });

  const asPlayer = (
    token: string,
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string> = {},
  ) => test.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers } });

  /** A player with a session, enrolled in the event, holding `points` paid through the ledger. */
  const newPlayer = async (points: number, event = eventId): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`buyer_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(token).digest()],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [orgId, event, player?.id],
    );
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      event,
    ]);
    const [quest] = await owner<{ id: string }>(
      "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Q', $3) RETURNING id",
      [event, general?.id, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [orgId, event, enrolled?.id, quest?.id, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                                 quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
      [orgId, event, enrolled?.id, points, done?.id, quest?.id],
    );
    return token;
  };

  const newReward = async (fields: object = {}): Promise<Reward> => {
    const made = await call(
      "POST",
      `${base}/rewards`,
      { kind: "item", name: { ar: "هودي", en: "Hoodie" }, price: 200, stock: 2, ...fields },
      key(),
    );
    expect(made.statusCode).toBe(201);
    return made.json<{ reward: Reward }>().reward;
  };

  describe("the dashboard", () => {
    it("creates, lists, edits and removes a reward, audited", async () => {
      const reward = await newReward({ opensAt: "2030-01-01T10:00", section: "merch" });
      expect(reward).toMatchObject({ stock: 2, unitsOut: 0, stockLeft: 2 });
      // The event's wall clock in Riyadh, stored as the instant.
      expect(reward.opensAt).toBe("2030-01-01T07:00:00.000Z");
      const listed = (await call("GET", `${base}/rewards`)).json<{
        shop: object;
        rewards: Reward[];
      }>();
      expect(listed.shop).toEqual({
        pickupMinutes: 120,
        daysAfter: 3,
        rules: { ar: null, en: null },
        spendLowersRank: false,
      });
      expect(listed.rewards.map((r) => r.id)).toContain(reward.id);
      const edited = await call("PATCH", `${base}/rewards/${reward.id}`, {
        stock: 5,
        opensAt: null,
      });
      expect(edited.json<{ reward: Reward }>().reward).toMatchObject({ stock: 5, opensAt: null });
      expect((await call("DELETE", `${base}/rewards/${reward.id}`)).statusCode).toBe(204);
      expect((await call("PATCH", `${base}/rewards/${reward.id}`, { stock: 1 })).statusCode).toBe(
        404,
      );
      const actions = await owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id",
        [reward.id],
      );
      expect(actions.map((a) => a.action)).toEqual([
        "reward.create",
        "reward.update",
        "reward.remove",
      ]);
    });

    it("refuses bad rewards with the field named", async () => {
      const blank = await call(
        "POST",
        `${base}/rewards`,
        { kind: "item", name: { en: " " }, price: 1, stock: 1 },
        key(),
      );
      expect(blank.json()).toMatchObject({ code: "invalid_reward", details: { field: "name" } });
      const backwards = await call(
        "POST",
        `${base}/rewards`,
        {
          kind: "item",
          name: { en: "X" },
          price: 1,
          stock: 1,
          opensAt: "2030-01-02T10:00",
          closesAt: "2030-01-01T10:00",
        },
        key(),
      );
      expect(backwards.json()).toMatchObject({ details: { field: "closesAt" } });
      const digital = await call(
        "POST",
        `${base}/rewards`,
        { kind: "digital_code", name: { en: "X" }, price: 1, stock: 1 },
        key(),
      );
      expect(digital.statusCode).toBe(400);
    });

    it("keeps the stock above the units reserved (409)", async () => {
      const reward = await newReward({ price: 10, stock: 2 });
      const token = await newPlayer(100);
      await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`, key());
      const lowered = await call("PATCH", `${base}/rewards/${reward.id}`, { stock: 0 });
      expect(lowered.statusCode).toBe(409);
      expect(lowered.json()).toMatchObject({
        code: "stock_below_reserved",
        details: { unitsOut: 1 },
      });
    });

    it("answers 404 for another event's reward and another organizer's event", async () => {
      const reward = await newReward();
      const [other] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, starts_at, ends_at)
         VALUES ($1, 'SHOP2', 'Other', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
        [orgId],
      );
      const elsewhere = `/v1/organizers/${orgId}/events/${other?.id}/rewards/${reward.id}`;
      expect((await call("PATCH", elsewhere, { stock: 9 })).statusCode).toBe(404);
      expect((await call("DELETE", elsewhere)).statusCode).toBe(404);
      const [stranger] = await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Tabuk', 'rewards-b') RETURNING id",
      );
      expect(
        (await call("GET", `/v1/organizers/${stranger?.id}/events/${eventId}/rewards`)).statusCode,
      ).toBe(404);
    });

    it("saves the shop settings and refuses them out of range", async () => {
      const saved = await call("PUT", `${base}/shop`, {
        pickupMinutes: 60,
        rules: { en: "One per person." },
      });
      expect(saved.json()).toEqual({
        shop: {
          pickupMinutes: 60,
          daysAfter: 3,
          rules: { ar: null, en: "One per person." },
          spendLowersRank: false,
        },
      });
      expect((await call("PUT", `${base}/shop`, { pickupMinutes: 5 })).statusCode).toBe(400);
      await call("PUT", `${base}/shop`, { pickupMinutes: 120, rules: { en: "" } });
    });

    it("answers every field of a reward, and its settings in the audit", async () => {
      const reward = await newReward({
        name: { ar: "قبعة", en: "Cap" },
        description: { en: "Blue" },
        price: 30,
        stock: 4,
        perPlayerLimit: 2,
        opensAt: "2030-01-01T10:00",
        closesAt: "2030-01-02T10:00",
        section: "food",
        tags: { new: true, limited: true },
      });
      expect(reward).toEqual({
        id: reward.id,
        kind: "item",
        name: { ar: "قبعة", en: "Cap" },
        description: { ar: null, en: "Blue" },
        price: 30,
        stock: 4,
        unitsOut: 0,
        stockLeft: 4,
        perPlayerLimit: 2,
        opensAt: "2030-01-01T07:00:00.000Z",
        closesAt: "2030-01-02T07:00:00.000Z",
        section: "food",
        tags: { new: true, limited: true },
        position: expect.any(Number),
        lowCodes: false,
      });
      const [logged] = await owner<{ after: Record<string, unknown> }>(
        "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'reward.create'",
        [reward.id],
      );
      expect(logged?.after).toMatchObject({
        opensAt: "2030-01-01T07:00:00.000Z",
        closesAt: "2030-01-02T07:00:00.000Z",
        perPlayerLimit: 2,
      });
    });

    it("edits each field the patch names, refuses bad values, and audits only a real change", async () => {
      const reward = await newReward();
      const edited = await call("PATCH", `${base}/rewards/${reward.id}`, {
        price: 7,
        perPlayerLimit: 3,
        tags: { new: true },
        closesAt: "2030-01-01T10:00",
      });
      expect(edited.json<{ reward: object }>().reward).toMatchObject({
        price: 7,
        perPlayerLimit: 3,
        tags: { new: true, limited: false },
        closesAt: "2030-01-01T07:00:00.000Z",
      });
      expect(
        (
          await call("PATCH", `${base}/rewards/${reward.id}`, { opensAt: "2030-01-01T11:00" })
        ).json(),
      ).toMatchObject({ code: "invalid_reward", details: { field: "closesAt" } });
      for (const bad of [
        { price: 0 },
        { price: 1_000_001 },
        { perPlayerLimit: 0 },
        { perPlayerLimit: 101 },
        { opensAt: "x2030-01-01T10:00" },
        { opensAt: "2030-01-01T10:00:00" },
        { name: { fr: "Chapeau" } },
        { name: { en: "x".repeat(121) } },
        { tags: { hot: true } },
      ]) {
        expect(
          (await call("PATCH", `${base}/rewards/${reward.id}`, bad)).statusCode,
          JSON.stringify(bad),
        ).toBe(400);
      }
      expect((await call("PATCH", `${base}/rewards/${reward.id}`, { price: 7 })).statusCode).toBe(
        200,
      );
      const updates = await owner(
        "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'reward.update'",
        [reward.id],
      );
      expect(updates).toHaveLength(1);
    });

    it("lets the stock fall to what is reserved and shows what is left", async () => {
      const reward = await newReward({ price: 10, stock: 3 });
      const token = await newPlayer(100);
      await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`, key());
      const lowered = await call("PATCH", `${base}/rewards/${reward.id}`, { stock: 1 });
      expect(lowered.json<{ reward: object }>().reward).toMatchObject({
        stock: 1,
        unitsOut: 1,
        stockLeft: 0,
      });
      await call("PATCH", `${base}/rewards/${reward.id}`, { stock: 4 });
      const listed = (await call("GET", `${base}/rewards`)).json<{ rewards: Reward[] }>();
      expect(listed.rewards.find((r) => r.id === reward.id)).toMatchObject({
        stock: 4,
        unitsOut: 1,
        stockLeft: 3,
      });
    });

    it("answers 404 for an event that is not the organizer's", async () => {
      const missing = `/v1/organizers/${orgId}/events/${randomUUID()}`;
      expect((await call("GET", `${missing}/rewards`)).statusCode).toBe(404);
      expect(
        (
          await call(
            "POST",
            `${missing}/rewards`,
            { kind: "item", name: { en: "X" }, price: 1, stock: 1 },
            key(),
          )
        ).statusCode,
      ).toBe(404);
      expect((await call("PUT", `${missing}/shop`, { daysAfter: 1 })).statusCode).toBe(404);
    });

    it("refuses changes once the event is archived, but not after it ended", async () => {
      const [archived] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SHOP3', 'Old', 'archived', now() - interval '9 days', now() - interval '8 days') RETURNING id`,
        [orgId],
      );
      const old = `/v1/organizers/${orgId}/events/${archived?.id}`;
      const refused = await call(
        "POST",
        `${old}/rewards`,
        { kind: "item", name: { en: "X" }, price: 1, stock: 1 },
        key(),
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "event_archived" });
      expect((await call("PUT", `${old}/shop`, { daysAfter: 1 })).json()).toMatchObject({
        code: "event_archived",
      });
      const [ended] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SHOP4', 'Done', 'ended', now() - interval '2 days', now() - interval '1 day') RETURNING id`,
        [orgId],
      );
      const made = await call(
        "POST",
        `/v1/organizers/${orgId}/events/${ended?.id}/rewards`,
        { kind: "experience", name: { en: "Tour" }, price: 1, stock: 1 },
        key(),
      );
      expect(made.statusCode).toBe(201);
    });

    it("adds up to 100 rewards to an event, at the end, and refuses the next", async () => {
      const [crowded] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SHOP5', 'Busy', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [orgId],
      );
      await owner(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total, position)
         SELECT $1, 'item', 'R' || n, 1, 1, n FROM generate_series(0, 97) AS n`,
        [crowded?.id],
      );
      await owner(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total, position, status)
         VALUES ($1, 'item', 'Gone', 1, 1, 500, 'removed')`,
        [crowded?.id],
      );
      const url = `/v1/organizers/${orgId}/events/${crowded?.id}/rewards`;
      const body = { kind: "item", name: { en: "Last" }, price: 1, stock: 1 };
      const last = await call("POST", url, body, key());
      expect(last.statusCode).toBe(201);
      expect(last.json<{ reward: { position: number } }>().reward.position).toBe(98);
      expect((await call("POST", url, body, key())).statusCode).toBe(201);
      const over = await call("POST", url, body, key());
      expect(over.statusCode).toBe(409);
      expect(over.json()).toMatchObject({ code: "limit_reached", details: { limit: 100 } });
    });

    it("stores the shop settings, keeps what is not sent, and audits only a change", async () => {
      const [quiet] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SHOP6', 'Quiet', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [orgId],
      );
      const url = `/v1/organizers/${orgId}/events/${quiet?.id}`;
      expect((await call("PUT", `${url}/shop`, { daysAfter: 30 })).statusCode).toBe(200);
      expect((await call("PUT", `${url}/shop`, { daysAfter: 31 })).statusCode).toBe(400);
      expect((await call("PUT", `${url}/shop`, { daysAfter: -1 })).statusCode).toBe(400);
      expect((await call("PUT", `${url}/shop`, {})).statusCode).toBe(200);
      expect((await call("PUT", `${url}/shop`, { rules: { ar: "واحدة" } })).statusCode).toBe(200);
      expect((await call("GET", `${url}/rewards`)).json()).toMatchObject({
        shop: { pickupMinutes: 120, daysAfter: 30, rules: { ar: "واحدة", en: null } },
      });
      const audited = await owner(
        "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'event.shop.update'",
        [quiet?.id],
      );
      expect(audited).toHaveLength(2);
    });
  });

  describe("the player's shop", () => {
    it("reserves, shows it and cancels it, with the balance moving each time", async () => {
      const reward = await newReward({ price: 200, stock: 1 });
      const token = await newPlayer(300);
      const shop = await asPlayer(token, "GET", `/v1/events/${eventId}/shop`);
      expect(shop.statusCode).toBe(200);
      expect(shop.json()).toMatchObject({
        balance: 300,
        shop: { state: "open", firstRedemption: true },
      });
      const reserved = await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`, key());
      expect(reserved.statusCode).toBe(201);
      const body = reserved.json<{
        redemption: { id: string };
        balance: number;
        stockLeft: number;
      }>();
      expect(body).toMatchObject({ balance: 100, stockLeft: 0, replayed: false });
      const after = (await asPlayer(token, "GET", `/v1/events/${eventId}/shop`)).json<{
        shop: { firstRedemption: boolean };
        redemptions: { id: string; status: string }[];
      }>();
      expect(after.shop.firstRedemption).toBe(false);
      expect(after.redemptions[0]).toMatchObject({ id: body.redemption.id, status: "reserved" });
      const other = await newPlayer(500);
      const sold = await asPlayer(other, "POST", `/v1/rewards/${reward.id}/reserve`, key());
      expect(sold.json()).toMatchObject({ code: "sold_out" });
      expect(
        (await asPlayer(other, "POST", `/v1/redemptions/${body.redemption.id}/cancel`)).statusCode,
      ).toBe(404);
      const cancelled = await asPlayer(
        token,
        "POST",
        `/v1/redemptions/${body.redemption.id}/cancel`,
      );
      expect(cancelled.json()).toMatchObject({
        balance: 300,
        stockLeft: 1,
        redemption: { status: "cancelled" },
      });
    });

    it("answers each refusal with its code", async () => {
      const token = await newPlayer(50);
      const dear = await newReward({ price: 100 });
      expect(
        (await asPlayer(token, "POST", `/v1/rewards/${dear.id}/reserve`, key())).json(),
      ).toMatchObject({ code: "not_enough_balance" });
      const later = await newReward({ price: 1, opensAt: "2099-01-01T10:00" });
      expect(
        (await asPlayer(token, "POST", `/v1/rewards/${later.id}/reserve`, key())).json(),
      ).toMatchObject({ code: "reward_not_open", details: { reason: "not_started" } });
      const once = await newReward({ price: 1, perPlayerLimit: 1 });
      await asPlayer(token, "POST", `/v1/rewards/${once.id}/reserve`, key());
      expect(
        (await asPlayer(token, "POST", `/v1/rewards/${once.id}/reserve`, key())).json(),
      ).toMatchObject({ code: "reward_limit_reached", details: { limit: 1 } });
      expect(
        (await asPlayer(token, "POST", `/v1/rewards/${randomUUID()}/reserve`, key())).statusCode,
      ).toBe(404);
    });

    it("needs a session, membership and an Idempotency-Key", async () => {
      const reward = await newReward({ price: 1 });
      expect(
        (await test.app.inject({ method: "GET", url: `/v1/events/${eventId}/shop` })).statusCode,
      ).toBe(401);
      const token = await newPlayer(10);
      expect((await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`)).statusCode).toBe(
        400,
      );
      expect((await asPlayer(token, "GET", `/v1/events/${randomUUID()}/shop`)).statusCode).toBe(
        404,
      );
    });

    it("answers the shop uncached, with every field of a reward", async () => {
      const reward = await newReward({ price: 5, stock: 3, section: "merch", tags: { new: true } });
      const token = await newPlayer(20);
      const shop = await asPlayer(token, "GET", `/v1/events/${eventId}/shop`);
      expect(shop.headers["cache-control"]).toBe("no-store");
      const body = shop.json<{ rewards: { id: string }[] }>();
      expect(body.rewards.find((r) => r.id === reward.id)).toEqual({
        id: reward.id,
        kind: "item",
        name: { ar: "هودي", en: "Hoodie" },
        description: { ar: null, en: null },
        price: 5,
        stockLeft: 3,
        perPlayerLimit: null,
        heldByMe: 0,
        opensAt: null,
        closesAt: null,
        section: "merch",
        tags: { new: true, limited: false, popular: false },
      });
    });

    it("replays a retry with the first answer, and refuses a pending member's refusal", async () => {
      const reward = await newReward({ price: 5, stock: 3 });
      const token = await newPlayer(20);
      const same = key();
      const first = await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`, same);
      const again = await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`, same);
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(201);
      expect(again.json<{ redemption: object }>().redemption).toEqual(
        first.json<{ redemption: object }>().redemption,
      );
      const pending = await newPlayer(20);
      await owner(
        "UPDATE enrollment SET status = 'pending' WHERE player_id = (SELECT id FROM player WHERE username = $1)",
        [`buyer_${counter}`],
      );
      const refused = await asPlayer(pending, "POST", `/v1/rewards/${reward.id}/reserve`, key());
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({
        code: "enrollment_inactive",
        details: { reason: "pending" },
      });
    });

    it("refuses a reservation once the shop has closed, and a cancel once it expired", async () => {
      const [over] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, 'SHOP7', 'Over', 'ended', now() - interval '9 days', now() - interval '8 days') RETURNING id`,
        [orgId],
      );
      const late = await newPlayer(50, over?.id);
      const [gone] = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', 'Late', 1, 1) RETURNING id",
        [over?.id],
      );
      const closed = await asPlayer(late, "POST", `/v1/rewards/${gone?.id}/reserve`, key());
      expect(closed.statusCode).toBe(403);
      expect(closed.json()).toMatchObject({ code: "shop_closed", details: { reason: "closed" } });

      const reward = await newReward({ price: 5, stock: 1 });
      const token = await newPlayer(20);
      const reserved = (
        await asPlayer(token, "POST", `/v1/rewards/${reward.id}/reserve`, key())
      ).json<{ redemption: { id: string } }>();
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 minute' WHERE id = $1",
        [reserved.redemption.id],
      );
      await owner("SELECT expire_one_reservation()");
      const ended = await asPlayer(
        token,
        "POST",
        `/v1/redemptions/${reserved.redemption.id}/cancel`,
      );
      expect(ended.statusCode).toBe(409);
      expect(ended.json()).toMatchObject({
        code: "reservation_ended",
        details: { status: "expired" },
      });
    });
  });
});
