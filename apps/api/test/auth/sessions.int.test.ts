import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateToken } from "#src/auth/keys";
import { loggerOptions } from "#src/app";
import { createSessions } from "#src/auth/session";
import {
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  createStaff,
  postCode,
  postPassword,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const COOKIE_NAME = "__Host-qs_session";
const tokenOf = (cookie: string): string => cookie.split("=")[1] ?? "";

describe.skipIf(TEST_DATABASE_URL === undefined)("staff sessions", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const newEmail = (): string => {
    counter += 1;
    return `member${counter}@najd.sa`;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  /** Creates a session with a token we know and the given age, bypassing the sign-in steps. */
  const seedSession = async (
    staffUserId: string,
    ago: { idleMinutes?: number; ageMinutes?: number; revoked?: boolean } = {},
  ): Promise<{ cookie: string; id: string }> => {
    const { token, hash } = generateToken();
    const rows = await owner<{ id: string }>(
      `INSERT INTO staff_session (staff_user_id, token_hash, created_at, last_seen_at, revoked_at)
       VALUES ($1, decode($2, 'hex'),
               now() - make_interval(secs => $3), now() - make_interval(secs => $4),
               CASE WHEN $5 THEN now() ELSE NULL END)
       RETURNING id`,
      [
        staffUserId,
        hash,
        (ago.ageMinutes ?? ago.idleMinutes ?? 0) * 60,
        (ago.idleMinutes ?? 0) * 60,
        ago.revoked === true,
      ],
    );
    return { cookie: `${COOKIE_NAME}=${token}`, id: rows[0]?.id ?? "" };
  };

  const me = (cookie: string, extra: Record<string, string> = {}) =>
    test.app.inject({ method: "GET", url: "/v1/staff/me", headers: withSession(cookie, extra) });

  const stateOf = async (id: string) =>
    (
      await owner<{ revoked_at: Date | null; last_seen_at: Date }>(
        "SELECT revoked_at, last_seen_at FROM staff_session WHERE id = $1",
        [id],
      )
    )[0];

  describe("expiry", () => {
    it("accepts a session just under the idle limit and ends one just over it", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const fresh = await seedSession(user, { idleMinutes: 29 });
      expect((await me(fresh.cookie)).statusCode).toBe(200);

      const stale = await seedSession(user, { idleMinutes: 31 });
      const response = await me(stale.cookie);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "session_expired" });
      expect((await stateOf(stale.id))?.revoked_at).not.toBeNull();
      expect((await me(stale.cookie)).statusCode).toBe(401);
    });

    it("clears the cookie with the same attributes it was set with when the session has ended", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const stale = await seedSession(user, { idleMinutes: 45 });
      const header = String((await me(stale.cookie)).headers["set-cookie"]);
      expect(header).toMatch(/^__Host-qs_session=;/);
      for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=0"]) {
        expect(header).toContain(attribute);
      }
    });

    it("ends a session after its maximum age even if it was used a moment ago", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const old = await seedSession(user, { idleMinutes: 1, ageMinutes: 13 * 60 });
      expect((await me(old.cookie)).statusCode).toBe(401);
      const young = await seedSession(user, { idleMinutes: 1, ageMinutes: 11 * 60 });
      expect((await me(young.cookie)).statusCode).toBe(200);
    });

    it("gives platform admins shorter limits", async () => {
      const admin = await createStaff(db.owner, { email: newEmail(), admin: true });
      const regular = await createStaff(db.owner, { email: newEmail() });
      expect((await me((await seedSession(admin, { idleMinutes: 14 })).cookie)).statusCode).toBe(
        200,
      );
      expect((await me((await seedSession(admin, { idleMinutes: 16 })).cookie)).statusCode).toBe(
        401,
      );
      expect((await me((await seedSession(regular, { idleMinutes: 16 })).cookie)).statusCode).toBe(
        200,
      );
      expect(
        (await me((await seedSession(admin, { idleMinutes: 1, ageMinutes: 9 * 60 })).cookie))
          .statusCode,
      ).toBe(401);
    });

    it("applies the shorter admin limits the moment a user becomes an admin", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const session = await seedSession(user, { idleMinutes: 20 });
      await owner("UPDATE staff_user SET platform_role = 'admin' WHERE id = $1", [user]);
      expect((await me(session.cookie)).statusCode).toBe(401);
    });

    it("ends the session of an account that was disabled", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const session = await seedSession(user);
      expect((await me(session.cookie)).statusCode).toBe(200);
      await owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [user]);
      expect((await me(session.cookie)).statusCode).toBe(401);
      expect((await stateOf(session.id))?.revoked_at).not.toBeNull();
    });

    it("refuses a revoked session", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const session = await seedSession(user, { revoked: true });
      expect((await me(session.cookie)).statusCode).toBe(401);
    });

    it("writes last-seen at most once a minute", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const recent = await seedSession(user, { idleMinutes: 0.5 });
      const before = (await stateOf(recent.id))?.last_seen_at.getTime() ?? 0;
      await me(recent.cookie);
      expect((await stateOf(recent.id))?.last_seen_at.getTime()).toBe(before);

      const quiet = await seedSession(user, { idleMinutes: 5 });
      const quietBefore = (await stateOf(quiet.id))?.last_seen_at.getTime() ?? 0;
      await me(quiet.cookie);
      expect((await stateOf(quiet.id))?.last_seen_at.getTime()).toBeGreaterThan(quietBefore);
    });

    it("answers 401 for a cookie that is not a token at all", async () => {
      for (const value of ["", "x", "a".repeat(44), `${"a".repeat(42)}!`]) {
        expect((await me(`${COOKIE_NAME}=${value}`)).statusCode).toBe(401);
      }
    });
  });

  describe("what the session check answers", () => {
    it("says 'none' for a token that is not even shaped like one, without touching the database", async () => {
      const untouched = {
        connect: () => {
          throw new Error("the database must not be used");
        },
      } as unknown as Pool;
      for (const token of ["", "short", "a".repeat(44), `${"a".repeat(42)}!`]) {
        expect(await createSessions(untouched).authenticate(token)).toEqual({ kind: "none" });
      }
    });

    it("says 'none' for a well-formed token nobody holds", async () => {
      expect(await createSessions(test.pool).authenticate("A".repeat(43))).toEqual({
        kind: "none",
      });
    });

    it("says 'valid' with the account, and 'expired' for a revoked or stale session", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const live = await seedSession(user);
      const revoked = await seedSession(user, { revoked: true });
      const stale = await seedSession(user, { idleMinutes: 45 });
      const service = createSessions(test.pool);
      expect(await service.authenticate(tokenOf(live.cookie))).toMatchObject({
        kind: "valid",
        sessionId: live.id,
        account: { id: user, platformRole: "none", status: "active" },
      });
      expect(await service.authenticate(tokenOf(revoked.cookie))).toEqual({ kind: "expired" });
      expect(await service.authenticate(tokenOf(stale.cookie))).toEqual({ kind: "expired" });
    });

    it("answers a cookie that is not a session differently from a session that has ended", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const garbage = await me(`${COOKIE_NAME}=garbage`);
      expect(garbage.json()).toMatchObject({ code: "unauthenticated" });
      const unknown = await me(`${COOKIE_NAME}=${"A".repeat(43)}`);
      expect(unknown.json()).toMatchObject({ code: "unauthenticated" });
      const revoked = await me((await seedSession(user, { revoked: true })).cookie);
      expect(revoked.json()).toMatchObject({ code: "session_expired" });
      const nothing = await test.app.inject({
        method: "GET",
        url: "/v1/staff/me",
        headers: browserHeaders(),
      });
      expect(nothing.json()).toMatchObject({ code: "unauthenticated" });
    });
  });

  describe("signing out and the session list", () => {
    it("signs out: the session ends, the cookie is cleared, and the cookie no longer works", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const session = await seedSession(user);
      const response = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/sign-out",
        headers: withSession(session.cookie),
      });
      expect(response.statusCode).toBe(204);
      expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
      expect((await stateOf(session.id))?.revoked_at).not.toBeNull();
      expect((await me(session.cookie)).statusCode).toBe(401);
    });

    it("lists live sessions with the current one marked, and leaves out ended ones", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const current = await seedSession(user);
      const other = await seedSession(user, { idleMinutes: 3 });
      await seedSession(user, { revoked: true });
      await seedSession(user, { idleMinutes: 100 });
      const response = await test.app.inject({
        method: "GET",
        url: "/v1/staff/sessions",
        headers: withSession(current.cookie),
      });
      const { sessions } = response.json<{ sessions: Array<{ id: string; current: boolean }> }>();
      expect(sessions.map((session) => session.id).toSorted()).toEqual(
        [current.id, other.id].toSorted(),
      );
      expect(sessions.filter((session) => session.current).map((session) => session.id)).toEqual([
        current.id,
      ]);
    });

    it("ends another of the user's own sessions", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const current = await seedSession(user);
      const other = await seedSession(user);
      const response = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${other.id}`,
        headers: withSession(current.cookie),
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect((await me(other.cookie)).statusCode).toBe(401);
      expect((await me(current.cookie)).statusCode).toBe(200);
    });

    it("clears the cookie when the user ends their current session", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const current = await seedSession(user);
      const response = await test.app.inject({
        method: "DELETE",
        url: `/v1/staff/sessions/${current.id}`,
        headers: withSession(current.cookie),
      });
      expect(response.statusCode).toBe(204);
      expect(String(response.headers["set-cookie"])).toContain("Max-Age=0");
    });

    it("answers 404 for a session that is someone else's, unknown, or already ended", async () => {
      const mine = await createStaff(db.owner, { email: newEmail() });
      const theirs = await createStaff(db.owner, { email: newEmail() });
      const current = await seedSession(mine);
      const foreign = await seedSession(theirs);
      const ended = await seedSession(mine, { revoked: true });
      for (const id of [foreign.id, "00000000-0000-4000-8000-000000000000", ended.id]) {
        const response = await test.app.inject({
          method: "DELETE",
          url: `/v1/staff/sessions/${id}`,
          headers: withSession(current.cookie),
        });
        expect(response.statusCode).toBe(404);
      }
      expect((await me(foreign.cookie)).statusCode).toBe(200);
    });

    it("rejects a session id that is not a UUID", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const current = await seedSession(user);
      const response = await test.app.inject({
        method: "DELETE",
        url: "/v1/staff/sessions/not-a-uuid",
        headers: withSession(current.cookie),
      });
      expect(response.statusCode).toBe(400);
    });

    it("keeps at most ten live sessions, ending the oldest when an eleventh opens", async () => {
      const email = newEmail();
      const user = await createStaff(db.owner, { email });
      const seeded = [];
      for (let index = 0; index < 10; index += 1) {
        seeded.push(await seedSession(user, { idleMinutes: 10 - index, ageMinutes: 100 - index }));
      }
      const first = await postPassword(test, email);
      const done = await postCode(
        test,
        first.json<{ challengeToken: string }>().challengeToken,
        test.mail.lastCode(email),
      );
      expect(done.statusCode).toBe(200);
      const live = await owner(
        "SELECT id FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL",
        [user],
      );
      expect(live).toHaveLength(10);
      expect((await stateOf(seeded[0]?.id ?? ""))?.revoked_at).not.toBeNull();
      expect((await stateOf(seeded[9]?.id ?? ""))?.revoked_at).toBeNull();
    });

    it("ends every session of a user at once", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const sessions = [];
      for (let index = 0; index < 3; index += 1) {
        sessions.push(await seedSession(user));
      }
      const count = await createSessions(test.pool).revokeAll(user);
      expect(count).toBe(3);
      for (const session of sessions) {
        expect((await me(session.cookie)).statusCode).toBe(401);
      }
    });

    it("shows only the caller's own memberships", async () => {
      const first = await createStaff(db.owner, { email: newEmail() });
      const second = await createStaff(db.owner, { email: newEmail() });
      const org = await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Org One', 'org-one') RETURNING id",
      );
      const other = await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Org Two', 'org-two') RETURNING id",
      );
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
        [org[0]?.id, first, other[0]?.id, second],
      );
      const response = await me((await seedSession(first)).cookie);
      expect(response.json<{ memberships: Array<{ organizerId: string }> }>().memberships).toEqual([
        { organizerId: org[0]?.id, role: "owner", eventScope: null },
      ]);
    });
  });

  describe("cross-site requests", () => {
    it("refuses a state-changing cookie request without the dashboard's Origin", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const session = await seedSession(user);
      for (const origin of [
        undefined,
        "https://evil.example",
        `${DASHBOARD_ORIGIN}.evil.example`,
      ]) {
        const response = await test.app.inject({
          method: "POST",
          url: "/v1/staff/auth/sign-out",
          headers: {
            cookie: session.cookie,
            "x-forwarded-for": "198.51.100.1",
            ...(origin ? { origin } : {}),
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: "csrf_rejected" });
      }
      expect((await me(session.cookie)).statusCode).toBe(200);
    });

    it("lets a plain read through from any origin, and a sign-in step from no origin", async () => {
      const user = await createStaff(db.owner, { email: newEmail() });
      const session = await seedSession(user);
      expect((await me(session.cookie, { origin: "https://elsewhere.example" })).statusCode).toBe(
        200,
      );
      const noOrigin = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/password",
        headers: { "x-forwarded-for": "198.51.100.2" },
        payload: { email: "nobody@najd.sa", password: PASSWORD },
      });
      expect(noOrigin.statusCode).toBe(401);
    });

    it("refuses a sign-in step from a different origin", async () => {
      const response = await postPassword(test, "nobody@najd.sa", PASSWORD, {
        origin: "https://evil.example",
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("default deny", () => {
    it("lists exactly three public routes, the sign-in steps", () => {
      const open = test.app.staffRoutes.filter((route) => route.public);
      expect(open.map((route) => `${route.method} ${route.url}`).toSorted()).toEqual([
        "POST /v1/staff/auth/code",
        "POST /v1/staff/auth/password",
        "POST /v1/staff/auth/resend",
      ]);
    });

    it("answers 401 with no-store on every other staff route when there is no session", async () => {
      const closed = test.app.staffRoutes.filter(
        (route) => !route.public && route.method !== "HEAD",
      );
      expect(closed.length).toBeGreaterThanOrEqual(4);
      for (const route of closed) {
        const url = route.url.replace(":id", "00000000-0000-4000-8000-000000000000");
        const response = await test.app.inject({
          method: route.method as "GET" | "POST" | "DELETE",
          url,
          headers: browserHeaders(),
        });
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
    });

    it("puts only /v1/staff routes in the staff inventory", () => {
      for (const route of test.app.staffRoutes) {
        expect(route.url.startsWith("/v1/staff/")).toBe(true);
      }
    });
  });

  describe("what the logs hold", () => {
    it("records the sign-in events with the request id, and none of the secrets or addresses", async () => {
      const lines: string[] = [];
      const logged = await startApp(db, {
        ...loggerOptions(testConfig()),
        level: "debug",
        stream: { write: (line: string) => void lines.push(line) },
      });
      try {
        const email = newEmail();
        const password = "Zebra-Quartz-Unique-9981";
        const clientAddress = "198.51.100.77";
        const header = { "x-forwarded-for": clientAddress };
        await createStaff(db.owner, { email, password });
        const first = await postPassword(logged, email, password, header);
        const { challengeToken } = first.json<{ challengeToken: string }>();
        const done = await postCode(logged, challengeToken, logged.mail.lastCode(email), header);
        const cookieValue = String(done.headers["set-cookie"]).split(";")[0]?.split("=")[1] ?? "";
        await logged.app.inject({
          method: "GET",
          url: "/v1/staff/me",
          headers: withSession(`${COOKIE_NAME}=${cookieValue}`, header),
        });
        const text = lines.join("\n");
        expect(text).toContain("staff.password_ok");
        expect(text).toContain("staff.session_opened");
        expect(text).toMatch(/"addr":"[0-9a-f]{12}"/);
        expect(text).toContain(String(first.headers["x-request-id"]));
        for (const secret of [
          password,
          challengeToken,
          cookieValue,
          email,
          clientAddress,
          "127.0.0.1",
          "remoteAddress",
        ]) {
          expect(text, `log contains ${secret.slice(0, 8)}`).not.toContain(secret);
        }
      } finally {
        await logged.close();
      }
    });
  });
});
