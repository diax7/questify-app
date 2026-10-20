import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserHeaders,
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

/**
 * The outsider and cross-tenant suites on the HTTP routes (T-012). Every route must appear in ROUTES with how it
 * keeps one caller out of another's data; a new route fails the first test until that is decided and proven.
 */
const ROUTES: Readonly<Record<string, string>> = {
  "GET /healthz": "no data: process liveness",
  "GET /readyz": "no data: database reachability",
  "GET /v1/translations": "no tenant data: the same platform texts for everyone",
  "GET /v1/config": "another organizer's private event answers like a missing one (tested below)",
  "POST /v1/staff/auth/password":
    "sign-in step; answers the same for every account (test/auth/sign-in)",
  "POST /v1/staff/auth/code": "sign-in step; bound to its own challenge token (test/auth/sign-in)",
  "POST /v1/staff/auth/resend":
    "sign-in step; bound to its own challenge token (test/auth/sign-in)",
  "GET /v1/staff/me": "only the caller's own account and memberships (tested below)",
  "GET /v1/staff/sessions": "only the caller's own sessions (tested below)",
  "DELETE /v1/staff/sessions/:id":
    "another person's session answers 404 and stays live (tested below)",
  "POST /v1/staff/auth/sign-out": "ends only the caller's own session (tested below)",
  "POST /v1/staff/auth/reset/request":
    "names no account: the same 202 for every email; the link goes only to the account's own mailbox (test/auth/password-reset)",
  "POST /v1/staff/auth/reset/confirm":
    "bound to the one link its secret token opens (test/auth/password-reset, test/db/password-reset)",
  "POST /v1/staff/password":
    "changes only the caller's own password, after their current one (test/auth/password-reset)",
};

const PUBLIC_ROUTES = [
  "GET /healthz",
  "GET /readyz",
  "GET /v1/config",
  "GET /v1/translations",
  "POST /v1/staff/auth/code",
  "POST /v1/staff/auth/password",
  "POST /v1/staff/auth/resend",
  "POST /v1/staff/auth/reset/confirm",
  "POST /v1/staff/auth/reset/request",
];

const MISSING = "00000000-0000-4000-8000-000000000000";

/** An error answer without its request id, which differs on every request. */
const shape = (body: string) => {
  const { requestId: _requestId, ...rest } = JSON.parse(body) as Record<string, unknown>;
  return rest;
};

describe.skipIf(TEST_DATABASE_URL === undefined)("route isolation", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const routes = (access?: "public" | "staff") =>
    test.app.routeInventory.filter(
      (route) => route.method !== "HEAD" && (access === undefined || route.access === access),
    );

  const sessionIdsOf = async (staffUserId: string): Promise<string[]> =>
    (
      await db.owner.query<{ id: string }>(
        "SELECT id FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL",
        [staffUserId],
      )
    ).rows.map((row) => row.id);

  const stillSignedIn = async (cookie: string) =>
    (await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookie) })).statusCode;

  describe("every route is accounted for", () => {
    it("lists each route with how it keeps callers apart", () => {
      expect(
        routes()
          .map((route) => `${route.method} ${route.url}`)
          .toSorted(),
      ).toEqual(Object.keys(ROUTES).toSorted());
    });

    it("has exactly these public routes and nothing else open", () => {
      expect(
        routes("public")
          .map((route) => `${route.method} ${route.url}`)
          .toSorted(),
      ).toEqual(PUBLIC_ROUTES);
    });

    it("keeps staff routes under /v1/staff, where the session check runs", () => {
      for (const route of routes("staff")) {
        expect(route.url.startsWith("/v1/staff/"), route.url).toBe(true);
      }
    });
  });

  describe("outsider (no session)", () => {
    it("answers 401 with no-store on every staff route", async () => {
      const closed = routes("staff");
      expect(closed.length).toBeGreaterThanOrEqual(4);
      for (const route of closed) {
        const response = await test.app.inject({
          method: route.method as "GET" | "POST" | "DELETE",
          url: route.url.replace(":id", MISSING),
          headers: browserHeaders(),
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("cannot tell another organizer's private event from one that does not exist", async () => {
      const hidden = await test.app.inject({ url: `/v1/config?event=${ids.eventB}` });
      const missing = await test.app.inject({ url: `/v1/config?event=${MISSING}` });
      expect(hidden.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(shape(hidden.body)).toEqual(shape(missing.body));
    });
  });

  describe("one staff member against another", () => {
    let cookieA = "";
    let cookieB = "";
    let staffA = "";
    let staffB = "";

    beforeAll(async () => {
      staffA = await createStaff(db.owner, { email: "owner@najd.test" });
      staffB = await createStaff(db.owner, { email: "owner@tabuk.test" });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
        [ids.orgA, staffA, ids.orgB, staffB],
      );
      cookieA = await signInFully(test, "owner@najd.test");
      cookieB = await signInFully(test, "owner@tabuk.test");
    });

    it("shows A only A's account and organizer", async () => {
      const me = await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookieA) });
      expect(me.statusCode).toBe(200);
      const body = me.json<{ id: string; memberships: { organizerId: string }[] }>();
      expect(body.id).toBe(staffA);
      expect(body.memberships.map((membership) => membership.organizerId)).toEqual([ids.orgA]);
      expect(me.body).not.toContain(staffB);
      expect(me.body).not.toContain(ids.orgB);
    });

    it("lists only A's own sessions", async () => {
      const list = await test.app.inject({
        url: "/v1/staff/sessions",
        headers: withSession(cookieA),
      });
      expect(list.statusCode).toBe(200);
      const listed = list.json<{ sessions: { id: string }[] }>().sessions.map((s) => s.id);
      expect(listed.toSorted()).toEqual((await sessionIdsOf(staffA)).toSorted());
      for (const id of await sessionIdsOf(staffB)) {
        expect(list.body).not.toContain(id);
      }
    });

    it("cannot end B's session: 404 like a missing one, and B stays signed in", async () => {
      const [sessionB] = await sessionIdsOf(staffB);
      expect(sessionB).toBeDefined();
      const attempt = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${sessionB}`,
        headers: withSession(cookieA),
      });
      const missing = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${MISSING}`,
        headers: withSession(cookieA),
      });
      expect(attempt.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(shape(attempt.body)).toEqual(shape(missing.body));
      expect(await stillSignedIn(cookieB)).toBe(200);
    });

    it("signing out ends only A's own session", async () => {
      const out = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/sign-out",
        headers: withSession(cookieA),
      });
      expect(out.statusCode).toBe(204);
      expect(await stillSignedIn(cookieA)).toBe(401);
      expect(await stillSignedIn(cookieB)).toBe(200);
    });
  });
});
