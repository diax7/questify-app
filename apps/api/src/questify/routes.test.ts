import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { registerQuestifyRoutes } from "#src/questify/routes";
import { fakePool, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const SIGNED_IN = { "x-test-player": "yes" };
const NO_STORE = "private, no-store";

const key = () => Buffer.alloc(32, 7);

type Seen = { sql: string; values: readonly unknown[] };
let app: FastifyInstance;

/** The routes over a pool that answers from `answer`; the throttle's own statements answer `window`. */
function build(
  answer: (sql: string, values: readonly unknown[]) => FakeAnswer,
  window: { count: number; retry_after: number | null } = { count: 0, retry_after: null },
) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("FROM auth_throttle")) return { rows: [window] };
    if (sql.includes("INSERT INTO auth_throttle")) return { rows: [{ at: "2030-01-01" }] };
    return answer(sql, values);
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-player"] !== undefined) request.player = { id: PLAYER };
  });
  registerQuestifyRoutes(app, { pool, keys: { playerKey: key, addressKey: key, optOutTag: key } });
  return { seen };
}

const asked = (seen: Seen[], name: string) => seen.filter((one) => one.sql.includes(name));
const call = (method: "GET" | "POST", url: string, headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method, url, headers });
const KEY = "55555555-5555-4555-8555-555555555555";
const ITEM = {
  id: "shop-map-reader",
  kind: "title",
  name: { ar: "قارئ الخرائط", en: "Map reader" },
  visualKey: null,
};
const purchase = (
  payload: unknown = { itemId: ITEM.id, price: 40 },
  headers: Record<string, string> = { ...SIGNED_IN, "idempotency-key": KEY },
) =>
  app.inject({
    method: "POST",
    url: "/v1/me/gem-shop/purchases",
    headers,
    payload: payload as object,
  });

afterEach(async () => {
  await app.close();
});

