import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { registerItemRoutes } from "#src/players/item-routes";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const SIGNED_IN = { "x-test-player": "yes" };
const item = {
  id: "frame-01",
  kind: "frame",
  name: { ar: "إطار", en: "Frame" },
  visualKey: "frame-01",
};
const profile = {
  username: "sara_k",
  character: { starter: "falcon" },
  frame: null,
  title: null,
  level: { number: 2, title: { ar: "مستكشف", en: "Explorer" } },
};

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
  registerItemRoutes(app, { pool, keys: { playerKey: () => Buffer.alloc(32, 7) } });
  return { seen };
}

const asked = (seen: Seen[], name: string) => seen.filter((one) => one.sql.includes(name));
const post = (payload: unknown, headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method: "POST", url: "/v1/me/locker/seen", headers, payload: payload as object });
const get = (username: string, headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method: "GET", url: `/v1/players/${username}`, headers });

afterEach(async () => {
  await app.close();
});

describe("GET /v1/me/locker", () => {
  const lockerRow = {
    item,
    earned_at: "2030-01-01T10:00:00.000000Z",
    source_level: 2,
    source_event: null,
    seen: false,
  };

  it("answers the page for the signed-in player, never cached", async () => {
    const { seen } = build(() => ({ rows: [lockerRow] }));
    const response = await app.inject({ method: "GET", url: "/v1/me/locker", headers: SIGNED_IN });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({
      items: [
        {
          item,
          earnedAt: "2030-01-01T10:00:00.000000Z",
          source: { kind: "level", level: 2 },
          seen: false,
        },
      ],
      nextCursor: null,
    });
    expect(asked(seen, "own_locker")[0]?.values).toEqual([null, null, 31]);
  });

  it("takes the limit from the query", async () => {
    const { seen } = build(() => ({ rows: [] }));
    await app.inject({ method: "GET", url: "/v1/me/locker?limit=7", headers: SIGNED_IN });
    expect(asked(seen, "own_locker")[0]?.values).toEqual([null, null, 8]);
  });

  it("answers 401 without a player", async () => {
    const { seen } = build(() => ({ rows: [] }));
    const response = await app.inject({ method: "GET", url: "/v1/me/locker" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
    expect(seen).toEqual([]);
  });

  it.each(["limit=0", "limit=101", "limit=1.5", "cursor=bad%21", "unexpected=true"])(
    "answers 400 for the query %s",
    async (query) => {
      const { seen } = build(() => ({ rows: [] }));
      const response = await app.inject({
        method: "GET",
        url: `/v1/me/locker?${query}`,
        headers: SIGNED_IN,
      });
      expect(response.statusCode).toBe(400);
      expect(asked(seen, "own_locker")).toEqual([]);
    },
  );
});

describe("POST /v1/me/locker/seen", () => {
  it("marks the listed items seen as the player and answers 204 with no body", async () => {
    const { seen } = build(() => ({ rows: [] }));
    const response = await post({ itemIds: ["frame-01", "title-02"] });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(asked(seen, "see_owned_items").map((one) => one.values)).toEqual([
      [["frame-01", "title-02"]],
    ]);
  });

  it("accepts one id, 100 ids and ids of 1 to 64 characters", async () => {
    build(() => ({ rows: [] }));
    for (const itemIds of [
      ["a"],
      ["x".repeat(64)],
      Array.from({ length: 100 }, (_, index) => `item-${index}`),
    ])
      expect((await post({ itemIds })).statusCode).toBe(204);
  });

  it("answers 401 without a player and marks nothing", async () => {
    const { seen } = build(() => ({ rows: [] }));
    const response = await post({ itemIds: ["frame-01"] }, {});
    expect(response.statusCode).toBe(401);
    expect(asked(seen, "see_owned_items")).toEqual([]);
  });

  it.each([
    ["no ids", { itemIds: [] }],
    ["a repeated id", { itemIds: ["a", "b", "a"] }],
    ["101 ids", { itemIds: Array.from({ length: 101 }, (_, index) => `item-${index}`) }],
    ["an empty id", { itemIds: [""] }],
    ["an id of 65 characters", { itemIds: ["x".repeat(65)] }],
    ["an id that is not text", { itemIds: [5] }],
    ["a field it does not know", { itemIds: ["a"], playerId: "forged" }],
    ["no itemIds", {}],
  ])("answers 400 for %s", async (_name, payload) => {
    const { seen } = build(() => ({ rows: [] }));
    expect((await post(payload)).statusCode).toBe(400);
    expect(asked(seen, "see_owned_items")).toEqual([]);
  });

  it("answers 401 when the database cannot read the player's session (PI401)", async () => {
    build(() => {
      throw pgError({ code: "PI401" });
    });
    const response = await post({ itemIds: ["frame-01"] });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("answers 422 item_not_owned for an item outside the player's locker (PI422)", async () => {
    build(() => {
      throw pgError({ code: "PI422" });
    });
    const response = await post({ itemIds: ["frame-01"] });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "item_not_owned" });
  });

  it("does not turn another database failure into a success", async () => {
    build(() => {
      throw pgError({ code: "XX000" });
    });
    const response = await post({ itemIds: ["frame-01"] });
    expect(response.statusCode).toBe(500);
  });
});

describe("GET /v1/players/:username", () => {
  it("answers the public profile for a name, never cached, and asks the database for that name", async () => {
    const { seen } = build(() => ({ rows: [{ profile }] }));
    const response = await get("sara_k");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual(profile);
    expect(asked(seen, "public_player_profile").map((one) => one.values)).toEqual([["sara_k"]]);
  });

  it("strips a field the database adds that the public allowlist does not name", async () => {
    build(() => ({ rows: [{ profile: { ...profile, email: "private@example.com" } }] }));
    expect((await get("sara_k")).json()).toEqual(profile);
  });

  it("answers 404 when the database returns no profile row", async () => {
    build(() => ({ rows: [] }));
    const response = await get("nobody");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
  });

  it("answers 404 when the profile is null, as for a banned or absent player", async () => {
    build(() => ({ rows: [{ profile: null }] }));
    const response = await get("banned");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
  });

  it("answers 401 without a player", async () => {
    const { seen } = build(() => ({ rows: [{ profile }] }));
    const response = await get("sara_k", {});
    expect(response.statusCode).toBe(401);
    expect(asked(seen, "public_player_profile")).toEqual([]);
  });

  it("counts each read against the player's own key, 60 a minute", async () => {
    const { seen } = build(() => ({ rows: [{ profile }] }));
    await get("sara_k");
    expect(asked(seen, "FROM auth_throttle")[0]?.values).toEqual([
      "profile_read",
      Buffer.alloc(32, 7),
      60,
    ]);
    expect(asked(seen, "INSERT INTO auth_throttle")).toHaveLength(1);
  });

  it("answers 429 with Retry-After once the minute's reads are used up, and reads no profile", async () => {
    const { seen } = build(() => ({ rows: [{ profile }] }), { count: 60, retry_after: 12 });
    const response = await get("sara_k");
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("12");
    expect(asked(seen, "public_player_profile")).toEqual([]);
  });

  it("still answers at 59 reads in the minute", async () => {
    build(() => ({ rows: [{ profile }] }), { count: 59, retry_after: 12 });
    expect((await get("sara_k")).statusCode).toBe(200);
  });
});
