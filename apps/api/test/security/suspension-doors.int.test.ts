import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DERIVED_PARAMS, OPEN_WHILE_SUSPENDED } from "#src/players/guard";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Method = "GET" | "PUT" | "DELETE" | "POST" | "PATCH";
type Answer = { statusCode: number; json: () => unknown };

/**
 * The route params of a player route without `:eventId` that name no object of one event, by why: such a route is not
 * walled by an event (it has no event to wall), so a new param must be added here with its reason, or to
 * `DERIVED_PARAMS` (src/players/guard.ts).
 */
const OPEN_PARAMS: Readonly<Record<string, string>> = {
  id: "the player's own signed-in device (POST /v1/me/devices/:id/end), a safety action of the account",
  username: "a player's public profile or block: no event",
  code: "a rehearsal code: the team's wiped sandbox, never a suspended event's play",
  document: "the terms and privacy policy: no event",
  scene: "a paired screen's scene: device access, not a player route",
};

const REASON = "Reported fraud at the prize desk";
const unavailable = (answer: Answer) =>
  answer.statusCode === 404 && (answer.json() as { code?: string }).code === "event_unavailable";
/** Counts the `play_event_id` lookups the app's pool is asked for until restored. */
const lookups = (pool: Pool) => {
  const spy = vi.spyOn(pool, "query");
  return {
    count: () => spy.mock.calls.filter((args) => String(args[0]).includes("play_event_id")).length,
    restore: () => spy.mockRestore(),
  };
};
const paramsOf = (url: string) => [...url.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] ?? "");

