import { MARKETING_TEXT_VERSION } from "@questify/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { optOutToken } from "#src/marketing/opt-out";
import { registerMarketingRoutes } from "#src/marketing/routes";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SIGNED_IN = { "x-test-player": "yes" };
const NO_STORE = "private, no-store";
const keys = createAuthKeys("k".repeat(40));

type Seen = { sql: string; values: readonly unknown[] };
let app: FastifyInstance;

const STATE = {
  channels: {
    push: { optedIn: false, changedAt: null },
    sms: { optedIn: true, changedAt: "2030-01-01T00:00:00.000Z" },
    email: { optedIn: false, changedAt: null },
  },
  asked: true,
  canOptIn: true,
};

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
  registerMarketingRoutes(app, { pool, keys });
  return { seen };
}

const asked = (seen: Seen[], name: string) => seen.filter((one) => one.sql.includes(name));
const put = (url: string, payload: unknown, headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method: "PUT", url, headers, payload: payload as object });
const forgedToken = () =>
  optOutToken(createAuthKeys("z".repeat(40)), { playerId: OTHER, channel: "sms" });
const consent = (overrides: object = {}) => ({
  textVersion: MARKETING_TEXT_VERSION,
  method: "settings",
  channels: { sms: true },
  ...overrides,
});

afterEach(async () => {
  await app.close();
});

const optOut = (payload: unknown) =>
  app.inject({
    method: "POST",
    url: "/v1/public/marketing/opt-out",
    payload: payload as object,
  });

describe("GET /v1/me/marketing", () => {
  it("answers the caller's consent, never cached", async () => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/me/marketing",
      headers: SIGNED_IN,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    expect(response.json()).toEqual(STATE);
    expect(asked(seen, "own_marketing")).toHaveLength(1);
  });

  it("answers 401 without a player and asks the database nothing", async () => {
    const { seen } = build(() => ({ rows: [] }));
    const response = await app.inject({ method: "GET", url: "/v1/me/marketing" });
    expect(response.statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it("answers 401 when the database says the caller is not an active player", async () => {
    build(() => {
      throw pgError({ code: "PI401" });
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/me/marketing",
      headers: SIGNED_IN,
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });
});

describe("PUT /v1/me/marketing", () => {
  it("sends the channels, the method, the text version and the language to the database", async () => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }));
    const response = await put("/v1/me/marketing", consent({ method: "signup" }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(STATE);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
    // No accept-language: no language (read as Arabic when a promotion is sent).
    expect(asked(seen, "set_marketing")[0]?.values).toEqual([
      '{"sms":true}',
      "signup",
      MARKETING_TEXT_VERSION,
      null,
    ]);
  });

  it("refuses a consent to wording other than the one in force, before the database", async () => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }));
    const response = await put("/v1/me/marketing", consent({ textVersion: "0.9" }));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "consent_text_outdated",
      details: { textVersion: MARKETING_TEXT_VERSION },
    });
    expect(asked(seen, "set_marketing")).toEqual([]);
  });

  it("saves an all-off body whatever the wording version: the Settings opt-out from an old app, and the skip after a wording change", async () => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }));
    for (const method of ["settings", "signup"]) {
      const off = consent({ textVersion: "0.9", method, channels: { push: false, sms: false } });
      expect((await put("/v1/me/marketing", off)).statusCode, method).toBe(200);
    }
    expect(asked(seen, "set_marketing")).toHaveLength(2);
  });

  it("still refuses a yes to old wording even when other channels in the body are off", async () => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }));
    const response = await put(
      "/v1/me/marketing",
      consent({ textVersion: "0.9", channels: { push: false, sms: true } }),
    );
    expect(response.statusCode).toBe(409);
    expect(asked(seen, "set_marketing")).toEqual([]);
  });

  it.each([
    ["no channel", consent({ channels: {} })],
    ["an unknown channel", consent({ channels: { fax: true } })],
    ["a string value", consent({ channels: { sms: "yes" } })],
    ["an unknown method", consent({ method: "opt_out_link" })],
    ["an extra field", consent({ playerId: OTHER })],
    ["no version", { method: "settings", channels: { sms: true } }],
  ])("refuses %s as a bad request", async (_name, payload) => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }));
    const response = await put("/v1/me/marketing", payload);
    expect(response.statusCode).toBe(400);
    expect(asked(seen, "set_marketing")).toEqual([]);
  });

  it("answers 403 consent_age for a player who may not opt in", async () => {
    build((sql) => {
      if (sql.includes("set_marketing")) throw pgError({ code: "MK403", detail: "age" });
      return { rows: [] };
    });
    const response = await put("/v1/me/marketing", consent());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "consent_age" });
  });

  it("answers 429 with Retry-After after 60 writes an hour, and writes nothing", async () => {
    const { seen } = build(() => ({ rows: [{ r: STATE }] }), { count: 60, retry_after: 90 });
    const response = await put("/v1/me/marketing", consent());
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("90");
    expect(asked(seen, "set_marketing")).toEqual([]);
  });

  it("answers 401 without a player", async () => {
    build(() => ({ rows: [] }));
    expect((await put("/v1/me/marketing", consent(), {})).statusCode).toBe(401);
  });
});

