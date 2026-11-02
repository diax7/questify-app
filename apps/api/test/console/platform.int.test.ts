import { randomUUID } from "node:crypto";
import {
  adminAccountsSchema,
  adminSessionsSchema,
  healthViewSchema,
  platformNumbersSchema,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Method = "GET" | "POST";

/**
 * The console's platform pages over HTTP (T-709): health (FR-1783), numbers (FR-1419) and the admin accounts with their
 * sessions and the forced sign-out (FR-1785). Admin-only reads (404 to everyone else), the reads of staff emails and
 * sessions audited with ids only, and a forced sign-out that ends the other session at once.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console platform pages over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminId: string;
  let nightId: string;
  let memberId: string;
  let adminCookie: string;
  let nightCookie: string;
  let memberCookie: string;
  let strangerCookie: string;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const sessionIdsOf = async (user: string) =>
    (
      await owner<{ id: string }>(
        "SELECT id FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL ORDER BY created_at",
        [user],
      )
    ).map((row) => row.id);
  const lastAudit = async (action: string) =>
    (
      await owner<{
        actor_type: string;
        actor_id: string;
        target_id: string | null;
        after: unknown;
      }>(
        "SELECT actor_type, actor_id, target_id, after FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1",
        [action],
      )
    )[0];

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    adminId = await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    nightId = await createStaff(db.owner, { email: "night@questify.test", admin: true });
    memberId = await createStaff(db.owner, { email: "owner@najd.test" });
    await createStaff(db.owner, { email: "stranger@najd.test" });
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd') RETURNING id",
    );
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org?.id, memberId],
    );
    adminCookie = await signInFully(test, "admin@questify.test");
    nightCookie = await signInFully(test, "night@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
    strangerCookie = await signInFully(test, "stranger@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const reason = "Laptop lost at the airport";

  describe("who may ask", () => {
    it("answers 404 to a member, a stranger and a platform admin's pages alike, and 401 to nobody signed in", async () => {
      const [mySession] = await sessionIdsOf(memberId);
      const paths: [Method, string, object?][] = [
        ["GET", "/v1/admin/health"],
        ["GET", "/v1/admin/numbers"],
        ["GET", "/v1/admin/admins"],
        ["GET", `/v1/admin/admins/${adminId}/sessions`],
        ["POST", `/v1/admin/sessions/${mySession}/end`, { reason }],
      ];
      for (const cookie of [memberCookie, strangerCookie]) {
        for (const [method, url, payload] of paths) {
          expect((await call(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(
            404,
          );
        }
      }
      for (const [method, url, payload] of paths) {
        const anonymous = await test.app.inject({
          method,
          url,
          headers: { "idempotency-key": randomUUID() },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(anonymous.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(401);
        expect(anonymous.statusCode, `${method} ${url}`).toBeLessThanOrEqual(403);
      }
      expect(await sessionIdsOf(memberId)).toEqual([mySession]);
    });
  });

  describe("health and numbers", () => {
    it("answer six tiles from the database and this server's set-up, never cached", async () => {
      const answer = await call("GET", "/v1/admin/health", adminCookie);
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toMatch(/no-store/);
      const view = healthViewSchema.parse(answer.json());
      expect(view.tiles.map((tile) => tile.key)).toEqual([
        "database",
        "events",
        "push",
        "sms",
        "email",
        "background",
      ]);
      const tile = (key: string) => view.tiles.find((candidate) => candidate.key === key);
      expect(tile("database")?.state).toBe("ok");
      expect(tile("sms")?.facts.find((fact) => fact.key === "smsSetUp")?.value).toBe(1);
      expect(tile("sms")?.facts.find((fact) => fact.key === "promoSetUp")?.value).toBe(0);
      expect(tile("push")?.reasons).toContain("notSetUp");
      expect(tile("email")?.facts.find((fact) => fact.key === "alertEmailSetUp")?.value).toBe(0);
      expect(JSON.stringify(view)).not.toMatch(/password|secret|api_?key|@/i);
    });

    it("show a stuck push as a down tile", async () => {
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('push_player') RETURNING id",
      );
      const [device] = await owner<{ id: string }>(
        `INSERT INTO push_device (player_id, family, platform, token, language, app_version)
         VALUES ($1, gen_random_uuid(), 'android', 'tok_${randomUUID().replaceAll("-", "")}', 'en', '1.0.0') RETURNING id`,
        [player?.id],
      );
      await owner("SET session_replication_role = replica");
      await owner(
        `INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at, state, lease_token, lease_until)
         VALUES (2, $1, 2, 'fcm', 0, now() + interval '1 day', 'sending', gen_random_uuid(), now() - interval '20 minutes')`,
        [device?.id],
      );
      await owner("SET session_replication_role = origin");
      const view = healthViewSchema.parse(
        (await call("GET", "/v1/admin/health", adminCookie)).json(),
      );
      const push = view.tiles.find((tile) => tile.key === "push");
      expect(push?.state).toBe("down");
      expect(push?.reasons).toContain("stuck");
    });

    it("count the platform and keep players out of the answer", async () => {
      const answer = await call("GET", "/v1/admin/numbers", adminCookie);
      expect(answer.statusCode).toBe(200);
      const numbers = platformNumbersSchema.parse(answer.json());
      expect(numbers.staff).toEqual({ accounts: 4, admins: 2 });
      expect(numbers.organizers.active + numbers.organizers.pending).toBe(1);
      expect(JSON.stringify(numbers)).not.toMatch(/push_player/);
    });
  });

  describe("admin accounts and sessions", () => {
    it("list the platform admins with their open sessions and audit the read with ids only", async () => {
      const answer = await call("GET", "/v1/admin/admins", adminCookie);
      expect(answer.statusCode).toBe(200);
      const { admins } = adminAccountsSchema.parse(answer.json());
      expect(admins.map((row) => [row.email, row.status, row.sessions])).toEqual([
        ["admin@questify.test", "active", 1],
        ["night@questify.test", "active", 1],
      ]);
      expect(JSON.stringify(answer.json())).not.toMatch(/hash|password|owner@najd/);
      expect(await lastAudit("console.admins_read")).toMatchObject({
        actor_type: "admin",
        actor_id: adminId,
        after: { adminIds: [adminId, nightId] },
      });
    });

    it("list one admin's sessions, marking the caller's own, and audit the read", async () => {
      const mine = adminSessionsSchema.parse(
        (await call("GET", `/v1/admin/admins/${adminId}/sessions`, adminCookie)).json(),
      );
      expect(mine.sessions).toHaveLength(1);
      expect(mine.sessions[0]).toMatchObject({ current: true });
      const theirs = adminSessionsSchema.parse(
        (await call("GET", `/v1/admin/admins/${nightId}/sessions`, adminCookie)).json(),
      );
      expect(theirs.sessions.map((row) => row.current)).toEqual([false]);
      expect(await lastAudit("console.admin_sessions_read")).toMatchObject({
        actor_id: adminId,
        target_id: nightId,
      });
    });

    it("answer 404 for a member's or an unknown account, and 4xx for a malformed id", async () => {
      for (const id of [memberId, randomUUID()]) {
        expect((await call("GET", `/v1/admin/admins/${id}/sessions`, adminCookie)).statusCode).toBe(
          404,
        );
      }
      expect(
        (await call("GET", "/v1/admin/admins/not-an-id/sessions", adminCookie)).statusCode,
      ).toBeGreaterThanOrEqual(400);
    });

    it("end another admin's session at once: their next request is refused, and the reason is audited", async () => {
      const [nightSession] = await sessionIdsOf(nightId);
      expect((await call("GET", "/v1/admin/health", nightCookie)).statusCode).toBe(200);
      const ended = await call("POST", `/v1/admin/sessions/${nightSession}/end`, adminCookie, {
        reason,
      });
      expect(ended.statusCode).toBe(204);
      expect((await call("GET", "/v1/admin/health", nightCookie)).statusCode).toBe(401);
      expect(await sessionIdsOf(nightId)).toEqual([]);
      expect(await lastAudit("staff.session.force_end")).toMatchObject({
        actor_type: "admin",
        actor_id: adminId,
        target_id: nightSession,
        after: { reason, staffUserId: nightId },
      });
      const { admins } = adminAccountsSchema.parse(
        (await call("GET", "/v1/admin/admins", adminCookie)).json(),
      );
      expect(admins.find((row) => row.id === nightId)?.sessions).toBe(0);
    });

    it("end the same admin's other session but refuse to end the one asking", async () => {
      const second = await signInFully(test, "admin@questify.test");
      const sessions = await sessionIdsOf(adminId);
      expect(sessions).toHaveLength(2);
      const [first, other] = sessions;
      const own = await call("POST", `/v1/admin/sessions/${first}/end`, adminCookie, { reason });
      expect(own.statusCode).toBe(409);
      expect(own.json()).toMatchObject({ code: "own_session" });
      expect(await sessionIdsOf(adminId)).toHaveLength(2);
      expect(
        (await call("POST", `/v1/admin/sessions/${other}/end`, adminCookie, { reason })).statusCode,
      ).toBe(204);
      expect((await call("GET", "/v1/admin/health", second)).statusCode).toBe(401);
      expect((await call("GET", "/v1/admin/health", adminCookie)).statusCode).toBe(200);
    });

    it("refuse a short reason, an unknown or ended session and a member's session, and change nothing", async () => {
      const third = await signInFully(test, "night@questify.test");
      const [nightSession] = await sessionIdsOf(nightId);
      const [memberSession] = await sessionIdsOf(memberId);
      const short = await call("POST", `/v1/admin/sessions/${nightSession}/end`, adminCookie, {
        reason: "lost",
      });
      expect(short.statusCode).toBe(400);
      expect(short.json()).toMatchObject({ code: "invalid_reason" });
      for (const target of [randomUUID(), memberSession]) {
        expect(
          (await call("POST", `/v1/admin/sessions/${target}/end`, adminCookie, { reason }))
            .statusCode,
        ).toBe(404);
      }
      expect(
        (
          await call("POST", `/v1/admin/sessions/${nightSession}/end`, adminCookie, {
            extra: 1,
            reason,
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
      expect((await call("GET", "/v1/admin/health", third)).statusCode).toBe(200);
      expect(await sessionIdsOf(memberId)).toEqual([memberSession]);
    });
  });
});