/**
 * The suspension wall by object (plan 2026-11-11-audit-hardening-core, FR-1607): a player route that names a quest,
 * step, category, reward, session, desk sale, game round, meet pass or redemption of a suspended event answers 404
 * `event_unavailable`, as an `:eventId` route does; the doors that give points back stay open (OPEN_WHILE_SUSPENDED).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the suspension wall by object (HTTP)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let tokenA = "";
  let tokenB = "";
  let orgA = "";
  let eventA = "";
  let eventB = "";
  const ids: Record<string, string> = {};
  let questB = "";

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const one = async (sql: string, values: unknown[] = []): Promise<string> =>
    (await owner<{ id: string }>(sql, values))[0]?.id ?? "";
  const bearer = async (player: string): Promise<string> => {
    const value = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player, createHash("sha256").update(value).digest()],
    );
    return value;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const seed = await seedTwoTenants(db.owner);
    ({ orgA, eventA, eventB } = seed);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    adminCookie = await signInFully(test, "admin@questify.test");
    tokenA = await bearer(seed.playerA);
    tokenB = await bearer(seed.playerB);
    ids["categoryId"] = await one(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [eventA],
    );
    ids["questId"] = await one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Booth', 10, '{"code": "ABC123"}') RETURNING id`,
      [eventA, ids["categoryId"]],
    );
    const categoryB = await one(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [eventB],
    );
    questB = await one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Booth', 10, '{"code": "ABC123"}') RETURNING id`,
      [eventB, categoryB],
    );
    ids["rewardId"] = await one(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 40, 8) RETURNING id",
      [eventA],
    );
    ids["stepId"] = await one(
      `WITH q AS (
         INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'passport', 'Trail', 10, '{"needed": 1}') RETURNING id
       )
       INSERT INTO passport_step (event_id, quest_id, name_en, position)
       SELECT $1, q.id, 'Stop', 0 FROM q RETURNING id`,
      [eventA, ids["categoryId"]],
    );
    ids["sessionId"] = await one(
      `INSERT INTO event_session (organizer_id, event_id, kind, title_en, starts_at, ends_at, access, created_by)
       SELECT organizer_id, id, 'talk', 'Keynote', now(), now() + interval '1 hour', 'open', $2
       FROM event WHERE id = $1 RETURNING id`,
      [eventA, randomUUID()],
    );
    const enrollment = await one(
      "SELECT id FROM enrollment WHERE event_id = $1 AND player_id = $2",
      [eventA, seed.playerA],
    );
    ids["roundId"] = await one(
      `INSERT INTO game_round (organizer_id, event_id, enrollment_id, quest_id, game, level, seed, params, points,
                               issue_key, engine_version, deadline_at)
       SELECT organizer_id, id, $2, $3, 'memory_match', 'easy', 1, '{}', 0, 'round-1', 1, now() + interval '1 minute'
       FROM event WHERE id = $1 RETURNING id::text AS id`,
      [eventA, enrollment, ids["questId"]],
    );
    ids["saleId"] = await one(
      `INSERT INTO desk_sale (organizer_id, event_id, enrollment_id, reward_id, operator_id, price, idempotency_key,
                              offer_until)
       SELECT organizer_id, id, $2, $3, $4, 40, 'sale-1', now() + interval '1 hour'
       FROM event WHERE id = $1 RETURNING id`,
      [eventA, enrollment, ids["rewardId"], seed.playerB],
    );
    ids["passId"] = await one(
      `INSERT INTO meet_pass (organizer_id, event_id, quest_id, enrollment_id, token_hash, expires_at)
       SELECT organizer_id, id, $2, $3, $4, now() + interval '1 minute'
       FROM event WHERE id = $1 RETURNING id::text AS id`,
      [eventA, ids["questId"], enrollment, randomBytes(32)],
    );
    ids["redemptionId"] = await one(
      `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until)
       SELECT organizer_id, id, $2, $3, 40, 'reserve-1', now() + interval '1 hour'
       FROM event WHERE id = $1 RETURNING id`,
      [eventA, enrollment, ids["rewardId"]],
    );
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, headers: Record<string, string>, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { "idempotency-key": randomUUID(), ...headers },
      ...(method === "GET" || method === "DELETE" ? {} : { payload: payload ?? {} }),
    });
  const player = (method: Method, url: string, token = tokenA) =>
    call(method, url, { authorization: `Bearer ${token}` });
  const admin = (url: string, payload?: object) =>
    call("POST", url, withSession(adminCookie), payload);
  const suspend = async (path: string) =>
    expect((await admin(`${path}/suspend`, { reason: REASON })).statusCode).toBe(200);
  const reactivate = async (path: string) =>
    expect((await admin(`${path}/reactivate`)).statusCode).toBe(204);
  const eventPath = () => `/v1/admin/events/${eventA}`;

  /** One door per derived kind, each naming an object of event A. */
  const DOORS = (): ReadonlyArray<readonly [Method, string]> => [
    ["PUT", `/v1/quests/${ids["questId"]}/rating`],
    ["GET", `/v1/quests/${ids["questId"]}/survey`],
    ["POST", `/v1/steps/${ids["stepId"]}/stamp`],
    ["POST", `/v1/rewards/${ids["rewardId"]}/reserve`],
    ["POST", `/v1/game-rounds/${ids["roundId"]}/result`],
    ["POST", `/v1/categories/${ids["categoryId"]}/reveal`],
    ["POST", `/v1/operator/sessions/${ids["sessionId"]}/check-in`],
    ["POST", `/v1/desk-sales/${ids["saleId"]}/accept`],
    ["GET", `/v1/meet-passes/${ids["passId"]}`],
    ["POST", `/v1/redemptions/${ids["redemptionId"]}/collect`],
  ];
  const OPEN = (): ReadonlyArray<readonly [Method, string]> => [
    ["POST", `/v1/redemptions/${ids["redemptionId"]}/cancel`],
    ["POST", `/v1/desk-sales/${ids["saleId"]}/decline`],
  ];

  it("walls each object of a suspended event, leaves another event and the give-back doors open, and lifts", async () => {
    await suspend(eventPath());
    try {
      for (const [method, url] of DOORS()) {
        expect(unavailable(await player(method, url)), `${method} ${url}`).toBe(true);
      }
      expect(unavailable(await player("PUT", `/v1/quests/${questB}/rating`, tokenB))).toBe(false);
      // An event id in capitals names the same event.
      expect(unavailable(await player("GET", `/v1/events/${eventA.toUpperCase()}/home`))).toBe(
        true,
      );
      for (const [method, url] of OPEN()) {
        expect(unavailable(await player(method, url)), `${method} ${url}`).toBe(false);
      }
      // An id that names nothing is the route's own answer, never the wall's.
      expect(unavailable(await player("PUT", `/v1/quests/${randomUUID()}/rating`))).toBe(false);
      expect(unavailable(await player("POST", `/v1/game-rounds/999999999/result`))).toBe(false);
    } finally {
      await reactivate(eventPath());
    }
    for (const [method, url] of DOORS()) {
      expect(unavailable(await player(method, url)), `${method} ${url} lifted`).toBe(false);
    }
  });

  it("walls an object of a suspended organizer's event the same way", async () => {
    const path = `/v1/admin/organizers/${orgA}`;
    await suspend(path);
    try {
      expect(unavailable(await player("POST", `/v1/game-rounds/${ids["roundId"]}/result`))).toBe(
        true,
      );
      expect(unavailable(await player("PUT", `/v1/quests/${ids["questId"]}/rating`))).toBe(true);
      expect(unavailable(await player("PUT", `/v1/quests/${questB}/rating`, tokenB))).toBe(false);
    } finally {
      await reactivate(path);
    }
    expect(unavailable(await player("POST", `/v1/game-rounds/${ids["roundId"]}/result`))).toBe(
      false,
    );
  });

  it("finds every player route's object param walled or open with a reason, and walls every walled route", async () => {
    const routes = test.app.routeInventory
      .filter((route) => route.access === "player" && route.method !== "HEAD")
      .map((route) => ({ method: route.method as Method, url: route.url }))
      .filter((route) => !paramsOf(route.url).includes("eventId"));
    expect(routes.length).toBeGreaterThan(30);
    const unknown = routes.flatMap((route) =>
      paramsOf(route.url)
        .filter((name) => !(name in DERIVED_PARAMS) && !(name in OPEN_PARAMS))
        .map((name) => `${route.method} ${route.url} :${name}`),
    );
    expect(unknown).toEqual([]);
    const derived = routes.filter((route) =>
      paramsOf(route.url).some((name) => name in DERIVED_PARAMS),
    );
    const names = new Set(derived.map((route) => `${route.method} ${route.url}`));
    expect([...OPEN_WHILE_SUSPENDED].filter((route) => !names.has(route))).toEqual([]);
    await suspend(eventPath());
    try {
      const wrong: string[] = [];
      for (const route of derived) {
        const url = route.url.replace(/:([A-Za-z]+)/g, (_all, name: string) => ids[name] ?? "");
        const open = OPEN_WHILE_SUSPENDED.has(`${route.method} ${route.url}`);
        if (unavailable(await player(route.method, url)) === open) {
          wrong.push(`${route.method} ${route.url} (${open ? "open" : "walled"})`);
        }
      }
      expect(wrong).toEqual([]);
    } finally {
      await reactivate(eventPath());
    }
  });

  describe("the lookup", () => {
    it("is not made while no event is suspended", async () => {
      const spy = lookups(test.pool);
      try {
        expect(unavailable(await player("PUT", `/v1/quests/${ids["questId"]}/rating`))).toBe(false);
        expect(unavailable(await player("POST", `/v1/steps/${ids["stepId"]}/stamp`))).toBe(false);
        expect(spy.count()).toBe(0);
      } finally {
        spy.restore();
      }
    });

    it("is made once a request when the wall and the maintenance gate both need it", async () => {
      await suspend(`/v1/admin/events/${eventB}`);
      const pause = { ar: "هذه الفعالية متوقفة.", en: "This event is paused." };
      const paused = await call(
        "PUT",
        "/v1/admin/switches/maintenance/events",
        withSession(adminCookie),
        {
          joinCode: "NAJD1",
          message: pause,
        },
      );
      expect(paused.statusCode).toBe(204);
      const spy = lookups(test.pool);
      try {
        const answer = await player("POST", `/v1/quests/${ids["questId"]}/complete`);
        expect((answer.json() as { code?: string }).code).toBe("maintenance");
        expect(spy.count()).toBe(1);
      } finally {
        spy.restore();
        const lifted = await call(
          "DELETE",
          `/v1/admin/switches/maintenance/events/${eventA}`,
          withSession(adminCookie),
        );
        expect(lifted.statusCode).toBe(204);
        await reactivate(`/v1/admin/events/${eventB}`);
      }
    });
  });
});