describe("preferences", () => {
  const prefs = { cityId: "sa-riyadh", interests: ["sport"] };

  it("reads the caller's city and interests, never cached", async () => {
    build(() => ({ rows: [{ r: prefs }] }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/me/preferences",
      headers: SIGNED_IN,
    });
    expect(response.json()).toEqual(prefs);
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });

  it("replaces them", async () => {
    const { seen } = build(() => ({ rows: [{ r: prefs }] }));
    const response = await put("/v1/me/preferences", prefs);
    expect(response.statusCode).toBe(200);
    expect(asked(seen, "set_preferences")[0]?.values).toEqual(["sa-riyadh", ["sport"]]);
  });

  it("names the field of a refusal in a 422", async () => {
    build((sql) => {
      if (sql.includes("set_preferences")) throw pgError({ code: "PF422", detail: "cityId" });
      return { rows: [] };
    });
    const response = await put("/v1/me/preferences", prefs);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "invalid_preferences",
      details: { field: "cityId" },
    });
  });

  it.each([
    ["a repeated interest", { cityId: null, interests: ["sport", "sport"] }],
    ["nine interests", { cityId: null, interests: Array.from({ length: 9 }, (_, i) => `i${i}`) }],
    ["a missing city", { interests: [] }],
    ["an extra field", { cityId: null, interests: [], birthYear: 1990 }],
    ["an interest that is not an id", { cityId: null, interests: ["Sport!"] }],
  ])("refuses %s as a bad request", async (_name, payload) => {
    const { seen } = build(() => ({ rows: [{ r: prefs }] }));
    expect((await put("/v1/me/preferences", payload)).statusCode).toBe(400);
    expect(asked(seen, "set_preferences")).toEqual([]);
  });
});

describe("GET /v1/me/for-you", () => {
  it("wraps the database's list, never cached", async () => {
    const list = [{ id: "e1" }];
    build(() => ({ rows: [{ r: list }] }));
    const response = await app.inject({ method: "GET", url: "/v1/me/for-you", headers: SIGNED_IN });
    expect(response.json()).toEqual({ events: list });
    expect(response.headers["cache-control"]).toBe(NO_STORE);
  });
});

describe("GET /v1/interests", () => {
  it("is public and cacheable for an hour", async () => {
    const list = [{ id: "sport", name: { ar: "رياضة", en: "Sport" } }];
    build(() => ({ rows: [{ r: list }] }));
    const response = await app.inject({ method: "GET", url: "/v1/interests" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.json()).toEqual({ interests: list });
  });
});

describe("POST /v1/public/marketing/opt-out", () => {
  it("turns the signed channel off and answers 204, never cached", async () => {
    const { seen } = build(() => ({ rows: [{ r: "opted_out" }] }));
    const token = optOutToken(keys, { playerId: OTHER, channel: "sms" });
    const response = await optOut({ token });
    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(asked(seen, "marketing_opt_out")[0]?.values).toEqual([OTHER, "sms"]);
  });

  it.each(["gone", "already_off"])("answers 204 when the outcome is %s", async (outcome) => {
    build(() => ({ rows: [{ r: outcome }] }));
    const token = optOutToken(keys, { playerId: OTHER, channel: "email" });
    expect((await optOut({ token })).statusCode).toBe(204);
  });

  it("refuses a token signed with another key, asking the database nothing", async () => {
    const { seen } = build(() => ({ rows: [{ r: "opted_out" }] }));
    const token = optOutToken(createAuthKeys("z".repeat(40)), { playerId: OTHER, channel: "sms" });
    const response = await optOut({ token });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_opt_out" });
    expect(asked(seen, "marketing_opt_out")).toEqual([]);
  });

  it("throttles forged tokens too: at the limit the answer is 429, not 400", async () => {
    build(() => ({ rows: [{ r: "opted_out" }] }), { count: 30, retry_after: 40 });
    expect((await optOut({ token: forgedToken() })).statusCode).toBe(429);
  });

  it("counts a forged token as an attempt before it is refused", async () => {
    const { seen } = build(() => ({ rows: [{ r: "opted_out" }] }));
    expect((await optOut({ token: forgedToken() })).statusCode).toBe(400);
    expect(asked(seen, "INSERT INTO auth_throttle")).toHaveLength(1);
  });

  it.each([{}, { token: "x" }, { token: "a".repeat(44), extra: 1 }, { token: 5 }])(
    "refuses the body %j as a bad request",
    async (payload) => {
      const { seen } = build(() => ({ rows: [{ r: "opted_out" }] }));
      expect((await optOut(payload)).statusCode).toBe(400);
      expect(asked(seen, "marketing_opt_out")).toEqual([]);
    },
  );

  it("answers 429 with Retry-After after 30 attempts an hour from one address", async () => {
    const { seen } = build(() => ({ rows: [{ r: "opted_out" }] }), { count: 30, retry_after: 40 });
    const token = optOutToken(keys, { playerId: OTHER, channel: "sms" });
    const response = await optOut({ token });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("40");
    expect(asked(seen, "marketing_opt_out")).toEqual([]);
  });
});
