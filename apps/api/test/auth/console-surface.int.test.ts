import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateToken, hashToken } from "#src/auth/keys";
import {
  CONSOLE_ORIGIN,
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  consoleHeaders,
  createStaff,
  freshIp,
  sessionCookieOf,
  signInConsole,
  signInFully,
  startApp,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const tokenOf = (cookie: string) => cookie.slice("__Host-qs_session=".length);

/**
 * The console on its own host, over HTTP (T-810d, ADR-720, ADR-721, plan review 86 item 1): only an admin's sign-in
 * on the console origin opens a console session, `/v1/admin/*` takes nothing else, every cookie request carries its
 * own session's origin, and a request from the other host is refused before any session is looked up, so it never
 * refreshes the idle clock.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the console's own host (T-810d)", () => {
  let db: TestDatabase;
  let test: TestApp;
  const lines: Record<string, unknown>[] = [];
  let organizer = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(
      db,
      { level: "warn", stream: { write: (line: string) => void lines.push(JSON.parse(line)) } },
      { consoleOrigin: CONSOLE_ORIGIN },
    );
    const adminId = await createStaff(db.owner, { email: "root@surface.test", admin: true });
    await createStaff(db.owner, { email: "member@surface.test" });
    await createStaff(db.owner, { email: "other@surface.test", admin: true });
    await createStaff(db.owner, { email: "cookie@surface.test", admin: true });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Surface Co', 'surface-co') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, adminId],
    );
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const rowOf = async (cookie: string) =>
    (
      await db.owner.query<{ surface: string; last_seen_at: Date; revoked_at: Date | null }>(
        `SELECT surface, last_seen_at, revoked_at FROM staff_session
         WHERE token_hash = decode($1, 'hex')`,
        [hashToken(tokenOf(cookie))],
      )
    ).rows[0];
  /** A console session of the other admin, idle for five minutes, so any lookup would touch it. */
  const idleConsoleSession = async (): Promise<string> => {
    const { token, hash } = generateToken();
    await db.owner.query(
      `INSERT INTO staff_session (staff_user_id, token_hash, surface, created_at, last_seen_at)
       SELECT id, decode($1, 'hex'), 'console', now() - interval '5 minutes', now() - interval '5 minutes'
       FROM staff_user WHERE email = 'other@surface.test'`,
      [hash],
    );
    return `__Host-qs_session=${token}`;
  };
  const get = (url: string, headers: Record<string, string>) =>
    test.app.inject({ method: "GET", url, headers });
  const post = (url: string, headers: Record<string, string>) =>
    test.app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": randomUUID(), ...headers },
      payload: {},
    });

  describe("the console's cookie and answers", () => {
    it("sets a host-only __Host- cookie on the console sign-in and sends no CORS header", async () => {
      const first = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/password",
        headers: consoleHeaders(),
        payload: { email: "cookie@surface.test", password: PASSWORD },
      });
      const { challengeToken } = first.json<{ challengeToken: string }>();
      const done = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/code",
        headers: consoleHeaders(),
        payload: { challengeToken, code: test.mail.lastCode("cookie@surface.test") },
      });
      const cookie = String(done.headers["set-cookie"]);
      expect(cookie).toMatch(/^__Host-qs_session=[^;]+; /);
      expect(cookie).not.toMatch(/domain=/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/Secure/);
      const read = await get(
        "/v1/admin/activation-requests",
        consoleHeaders({ cookie: sessionCookieOf(done) }),
      );
      expect(read.statusCode).toBe(200);
      expect(
        Object.keys(read.headers).filter((name) => name.startsWith("access-control-")),
      ).toEqual([]);
      expect(read.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    });
  });

  describe("which session a sign-in opens", () => {
    it("opens a console session only for an admin signing in on the console origin", async () => {
      expect((await rowOf(await signInConsole(test, "root@surface.test")))?.surface).toBe(
        "console",
      );
      expect((await rowOf(await signInFully(test, "root@surface.test")))?.surface).toBe(
        "dashboard",
      );
      expect((await rowOf(await signInConsole(test, "member@surface.test")))?.surface).toBe(
        "dashboard",
      );
    });

    it("opens a dashboard session for a sign-in with no Origin", async () => {
      const first = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/password",
        headers: { "x-forwarded-for": freshIp() },
        payload: { email: "root@surface.test", password: PASSWORD },
      });
      const { challengeToken } = first.json<{ challengeToken: string }>();
      const done = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/code",
        headers: { "x-forwarded-for": freshIp() },
        payload: { challengeToken, code: test.mail.lastCode("root@surface.test") },
      });
      expect(done.statusCode).toBe(200);
      expect((await rowOf(sessionCookieOf(done)))?.surface).toBe("dashboard");
    });
  });

  describe("the doors", () => {
    let consoleCookie = "";
    let dashboardCookie = "";
    beforeAll(async () => {
      consoleCookie = await signInConsole(test, "root@surface.test");
      dashboardCookie = await signInFully(test, "root@surface.test");
    });

    it("refuses an active admin's dashboard session on the console, logged as wrong_surface", async () => {
      lines.length = 0;
      const read = await get(
        "/v1/admin/activation-requests",
        consoleHeaders({ cookie: dashboardCookie }),
      );
      expect(read.statusCode).toBe(404);
      expect(
        (
          await post(
            "/v1/admin/events/" + randomUUID() + "/support",
            consoleHeaders({ cookie: dashboardCookie }),
          )
        ).statusCode,
      ).toBe(404);
      const denied = lines.filter((line) => line["event"] === "authz.denied");
      expect(denied).toHaveLength(2);
      expect(denied[0]).toMatchObject({ status: 404, reason: "wrong_surface", actorKind: "staff" });
      expect(
        (await get("/v1/admin/activation-requests", consoleHeaders({ cookie: consoleCookie })))
          .statusCode,
      ).toBe(200);
    });

    it("takes each session only with its own origin", async () => {
      const wrongForConsole = await post(
        "/v1/admin/events/" + randomUUID() + "/support",
        browserHeaders({ cookie: consoleCookie }),
      );
      expect(wrongForConsole.statusCode).toBe(403);
      expect(wrongForConsole.json()).toMatchObject({ code: "csrf_rejected" });
      const wrongForDashboard = await post(
        "/v1/staff/auth/sign-out",
        consoleHeaders({ cookie: dashboardCookie }),
      );
      expect(wrongForDashboard.statusCode).toBe(403);
      expect(wrongForDashboard.json()).toMatchObject({ code: "csrf_rejected" });
      expect((await rowOf(dashboardCookie))?.revoked_at).toBeNull();
    });

    it("keeps a console session out of the dashboard, even for a member, but lets it read /v1/staff/me", async () => {
      const events = `/v1/organizers/${organizer}/events`;
      // From the console origin the dashboard door refuses before the lookup; from its own, the surface refuses.
      expect((await get(events, consoleHeaders({ cookie: consoleCookie }))).statusCode).toBe(403);
      expect((await get(events, browserHeaders({ cookie: consoleCookie }))).statusCode).toBe(404);
      expect((await get(events, browserHeaders({ cookie: dashboardCookie }))).statusCode).toBe(200);
      expect(
        (await get("/v1/staff/me", consoleHeaders({ cookie: consoleCookie }))).statusCode,
      ).toBe(200);
    });
  });

  describe("a request from the other host never reaches the session (review 86, item 1)", () => {
    it("refuses a same-site read of the console and leaves last_seen_at where it was", async () => {
      const consoleCookie = await idleConsoleSession();
      const before = await rowOf(consoleCookie);
      for (const headers of [
        { cookie: consoleCookie, "sec-fetch-site": "same-site", origin: DASHBOARD_ORIGIN },
        { cookie: consoleCookie, "sec-fetch-site": "same-site" },
        { cookie: consoleCookie, origin: DASHBOARD_ORIGIN },
        { cookie: consoleCookie, "sec-fetch-site": "cross-site" },
      ]) {
        const response = await get("/v1/admin/players/search?q=sara", {
          "x-forwarded-for": freshIp(),
          ...headers,
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: "csrf_rejected" });
      }
      const staffRead = await get("/v1/staff/me", {
        cookie: consoleCookie,
        "sec-fetch-site": "same-site",
        origin: DASHBOARD_ORIGIN,
      });
      expect(staffRead.statusCode).toBe(403);
      expect((await rowOf(consoleCookie))?.last_seen_at).toEqual(before?.last_seen_at);
    });

    it("refuses a forged write without touching the session", async () => {
      const consoleCookie = await idleConsoleSession();
      const before = await rowOf(consoleCookie);
      for (const headers of [
        { cookie: consoleCookie, origin: "https://evil.example" },
        { cookie: consoleCookie },
        { cookie: consoleCookie, origin: CONSOLE_ORIGIN, "sec-fetch-site": "same-site" },
      ]) {
        const response = await post("/v1/admin/events/" + randomUUID() + "/support", headers);
        expect(response.statusCode).toBe(403);
      }
      const signOut = await post("/v1/staff/auth/sign-out", {
        cookie: consoleCookie,
        origin: "https://evil.example",
      });
      expect(signOut.statusCode).toBe(403);
      const after = await rowOf(consoleCookie);
      expect(after?.last_seen_at).toEqual(before?.last_seen_at);
      expect(after?.revoked_at).toBeNull();
    });

    it("still answers the console host's own same-origin read, which touches the session", async () => {
      const consoleCookie = await idleConsoleSession();
      const before = await rowOf(consoleCookie);
      const response = await get(
        "/v1/admin/activation-requests",
        consoleHeaders({ cookie: consoleCookie, "sec-fetch-site": "same-origin" }),
      );
      expect(response.statusCode).toBe(200);
      expect((await rowOf(consoleCookie))?.last_seen_at.getTime()).toBeGreaterThan(
        before?.last_seen_at.getTime() ?? Number.POSITIVE_INFINITY,
      );
    });
  });

  const consoleRoutes = () =>
    test.app.routeInventory.filter((route) => route.method !== "HEAD" && route.access === "admin");

  describe("every /v1/admin/ route (the route inventory, so a new console route cannot skip it)", () => {
    const MISSING = "00000000-0000-4000-8000-000000000000";
    const call = (route: { method: string; url: string }, headers: Record<string, string>) =>
      test.app.inject({
        method: route.method as "GET" | "POST" | "PUT" | "DELETE",
        url: route.url.replace(/:[a-zA-Z]+/g, MISSING),
        headers: { "idempotency-key": MISSING, ...headers },
        ...(route.method === "GET" ? {} : { payload: {} }),
      });

    it("answers the public origin, or a same-site fetch, 403 before any session", async () => {
      expect(consoleRoutes().length).toBeGreaterThanOrEqual(8);
      for (const route of consoleRoutes()) {
        for (const headers of [
          browserHeaders(),
          consoleHeaders({ "sec-fetch-site": "same-site" }),
        ]) {
          const response = await call(route, headers);
          expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
          expect(response.json()).toMatchObject({ code: "csrf_rejected" });
        }
      }
    });

    it("refuses an active admin's dashboard session with 404 and lets the console session through", async () => {
      await createStaff(db.owner, { email: "two-hosts@surface.test", admin: true });
      const dashboard = await signInFully(test, "two-hosts@surface.test");
      const consoleSeat = await signInConsole(test, "two-hosts@surface.test");
      for (const route of consoleRoutes()) {
        const response = await call(route, consoleHeaders({ cookie: dashboard }));
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
      }
      const queue = await get(
        "/v1/admin/activation-requests",
        consoleHeaders({ cookie: consoleSeat }),
      );
      expect(queue.statusCode).toBe(200);
    });

    it("answers an outsider from the console host 401", async () => {
      for (const route of consoleRoutes()) {
        const response = await call(route, consoleHeaders());
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
      }
    });
  });
});

