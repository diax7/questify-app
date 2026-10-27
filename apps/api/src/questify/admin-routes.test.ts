import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { registerConsoleQuestifyRoutes } from "#src/questify/admin-routes";
import { fakePool } from "#test/support/fake-pool";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const QUEST = "33333333-3333-4333-8333-333333333333";
const SIGNED_IN = { "x-test-admin": "yes", "idempotency-key": "key-1" };
const campaignBody = {
  name: { ar: "موسم الشتاء", en: "Winter season" },
  startsAt: "2030-01-01T00:00:00+03:00",
  endsAt: "2030-02-01T00:00:00+03:00",
};
const questPatch = {
  metric: "events",
  target: 3,
  title: { ar: "ثلاث فعاليات", en: "Three events" },
  xp: 50,
  position: 1,
  status: "draft",
};
const questBody = { ...questPatch, campaignId: CAMPAIGN };

type Seen = { sql: string; values: readonly unknown[] };
let app: FastifyInstance;

/** The console routes at the admin prefix over a pool answering every door with `answer` as its `r` column. */
function build(answer: unknown = { ok: true }) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return { rows: [{ r: answer }] };
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-admin"] !== undefined) {
      request.staff = { account: { id: ADMIN } as PublicAccount, sessionId: "session-1" };
    }
  });
  app.register(async (scope) => registerConsoleQuestifyRoutes(scope, { pool }), {
    prefix: "/v1/admin",
  });
  return { seen };
}

const send = (
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  headers = SIGNED_IN,
) => app.inject({ method, url: `/v1/admin/questify${url}`, headers, payload: payload as object });
const requestIdOf = (response: { headers: Record<string, unknown> }) =>
  response.headers["x-request-id"];

afterEach(async () => {
  await app.close();
});

describe("GET /v1/admin/questify", () => {
  it("answers the door's list as the signed-in admin", async () => {
    const list = { alwaysOn: [], campaigns: [] };
    const { seen } = build(list);
    const response = await send("GET", "");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(list);
    expect(seen).toEqual([{ sql: "SELECT questify_admin_list() AS r", values: [] }]);
  });

  it("answers 404 and asks nothing when the request carries no staff member", async () => {
    const { seen } = build();
    const response = await send("GET", "", undefined, {} as typeof SIGNED_IN);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not_found" });
    expect(seen).toEqual([]);
  });
});

describe("the ranking's seasons (T-408)", () => {
  it("lists the seasons from the door as the signed-in admin", async () => {
    const seasons = [{ month: "2026-10", players: 3, current: true }];
    const { seen } = build(seasons);
    const response = await send("GET", "/seasons");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ seasons });
    expect(seen.map((one) => one.sql)).toEqual(["SELECT questify_seasons() AS r"]);
  });

  it("reads one season by its month", async () => {
    const season = { month: "2026-09", players: 0, rows: [] };
    const { seen } = build(season);
    const response = await send("GET", "/seasons/2026-09");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(season);
    expect(seen).toEqual([{ sql: "SELECT questify_season_top($1) AS r", values: ["2026-09"] }]);
  });

  it("answers 400 for a malformed month and asks nothing", async () => {
    for (const month of ["2026-13", "2026-9", "current"]) {
      const { seen } = build();
      expect((await send("GET", `/seasons/${month}`)).statusCode).toBe(400);
      expect(seen).toEqual([]);
    }
  });

  it("answers 404 and asks nothing without a staff member", async () => {
    const { seen } = build();
    expect((await send("GET", "/seasons", undefined, {} as typeof SIGNED_IN)).statusCode).toBe(404);
    expect(seen).toEqual([]);
  });
});