describe("GET /v1/me/achievements", () => {
  it("answers the caller's achievements, never cached", async () => {
    const list = [{ id: "regular", tier: "bronze" }];
    const { seen } = build(() => ({ rows: [{ list }] }));
    const response = await call("GET", "/v1/me/achievements");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual({ achievements: list });
    expect(asked(seen, "own_achievements")).toHaveLength(1);
  });

  it("answers 401 for an inactive caller, never cached", async () => {
    build(() => ({ rows: [{ list: null }] }));
    const response = await call("GET", "/v1/me/achievements");
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });

  it("answers 401 without a player and asks the database nothing", async () => {
    const { seen } = build(() => ({ rows: [] }));
    const response = await call("GET", "/v1/me/achievements", {});
    expect(response.statusCode).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("GET /v1/me/questify-quests", () => {
  it("answers the caller's quests, never cached", async () => {
    const list = { alwaysOn: [], seasonal: [] };
    const { seen } = build(() => ({ rows: [{ list }] }));
    const response = await call("GET", "/v1/me/questify-quests");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual(list);
    expect(asked(seen, "own_questify_quests")).toHaveLength(1);
  });

  it("answers 401 for an inactive caller, never cached", async () => {
    build(() => ({ rows: [{ list: null }] }));
    const response = await call("GET", "/v1/me/questify-quests");
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });
});

describe("POST /v1/me/questify/sync", () => {
  it("answers what the evaluator wrote, never cached, after recording the attempt", async () => {
    const result = {
      achievements: [],
      quests: [],
      levelUp: null,
      gems: { earned: 0, balance: 12 },
    };
    const { seen } = build(() => ({ rows: [{ result }] }));
    const response = await call("POST", "/v1/me/questify/sync");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual(result);
    expect(asked(seen, "INSERT INTO auth_throttle")).toHaveLength(1);
    expect(asked(seen, "questify_sync")).toHaveLength(1);
  });

  it("answers 429 and does not sync when the player's minute is used up", async () => {
    const { seen } = build(() => ({ rows: [] }), { count: 20, retry_after: 30 });
    const response = await call("POST", "/v1/me/questify/sync");
    expect(response.statusCode).toBe(429);
    expect(asked(seen, "questify_sync")).toEqual([]);
  });
});

describe("GET /v1/me/gem-shop", () => {
  it("answers the caller's balance and the items, never cached", async () => {
    const shop = { gems: 30, items: [{ ...ITEM, price: 40, owned: false }] };
    const { seen } = build(() => ({ rows: [{ shop }] }));
    const response = await call("GET", "/v1/me/gem-shop");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual(shop);
    expect(asked(seen, "gem_shop()")).toHaveLength(1);
  });

  it("answers 401 for an inactive caller and without a player", async () => {
    build(() => ({ rows: [{ shop: null }] }));
    expect((await call("GET", "/v1/me/gem-shop")).statusCode).toBe(401);
    const { seen } = build(() => ({ rows: [] }));
    expect((await call("GET", "/v1/me/gem-shop", {})).statusCode).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("POST /v1/me/gem-shop/purchases", () => {
  const bought = { itemId: ITEM.id, gems: 10, item: ITEM, replayed: false };

  it("gets the item with the seen price and the key, after recording the attempt", async () => {
    const { seen } = build(() => ({ rows: [{ result: bought }] }));
    const response = await purchase();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual({ itemId: ITEM.id, gems: 10, item: ITEM });
    expect(asked(seen, "INSERT INTO auth_throttle")).toHaveLength(1);
    expect(asked(seen, "gem_buy")[0]?.values).toEqual([ITEM.id, 40, KEY]);
  });

  it.each([
    ["no key", { ...SIGNED_IN }, "idempotency_key_required"],
    [
      "a key that is not a UUID",
      { ...SIGNED_IN, "idempotency-key": "tap-1" },
      "idempotency_key_invalid",
    ],
  ])("answers 400 for %s and asks the database nothing", async (_label, headers, code) => {
    const { seen } = build(() => ({ rows: [{ result: bought }] }));
    const response = await purchase(undefined, headers);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code });
    expect(asked(seen, "gem_buy")).toEqual([]);
  });

  it.each([
    ["a price that is not an integer", { itemId: ITEM.id, price: 40.5 }],
    ["a price of 0", { itemId: ITEM.id, price: 0 }],
    ["a price as text", { itemId: ITEM.id, price: "40" }],
    ["no item", { price: 40 }],
    ["an unknown field", { itemId: ITEM.id, price: 40, playerId: KEY }],
  ])("answers 400 for %s", async (_label, payload) => {
    const { seen } = build(() => ({ rows: [{ result: bought }] }));
    expect((await purchase(payload)).statusCode).toBe(400);
    expect(asked(seen, "gem_buy")).toEqual([]);
  });

  it("answers 429 and buys nothing when the player's minute is used up", async () => {
    const { seen } = build(() => ({ rows: [{ result: bought }] }), { count: 10, retry_after: 20 });
    const response = await purchase();
    expect(response.statusCode).toBe(429);
    expect(asked(seen, "gem_buy")).toEqual([]);
  });

  it.each([
    [{ code: "GS404" }, 404, { code: "gem_item_not_found" }],
    [
      { code: "GS409", detail: "too_few_gems", hint: "10" },
      409,
      { code: "gem_shop_conflict", details: { reason: "too_few_gems", gems: 10 } },
    ],
    [{ code: "GS422", detail: "key_reused" }, 422, { code: "idempotency_key_reused" }],
    [{ code: "PI401" }, 401, { code: "unauthenticated" }],
  ])("answers the refusal %o as %i", async (fields, status, body) => {
    build((sql) => {
      if (sql.includes("gem_buy")) throw Object.assign(new Error("refused"), fields);
      return { rows: [] };
    });
    const response = await purchase();
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject(body);
  });

  it("replays a refusal to a retry with the same key, so the app sends a fresh key per confirmation", async () => {
    let balance = 10;
    const { seen } = build((sql) => {
      if (sql.includes("gem_buy")) {
        throw Object.assign(new Error("refused"), {
          code: "GS409",
          detail: "too_few_gems",
          hint: String(balance),
        });
      }
      return { rows: [] };
    });
    expect((await purchase()).json()).toMatchObject({ details: { gems: 10 } });
    balance = 500;
    const retry = await purchase();
    expect(retry.statusCode).toBe(409);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json()).toMatchObject({ details: { reason: "too_few_gems", gems: 10 } });
    expect(asked(seen, "gem_buy")).toHaveLength(1);
  });
});

describe("GET /v1/me/event-history", () => {
  it("reads the played flag, the limit and the first page from the query", async () => {
    const { seen } = build(() => ({ rows: [] }));
    const response = await call("GET", "/v1/me/event-history?played=true&limit=5");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual({ events: [], nextCursor: null });
    expect(asked(seen, "own_events")[0]?.values).toEqual([true, null, null, 6]);
  });

  it("reads the whole history by default, 20 to a page", async () => {
    const { seen } = build(() => ({ rows: [] }));
    await call("GET", "/v1/me/event-history");
    expect(asked(seen, "own_events")[0]?.values).toEqual([false, null, null, 21]);
  });

  it.each(["limit=0", "limit=51", "played=yes", "cursor=bad%21", "unexpected=1"])(
    "answers 400 for the query %s",
    async (query) => {
      const { seen } = build(() => ({ rows: [] }));
      const response = await call("GET", `/v1/me/event-history?${query}`);
      expect(response.statusCode).toBe(400);
      expect(asked(seen, "own_events")).toEqual([]);
    },
  );
});

describe("GET /v1/cities", () => {
  it("answers the cities to anyone, cached for an hour", async () => {
    const list = [{ id: "riyadh", name: { ar: "الرياض", en: "Riyadh" } }];
    build(() => ({ rows: [{ list }] }));
    const response = await call("GET", "/v1/cities", {});
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.json()).toEqual({ cities: list });
  });
});