/**
 * With no console host configured (`CONSOLE_ORIGIN` unset), everything is as before T-810d: an admin signed in on the
 * dashboard reads and writes the console from the dashboard's origin, and a same-site fetch is not refused.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("no console host configured (T-810d)", () => {
  let db: TestDatabase;
  let test: TestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "root@unsplit.test", admin: true });
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("lets a dashboard session use the console from the dashboard's origin", async () => {
    const cookie = await signInFully(test, "root@unsplit.test");
    const read = await test.app.inject({
      url: "/v1/admin/activation-requests",
      headers: browserHeaders({ cookie, "sec-fetch-site": "same-site" }),
    });
    expect(read.statusCode).toBe(200);
    const write = await test.app.inject({
      method: "POST",
      url: `/v1/admin/events/${randomUUID()}/support`,
      headers: browserHeaders({ cookie, "idempotency-key": randomUUID() }),
      payload: {},
    });
    // Past the origin and session checks: whatever the route says about an unknown event, it is not the guard's 403.
    expect(write.statusCode).not.toBe(403);
    const surface = await db.owner.query<{ surface: string }>(
      "SELECT surface FROM staff_session WHERE token_hash = decode($1, 'hex')",
      [hashToken(tokenOf(cookie))],
    );
    expect(surface.rows[0]?.surface).toBe("dashboard");
  });

  it("refuses a sign-in step from any other origin, the would-be console one included", async () => {
    const first = await test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/password",
      headers: consoleHeaders(),
      payload: { email: "root@unsplit.test", password: PASSWORD },
    });
    expect(first.statusCode).toBe(403);
  });
});
