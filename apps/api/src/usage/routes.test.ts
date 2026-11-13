import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { registerConsoleUsageRoutes } from "#src/usage/routes";
import { fakePool } from "#test/support/fake-pool";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORGANIZER = "22222222-2222-4222-8222-222222222222";
const SIGNED_IN = { "x-test-admin": "yes" };

type Seen = { sql: string; values: readonly unknown[] };
let app: FastifyInstance;

/** The usage routes at the admin prefix over a pool answering every door with `answer` as its `r` column. */
function build(
  answer: unknown = { organizers: [] },
  fail?: { code: string },
  demo: unknown = { exists: false },
) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    if (fail !== undefined) throw Object.assign(new Error("refused"), fail);
    return { rows: [{ r: sql.includes("console_review_demo") ? demo : answer }] };
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-test-admin"] !== undefined) {
      request.staff = {
        account: { id: ADMIN } as PublicAccount,
        sessionId: "session-1",
        tokenHash: "",
        surface: "console",
      };
    }
  });
  app.register(async (scope) => registerConsoleUsageRoutes(scope, { pool }), {
    prefix: "/v1/admin",
  });
  return { seen };
}

const get = (url: string, headers: Record<string, string> = SIGNED_IN) =>
  app.inject({ method: "GET", url: `/v1/admin${url}`, headers });

afterEach(async () => {
  await app.close();
});

describe("GET /v1/admin/usage", () => {
  it("answers the door's list as the signed-in admin", async () => {
    const list = { organizers: [{ id: ORGANIZER, name: "Najd", events: 1, players: 2 }] };
    const { seen } = build(list);
    const response = await get("/usage");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(list);
    expect(seen.map((door) => door.sql)).toEqual([
      "SELECT usage_organizers() AS r",
      "SELECT console_review_demo() AS r",
    ]);
  });

  it("leaves out the organizer the review demo runs under (T-710)", async () => {
    const demo = "33333333-3333-4333-8333-333333333333";
    const list = {
      organizers: [
        { id: ORGANIZER, name: "Najd", events: 1, players: 2 },
        { id: demo, name: "Questify Review Demo", events: 1, players: 1 },
      ],
    };
    build(list, undefined, { exists: true, organizerId: demo });
    const response = await get("/usage");
    expect(response.json()).toEqual({ organizers: [list.organizers[0]] });
  });

  it("answers 404 and asks nothing when the request carries no staff member", async () => {
    const { seen } = build();
    expect((await get("/usage", {})).statusCode).toBe(404);
    expect((await get(`/usage/organizers/${ORGANIZER}`, {})).statusCode).toBe(404);
    expect(seen).toEqual([]);
  });

  it("answers 404 when the database says the caller is not an admin", async () => {
    build(undefined, { code: "US404" });
    expect((await get("/usage")).statusCode).toBe(404);
  });

  it("does not hide a server fault as a 404", async () => {
    build(undefined, { code: "XX000" });
    expect((await get("/usage")).statusCode).toBe(500);
  });
});

describe("GET /v1/admin/usage/organizers/:organizerId", () => {
  it("asks the door for that organizer's events", async () => {
    const usage = { organizer: { id: ORGANIZER, name: "Najd" }, events: [] };
    const { seen } = build(usage);
    const response = await get(`/usage/organizers/${ORGANIZER}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(usage);
    expect(seen).toEqual([{ sql: "SELECT usage_events($1) AS r", values: [ORGANIZER] }]);
  });

  it("refuses an id that is not a UUID before asking the database", async () => {
    const { seen } = build();
    expect((await get("/usage/organizers/not-an-id")).statusCode).toBe(400);
    expect(seen).toEqual([]);
  });

  it("answers 404 for an organizer the door does not know", async () => {
    build(undefined, { code: "US404" });
    expect((await get(`/usage/organizers/${ORGANIZER}`)).statusCode).toBe(404);
  });
});
