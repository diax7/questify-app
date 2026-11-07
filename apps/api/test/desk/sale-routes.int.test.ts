import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_TERMS } from "@questify/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import type { DeskDeps } from "#src/desk/desk";
import { acceptSale, declineSale, offerSale, saleRewards, saleState } from "#src/desk/sale";
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

/** An HTTP answer as its status and error code. */
const answer = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

const refused = (reason: string) => ({ result: "refused", reason });

const callerWith = (log: Caller["log"]): Caller => ({
  address: "203.0.113.7",
  userAgent: null,
  log,
});

/** The test config's QR secret (test/support/auth-app.ts), so a test can show a real My QR. */
const MY_KEY = createMyCodeKey("q".repeat(40));

/**
 * The desk sale over HTTP (T-612): the dashboard's reservation switch, the shop's and the desk's headers, the desk's
 * list, offer, poll and Withdraw, the player's Pay and Not now with the reserve route's errors, and My QR's offers.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("desk sale over HTTP", () => {
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
          "INSERT INTO organizer (name, slug) VALUES ('sale-org', 'sale-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@sale.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@sale.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  /** The database's own clock in whole milliseconds: an offer's deadline is made from it, not from this process's. */
  const databaseMillis = async () =>
    Number(
      (
        await owner<{ ms: string }>(
          "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms",
        )
      )[0]?.ms,
    );

  const newEvent = async (mode = "collect_first"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, timezone,
                          desk_location_en, handover_confirm, reservation_on)
       VALUES ($1, $2, 'Desk Fest', 'live', now() - interval '1 hour', now() + interval '1 day', 'Asia/Riyadh',
               'Hall B', $3, false)
       RETURNING id`,
      [organizer, `SALEH${counter}`, mode],
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
      [`sale_${counter}`],
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

  const sell = async () => {
    const event = await newEvent();
    const desk = await newOperator(event);
    const buyer = await newPlayer(event);
    const reward = await newReward(event);
    return { event, desk, buyer, reward };
  };
  type Sell = Awaited<ReturnType<typeof sell>>;
  const offer = (
    s: Sell,
    key = randomUUID(),
    code = s.buyer.code,
    rewardId = s.reward,
    token = s.desk.token,
  ) => app("POST", "/v1/operator/desk/sales", token, { eventId: s.event, code, rewardId }, key);
  const saleOf = async (s: Sell) => (await offer(s)).json<{ sale: { id: string } }>().sale.id;
  const pay = (s: Sell, sale: string) =>
    app("POST", `/v1/desk-sales/${sale}/accept`, s.buyer.token);
  const poll = (s: Sell, sale: string) =>
    app("GET", `/v1/operator/desk/sales/${sale}`, s.desk.token, undefined, null);
  const list = async (s: Sell, token: string, code: string) =>
    (await app("POST", "/v1/operator/desk/sale-rewards", token, { eventId: s.event, code })).json();
  const redemptionsOf = (player: string) =>
    owner<{ id: string }>(
      `SELECT d.id FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
       WHERE n.player_id = $1`,
      [player],
    );
  const mine = async (s: Sell) =>
    (await app("GET", "/v1/me/desk-items", s.buyer.token, undefined, null)).json<{
      sales: Record<string, unknown>[];
    }>().sales;
  const deskDeps = () => ({ pool: test.pool, myKey: MY_KEY }) as DeskDeps;

  describe("the dashboard's switch (FR-1834)", () => {
    it("turns reservation On, audits it, and refuses Off without the desk's place", async () => {
      const event = await newEvent();
      const on = await dashboard("PUT", `/events/${event}/shop`, { reservation: true });
      expect(on.statusCode).toBe(200);
      expect(on.json()).toMatchObject({ shop: { reservation: true } });
      const audit = await owner<{ after: Row }>(
        "SELECT after FROM audit_log WHERE event_id = $1 AND action = 'event.shop.update'",
        [event],
      );
      expect(audit.at(-1)?.after).toMatchObject({ reservation: true });
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]);
      const off = await dashboard("PUT", `/events/${event}/shop`, { reservation: false });
      expect(answer(off)).toEqual([409, "desk_needed"]);
    });

    it("tells the player's shop and the desk's header the mode", async () => {
      const s = await sell();
      const shop = await app("GET", `/v1/events/${s.event}/shop`, s.buyer.token, undefined, null);
      expect(shop.json()).toMatchObject({ shop: { reservation: false } });
      const header = await app(
        "GET",
        `/v1/operator/events/${s.event}/desk`,
        s.desk.token,
        undefined,
        null,
      );
      expect(header.json()).toMatchObject({ desk: { reservation: false, shopOn: true } });
    });

    it("refuses an in-app reserve of a desk reward with reservation_off, and a desk: key", async () => {
      const s = await sell();
      const reserved = await app("POST", `/v1/rewards/${s.reward}/reserve`, s.buyer.token);
      expect(answer(reserved)).toEqual([403, "reservation_off"]);
      const desky = await app(
        "POST",
        `/v1/rewards/${s.reward}/reserve`,
        s.buyer.token,
        undefined,
        "desk:x",
      );
      expect(desky.statusCode).toBe(400);
    });
  });

  describe("the sale", () => {
    it("lists, offers, shows the offer on My QR, and Pay hands it over", async () => {
      const s = await sell();
      const listed = await app("POST", "/v1/operator/desk/sale-rewards", s.desk.token, {
        eventId: s.event,
        code: s.buyer.code,
      });
      expect(listed.json()).toMatchObject({
        result: "found",
        rewards: [{ id: s.reward, can: "ok", price: 100 }],
      });
      const key = randomUUID();
      const made = await offer(s, key);
      expect(made.statusCode).toBe(201);
      const sale = made.json<{ sale: { id: string } }>().sale.id;
      expect((await offer(s, key)).json()).toMatchObject({ sale: { id: sale } });
      const qr = await app("GET", "/v1/me/desk-items", s.buyer.token, undefined, null);
      expect(qr.json()).toMatchObject({
        watch: true,
        sales: [
          { id: sale, price: 100, balanceAfter: 900, desk: { en: "Hall B" }, justBought: false },
        ],
      });
      const paid = await pay(s, sale);
      expect(paid.statusCode).toBe(200);
      expect(paid.json()).toMatchObject({ status: "accepted", balance: 900, replayed: false });
      const polled = await poll(s, sale);
      expect(polled.headers["cache-control"]).toBe("no-store");
      expect(polled.json()).toEqual({
        status: "accepted",
        price: 100,
        offerUntil: expect.any(String),
        reason: null,
      });
    });

    it("answers a bad or earlier code as a result; a busy desk, a digital reward and reservation On as errors", async () => {
      const s = await sell();
      expect((await offer(s, randomUUID(), "nope")).json()).toEqual({
        result: "refused",
        reason: "invalid_code",
      });
      expect((await offer(s, randomUUID(), myCode(MY_KEY, s.buyer.id, 2))).json()).toEqual({
        result: "refused",
        reason: "old_code",
      });
      await offer(s);
      const other = await newOperator(s.event);
      expect(answer(await offer(s, randomUUID(), s.buyer.code, s.reward, other.token))).toEqual([
        409,
        "desk_busy",
      ]);
      const digital = await newReward(s.event, "digital");
      expect(answer(await offer(s, randomUUID(), s.buyer.code, digital))).toEqual([
        422,
        "not_desk_reward",
      ]);
      await owner("UPDATE event SET reservation_on = true WHERE id = $1", [s.event]);
      expect(answer(await offer(s))).toEqual([409, "reservation_on"]);
    });

    it("a refused Pay answers the reserve route's error, the desk sees why, and a repeat answers the same", async () => {
      const s = await sell();
      const sale = await saleOf(s);
      await owner("UPDATE reward SET units_out = stock_total WHERE id = $1", [s.reward]);
      expect(answer(await pay(s, sale))).toEqual([409, "sold_out"]);
      expect(answer(await pay(s, sale))).toEqual([409, "sold_out"]);
      expect((await poll(s, sale)).json()).toMatchObject({ status: "refused", reason: "sold_out" });
    });

    it("a hold reads as the offer gone to the player, and held to the desk", async () => {
      const s = await sell();
      const sale = await saleOf(s);
      await owner("UPDATE enrollment SET status = 'banned' WHERE player_id = $1", [s.buyer.id]);
      expect(answer(await pay(s, sale))).toEqual([410, "sale_gone"]);
      expect((await poll(s, sale)).json()).toMatchObject({ status: "refused", reason: "held" });
    });

    it("Not now and Withdraw end the offer; a later Pay is sale_gone; strangers get 404 or 403", async () => {
      const s = await sell();
      const first = await saleOf(s);
      const stranger = await newPlayer(s.event);
      const decline = (token: string) => app("POST", `/v1/desk-sales/${first}/decline`, token);
      expect((await decline(stranger.token)).statusCode).toBe(404);
      expect((await decline(s.buyer.token)).statusCode).toBe(204);
      expect(answer(await pay(s, first))).toEqual([410, "sale_gone"]);
      const second = await saleOf(s);
      const withdraw = (token: string) =>
        app("POST", `/v1/operator/desk/sales/${second}/withdraw`, token);
      expect((await withdraw(stranger.token)).statusCode).toBe(403);
      expect((await withdraw(s.desk.token)).json()).toEqual({ withdrawn: true });
      expect((await withdraw(s.desk.token)).json()).toEqual({ withdrawn: false });
    });
  });

  describe("the desk's list", () => {
    it("lists each reward's words, price and stock, and no balance", async () => {
      const s = await sell();
      await owner("UPDATE reward SET name_ar = 'hoodie-ar' WHERE id = $1", [s.reward]);
      expect(await list(s, s.desk.token, s.buyer.code)).toEqual({
        result: "found",
        rewards: [
          {
            id: s.reward,
            kind: "item",
            name: { ar: "hoodie-ar", en: "Hoodie" },
            price: 100,
            stockLeft: 5,
            can: "ok",
          },
        ],
      });
    });

    it("answers a scan that cannot be served as a result, whatever the reason", async () => {
      const s = await sell();
      const outsider = await newPlayer();
      const withoutHandOver = await newOperator(s.event, []);
      expect(await list(s, s.desk.token, "nope")).toEqual(refused("invalid_code"));
      expect(await list(s, s.desk.token, myCode(MY_KEY, s.buyer.id, 2))).toEqual(
        refused("old_code"),
      );
      expect(await list(s, s.desk.token, myCode(MY_KEY, randomUUID(), 1))).toEqual(
        refused("not_in_event"),
      );
      expect(await list(s, s.desk.token, outsider.code)).toEqual(refused("not_in_event"));
      expect(await list(s, s.desk.token, s.desk.code)).toEqual(refused("self_scan"));
      expect(await list(s, withoutHandOver.token, s.buyer.code)).toEqual(refused("ability_off"));
    });
  });

  describe("the offer", () => {
    it("answers the new sale in full, a live repeat as 200, and a re-offer after Pay as just bought", async () => {
      const s = await sell();
      const before = await databaseMillis();
      const made = await offer(s);
      const after = await databaseMillis();
      expect(made.statusCode).toBe(201);
      const { sale } = made.json<{ sale: { id: string; offerUntil: string } }>();
      expect(made.json()).toEqual({
        result: "offered",
        sale: {
          id: sale.id,
          status: "offered",
          price: 100,
          offerUntil: expect.any(String),
          replayed: false,
          justBought: false,
        },
      });
      // offerUntil is the offering transaction's now() plus 2 minutes, so it lies between two reads of the database's
      // clock around the request (1 ms either way for the answer's millisecond precision).
      const offeredAt = Date.parse(sale.offerUntil) - 120_000;
      expect(offeredAt).toBeGreaterThanOrEqual(before - 1);
      expect(offeredAt).toBeLessThanOrEqual(after + 1);
      const repeat = await offer(s);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toMatchObject({ sale: { id: sale.id, replayed: true } });
      expect((await pay(s, sale.id)).statusCode).toBe(200);
      const again = await offer(s);
      expect(again.statusCode).toBe(201);
      expect(again.json()).toMatchObject({ sale: { replayed: false, justBought: true } });
    });

    it("tells the desk a hold as held or paused, where the player is told nothing", async () => {
      const s = await sell();
      await owner("UPDATE enrollment SET status = 'banned' WHERE player_id = $1", [s.buyer.id]);
      expect(answer(await offer(s))).toEqual([409, "held"]);
      await owner(
        "UPDATE enrollment SET status = 'active', redeem_paused_at = now() WHERE player_id = $1",
        [s.buyer.id],
      );
      expect(answer(await offer(s))).toEqual([409, "paused"]);
    });

    it("stops an operator whose hand_over went off from polling or withdrawing", async () => {
      const s = await sell();
      const sale = await saleOf(s);
      await owner("UPDATE staff_assignment SET abilities = '{}' WHERE player_id = $1", [s.desk.id]);
      expect(answer(await poll(s, sale))).toEqual([403, "ability_off"]);
      const withdraw = await app("POST", `/v1/operator/desk/sales/${sale}/withdraw`, s.desk.token);
      expect(answer(withdraw)).toEqual([403, "ability_off"]);
    });
  });

  describe("Pay", () => {
    it("answers the redemption and balance, and a repeat Pay the same with replayed", async () => {
      const s = await sell();
      const sale = await saleOf(s);
      const paid = await pay(s, sale);
      const [redemption] = await redemptionsOf(s.buyer.id);
      expect(paid.json()).toEqual({
        status: "accepted",
        redemptionId: redemption?.id,
        balance: 900,
        replayed: false,
      });
      const again = await pay(s, sale);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({
        status: "accepted",
        redemptionId: redemption?.id,
        balance: 900,
        replayed: true,
      });
      expect(await redemptionsOf(s.buyer.id)).toHaveLength(1);
    });

    it("is sale_gone when the operator lost hand_over after the offer, and takes nothing", async () => {
      const s = await sell();
      const sale = await saleOf(s);
      const other = await newOperator(s.event);
      await owner("UPDATE staff_assignment SET abilities = '{}' WHERE player_id = $1", [s.desk.id]);
      expect(answer(await pay(s, sale))).toEqual([410, "sale_gone"]);
      const seen = await app(
        "GET",
        `/v1/operator/desk/sales/${sale}`,
        other.token,
        undefined,
        null,
      );
      expect(seen.json()).toMatchObject({ status: "withdrawn", reason: null });
      expect(await redemptionsOf(s.buyer.id)).toHaveLength(0);
    });
  });

  describe("My QR's offer", () => {
    it("keeps an Arabic-only desk place and rules, and the event's and reward's words", async () => {
      const s = await sell();
      await owner(
        `UPDATE event SET name_ar = 'event-ar', desk_location_en = NULL, desk_location_ar = 'desk-ar',
                          shop_rules_ar = 'rules-ar' WHERE id = $1`,
        [s.event],
      );
      await owner("UPDATE reward SET name_ar = 'hoodie-ar' WHERE id = $1", [s.reward]);
      const sale = await saleOf(s);
      expect(await mine(s)).toEqual([
        {
          id: sale,
          eventId: s.event,
          event: { ar: "event-ar", en: "Desk Fest" },
          kind: "item",
          name: { ar: "hoodie-ar", en: "Hoodie" },
          price: 100,
          offerUntil: expect.any(String),
          balanceAfter: 900,
          desk: { ar: "desk-ar", en: null },
          rules: { ar: "rules-ar", en: null },
          justBought: false,
          currency: DEFAULT_TERMS.currency,
        },
      ]);
    });

    it("shows no desk place and no rules when the event has none", async () => {
      const event = await newEvent();
      await owner("UPDATE event SET desk_location_en = NULL WHERE id = $1", [event]);
      const s: Sell = {
        event,
        desk: await newOperator(event),
        buyer: await newPlayer(event),
        reward: await newReward(event, "experience"),
      };
      await saleOf(s);
      expect(await mine(s)).toMatchObject([{ kind: "experience", desk: null, rules: null }]);
    });
  });

  describe("the sale's functions, called directly", () => {
    it("answers a scan that cannot be served as a refused result, and logs a bad code", async () => {
      const s = await sell();
      const base = { operatorId: s.desk.id, eventId: s.event };
      expect(await saleRewards(deskDeps(), { ...base, code: "nope" })).toEqual({
        kind: "refused",
        reason: "invalid_code",
      });
      const old = myCode(MY_KEY, s.buyer.id, 2);
      expect(await saleRewards(deskDeps(), { ...base, code: old })).toEqual({
        kind: "refused",
        reason: "old_code",
      });
      const log = vi.fn();
      const request = { ...base, code: "nope", rewardId: s.reward, idempotencyKey: randomUUID() };
      expect(await offerSale(deskDeps(), request, callerWith(log))).toEqual({
        kind: "refused",
        reason: "invalid_code",
      });
      expect(log.mock.calls).toEqual([
        ["desk.sale_refused", { reason: "invalid_code", problem: "not_questify" }],
      ]);
    });

    it("logs an offer, its repeat and a Pay with ids and flags only", async () => {
      const s = await sell();
      const log = vi.fn();
      const caller = callerWith(log);
      const request = {
        operatorId: s.desk.id,
        eventId: s.event,
        code: s.buyer.code,
        rewardId: s.reward,
        idempotencyKey: randomUUID(),
      };
      const made = await offerSale(deskDeps(), request, caller);
      const again = await offerSale(deskDeps(), request, caller);
      const sale = made.kind === "done" ? made.value.id : "";
      expect(made).toMatchObject({ kind: "done", value: { replayed: false } });
      expect(again).toMatchObject({ kind: "done", value: { id: sale, replayed: true } });
      const pays = { playerId: s.buyer.id, saleId: sale };
      expect(await acceptSale(deskDeps(), pays, caller)).toMatchObject({ replayed: false });
      expect(await acceptSale(deskDeps(), pays, caller)).toMatchObject({ replayed: true });
      expect(log.mock.calls).toEqual([
        ["desk.sale_offered", { saleId: sale, replayed: "false" }],
        ["desk.sale_offered", { saleId: sale, replayed: "true" }],
        ["desk.sale_paid", { saleId: sale, status: "accepted", replayed: "false" }],
        ["desk.sale_paid", { saleId: sale, status: "accepted", replayed: "true" }],
      ]);
    });

    it("logs no offer for a repeat that answers expired", async () => {
      const s = await sell();
      const log = vi.fn();
      const request = {
        operatorId: s.desk.id,
        eventId: s.event,
        code: s.buyer.code,
        rewardId: s.reward,
        idempotencyKey: randomUUID(),
      };
      const made = await offerSale(deskDeps(), request, callerWith(log));
      const sale = made.kind === "done" ? made.value.id : "";
      await db.owner.query(
        "UPDATE desk_sale SET offer_until = now() - interval '1 second' WHERE id = $1",
        [sale],
      );
      expect(await offerSale(deskDeps(), request, callerWith(log))).toMatchObject({
        kind: "done",
        value: { id: sale, status: "expired", replayed: true },
      });
      expect(log.mock.calls).toEqual([["desk.sale_offered", { saleId: sale, replayed: "false" }]]);
    });

    it("answers Not now true once and false when the offer had already ended", async () => {
      const s = await sell();
      const request = { playerId: s.buyer.id, saleId: await saleOf(s) };
      expect(await declineSale(deskDeps(), request)).toBe(true);
      expect(await declineSale(deskDeps(), request)).toBe(false);
    });

    it("throws a database error it does not map as it came, and maps a refusal without a detail", async () => {
      const request = { operatorId: randomUUID(), saleId: "not-a-uuid" };
      await expect(saleState(deskDeps(), request)).rejects.toMatchObject({ code: "22P02" });
      const pool = {
        connect: () => Promise.reject(Object.assign(new Error("refused"), { code: "RA403" })),
      } as unknown as Pool;
      await expect(
        saleState({ ...deskDeps(), pool }, { ...request, saleId: randomUUID() }),
      ).rejects.toMatchObject({
        status: 403,
        envelope: { code: "enrollment_inactive", details: { reason: "" } },
      });
    });
  });
});