describe("campaign writes", () => {
  it("creates a draft with a null id, the parsed body and the request id, answering 201", async () => {
    const saved = { id: CAMPAIGN, status: "draft" };
    const { seen } = build(saved);
    const response = await send("POST", "/campaigns", campaignBody);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ campaign: saved });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("questify_campaign_save");
    expect(seen[0]?.values[0]).toBeNull();
    expect(JSON.parse(String(seen[0]?.values[1]))).toEqual(campaignBody);
    expect(seen[0]?.values[2]).toBe(requestIdOf(response));
  });

  it("replaces the named campaign with the parsed body and the request id, answering 200", async () => {
    const saved = { id: CAMPAIGN, status: "draft" };
    const { seen } = build(saved);
    const response = await send("PUT", `/campaigns/${CAMPAIGN}`, campaignBody);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ campaign: saved });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("questify_campaign_save");
    expect(seen[0]?.values[0]).toBe(CAMPAIGN);
    expect(JSON.parse(String(seen[0]?.values[1]))).toEqual(campaignBody);
    expect(seen[0]?.values[2]).toBe(requestIdOf(response));
  });

  it("trims the names before they reach the database", async () => {
    const { seen } = build();
    const padded = { ...campaignBody, name: { ar: "  موسم  ", en: "  Winter  " } };
    await send("POST", "/campaigns", padded);
    expect(JSON.parse(String(seen[0]?.values[1]))).toEqual({
      ...campaignBody,
      name: { ar: "موسم", en: "Winter" },
    });
  });

  it("publishes and retires by campaign id with the request id", async () => {
    const saved = { id: CAMPAIGN, status: "published" };
    const { seen } = build(saved);
    const publish = await send("POST", `/campaigns/${CAMPAIGN}/publish`, {});
    const retire = await send(
      "POST",
      `/campaigns/${CAMPAIGN}/retire`,
      {},
      {
        ...SIGNED_IN,
        "idempotency-key": "key-2",
      },
    );
    expect(publish.json()).toEqual({ campaign: saved });
    expect(retire.json()).toEqual({ campaign: saved });
    expect(seen.map((one) => [one.sql, one.values])).toEqual([
      ["SELECT questify_campaign_publish($1, $2) AS r", [CAMPAIGN, requestIdOf(publish)]],
      ["SELECT questify_campaign_retire($1, $2) AS r", [CAMPAIGN, requestIdOf(retire)]],
    ]);
  });

  it("accepts a window that ends one second after it starts", async () => {
    build();
    const response = await send("POST", "/campaigns", {
      ...campaignBody,
      endsAt: "2030-01-01T00:00:01+03:00",
    });
    expect(response.statusCode).toBe(201);
  });

  it.each([
    ["the same instant", "2030-01-01T00:00:00+03:00"],
    ["the same instant in another offset", "2029-12-31T21:00:00Z"],
    ["an earlier instant", "2029-12-31T00:00:00+03:00"],
  ])(
    "answers 422 naming endsAt when the window ends at %s as it starts",
    async (_label, endsAt) => {
      const { seen } = build();
      const created = await send("POST", "/campaigns", { ...campaignBody, endsAt });
      const replaced = await send(
        "PUT",
        `/campaigns/${CAMPAIGN}`,
        { ...campaignBody, endsAt },
        {
          ...SIGNED_IN,
          "idempotency-key": "key-2",
        },
      );
      for (const response of [created, replaced]) {
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: "invalid_questify",
          details: { field: "endsAt" },
        });
      }
      expect(seen).toEqual([]);
    },
  );

  it.each([
    ["a window without an offset", { startsAt: "2030-01-01T00:00:00" }],
    ["a missing name", { name: undefined }],
    ["an unknown field", { extra: true }],
    ["a blank name", { name: { ar: "   ", en: "Winter" } }],
  ])("answers 400 for %s", async (_label, change) => {
    const { seen } = build();
    const response = await send("POST", "/campaigns", { ...campaignBody, ...change });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(seen).toEqual([]);
  });

  it("answers 400 for a campaign id that is not a UUID", async () => {
    const { seen } = build();
    const response = await send("PUT", "/campaigns/not-a-uuid", campaignBody);
    expect(response.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe("quest writes", () => {
  it("creates a quest with a null id, the parsed body and the request id, answering 201", async () => {
    const saved = { id: QUEST, status: "draft" };
    const { seen } = build(saved);
    const response = await send("POST", "/quests", questBody);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ quest: saved });
    expect(seen[0]?.sql).toContain("questify_quest_save");
    expect(seen[0]?.values[0]).toBeNull();
    expect(JSON.parse(String(seen[0]?.values[1]))).toEqual(questBody);
    expect(seen[0]?.values[2]).toBe(requestIdOf(response));
  });

  it("accepts an always-on quest with a null campaign", async () => {
    const { seen } = build();
    const response = await send("POST", "/quests", { ...questBody, campaignId: null });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(seen[0]?.values[1]))).toMatchObject({ campaignId: null });
  });

  it("replaces the named quest from the patch, which never carries a campaign", async () => {
    const saved = { id: QUEST, status: "active" };
    const { seen } = build(saved);
    const response = await send("PUT", `/quests/${QUEST}`, questPatch);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quest: saved });
    expect(seen[0]?.values[0]).toBe(QUEST);
    expect(JSON.parse(String(seen[0]?.values[1]))).toEqual(questPatch);
    expect(seen[0]?.values[2]).toBe(requestIdOf(response));
    const moved = await send("PUT", `/quests/${QUEST}`, questBody, {
      ...SIGNED_IN,
      "idempotency-key": "key-2",
    });
    expect(moved.statusCode).toBe(400);
  });

  it("retires a quest by id with the request id", async () => {
    const saved = { id: QUEST, status: "retired" };
    const { seen } = build(saved);
    const response = await send("POST", `/quests/${QUEST}/retire`, {});
    expect(response.json()).toEqual({ quest: saved });
    expect(seen).toEqual([
      {
        sql: "SELECT questify_quest_retire($1, $2) AS r",
        values: [QUEST, requestIdOf(response)],
      },
    ]);
  });

  it.each([
    ["a target of 0", { target: 0 }],
    ["a target of 1001", { target: 1001 }],
    ["an xp of 0", { xp: 0 }],
    ["an xp of 10001", { xp: 10001 }],
    ["a position of 0", { position: 0 }],
    ["a position of 1001", { position: 1001 }],
    ["a status of retired", { status: "retired" }],
    ["a metric outside the closed list", { metric: "points" }],
    ["a fractional target", { target: 1.5 }],
  ])("answers 400 for %s", async (_label, change) => {
    const { seen } = build();
    const response = await send("POST", "/quests", { ...questBody, ...change });
    expect(response.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it.each([
    ["a target of 1000", { target: 1000 }],
    ["an xp of 10000", { xp: 10000 }],
    ["a position of 1000", { position: 1000 }],
    ["a target of 1", { target: 1 }],
    ["an active status", { status: "active" }],
  ])("accepts %s", async (_label, change) => {
    build();
    const response = await send("POST", "/quests", { ...questBody, ...change });
    expect(response.statusCode).toBe(201);
  });

  describe('"set your interests" (T-407c)', () => {
    const interests = { ...questBody, metric: "interests_set", target: 1, campaignId: null };

    it("creates an always-on quest with a target of 1 and replaces one", async () => {
      const { seen } = build();
      expect((await send("POST", "/quests", interests)).statusCode).toBe(201);
      const { campaignId: _campaign, ...patch } = interests;
      const replaced = await send("PUT", `/quests/${QUEST}`, patch, {
        ...SIGNED_IN,
        "idempotency-key": "key-2",
      });
      expect(replaced.statusCode).toBe(200);
      expect(seen.map((one) => JSON.parse(String(one.values[1])))).toEqual([interests, patch]);
    });

    it.each([
      ["a target of 2 on create", "POST", "/quests", { ...interests, target: 2 }, "target"],
      ["a campaign on create", "POST", "/quests", { ...interests, campaignId: CAMPAIGN }, "metric"],
      [
        "a target of 2 on replace",
        "PUT",
        `/quests/${QUEST}`,
        { ...questPatch, metric: "interests_set", target: 2 },
        "target",
      ],
    ] as const)(
      "answers 422 with the field for %s, asking nothing",
      async (_l, method, url, body, field) => {
        const { seen } = build();
        const response = await send(method, url, body);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: "invalid_questify", details: { field } });
        expect(seen).toEqual([]);
      },
    );

    it("leaves another metric's target and campaign alone", async () => {
      build();
      const response = await send("POST", "/quests", { ...questBody, metric: "cities", target: 2 });
      expect(response.statusCode).toBe(201);
    });
  });

  it("answers 400 for a quest id that is not a UUID", async () => {
    const { seen } = build();
    const response = await send("POST", "/quests/7/retire", {});
    expect(response.statusCode).toBe(400);
    expect(seen).toEqual([]);
  });
});
