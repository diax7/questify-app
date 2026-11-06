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
      items: [],
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

describe("GET /v1/questify/ranking", () => {
  const board = { board: "all", rows: [], me: null };

  it("reads the lifetime board by default and the month board when asked, never cached", async () => {
    const { seen } = build(() => ({ rows: [{ r: board }] }));
    const response = await call("GET", "/v1/questify/ranking");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual({ scope: "lifetime", month: null, rows: [], me: null });
    build(() => ({ rows: [{ r: { ...board, board: "2026-10" } }] }));
    expect((await call("GET", "/v1/questify/ranking?scope=month")).json()).toMatchObject({
      scope: "month",
      month: "2026-10",
    });
    expect(asked(seen, "questify_ranking($1)").map((one) => one.values)).toEqual([["lifetime"]]);
  });

  it("answers 400 for another scope or an unknown query key, asking the database nothing", async () => {
    for (const url of ["/v1/questify/ranking?scope=season", "/v1/questify/ranking?page=2"]) {
      const { seen } = build(() => ({ rows: [{ r: board }] }));
      expect((await call("GET", url)).statusCode).toBe(400);
      expect(asked(seen, "questify_ranking")).toEqual([]);
    }
  });

  it("answers 401 without a player, and 404 ranking_off while the switch is off", async () => {
    const { seen } = build(() => ({ rows: [] }));
    expect((await call("GET", "/v1/questify/ranking", {})).statusCode).toBe(401);
    expect(seen).toEqual([]);
    build(() => {
      throw Object.assign(new Error("off"), { code: "QW404" });
    });
    const off = await call("GET", "/v1/questify/ranking");
    expect(off.statusCode).toBe(404);
    expect(off.json()).toMatchObject({ code: "ranking_off" });
  });
});

describe("GET /v1/me/rewards", () => {
  const item = { id: "frame-a", kind: "frame", name: { ar: "ا", en: "A" }, visualKey: "frame-01" };
  const rewards = {
    level: { number: 2, title: { ar: "ا", en: "A" }, xp: 150, levelFrom: 100, nextLevelAt: 300 },
    levels: [{ level: 2, xpFrom: 100, item, owned: true }],
    achievements: [],
  };

  it("answers the caller's level rewards, never cached", async () => {
    const { seen } = build(() => ({ rows: [{ r: rewards }] }));
    const response = await call("GET", "/v1/me/rewards");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual(rewards);
    expect(asked(seen, "own_level_rewards()")).toHaveLength(1);
  });

  it("refuses a caller the door refuses, and a request with no player", async () => {
    build(() => {
      throw Object.assign(new Error("refused"), { code: "PI401" });
    });
    expect((await call("GET", "/v1/me/rewards")).statusCode).toBe(401);
    await app.close();
    build(() => ({ rows: [] }));
    expect((await call("GET", "/v1/me/rewards", {})).statusCode).toBe(401);
  });

  it("fails as a server fault on a field the schema does not know, and any other database error", async () => {
    build(() => ({ rows: [{ r: { ...rewards, price: 5 } }] }));
    expect((await call("GET", "/v1/me/rewards")).statusCode).toBe(500);
    await app.close();
    build(() => {
      throw new Error("down");
    });
    expect((await call("GET", "/v1/me/rewards")).statusCode).toBe(500);
  });

  it("has no gem shop door any more", async () => {
    build(() => ({ rows: [] }));
    expect((await call("GET", "/v1/me/gem-shop")).statusCode).toBe(404);
    expect((await call("POST", "/v1/me/gem-shop/purchases")).statusCode).toBe(404);
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
