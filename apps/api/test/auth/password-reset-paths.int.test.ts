import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerOptions } from "#src/app";
import type * as StoreModule from "#src/auth/staff-store";
import type * as GateModule from "#src/auth/verify-gate";
import { createAuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import {
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  createStaff,
  freshIp,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * The reset and change flows' rarer paths (T-020), with the log lines they leave: the verify gate full, a database
 * write failing after the answer, an unexpected breach-check error, a held lock, an email that cannot be sent.
 * Complements password-reset.int.test.ts, which covers the main behaviour.
 */
const control = vi.hoisted(() => ({ gateBusyOnce: false, insertFails: false }));

vi.mock("#src/auth/verify-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof GateModule>();
  return {
    ...actual,
    createVerifyGate: (options: { limit: number; waitMs: number }) => {
      const gate = actual.createVerifyGate(options);
      return {
        run: <T>(work: () => Promise<T>): Promise<T> => {
          if (control.gateBusyOnce) {
            control.gateBusyOnce = false;
            return Promise.reject(new actual.GateBusyError());
          }
          return gate.run(work);
        },
      };
    },
  };
});

vi.mock("#src/auth/staff-store", async (importOriginal) => {
  const actual = await importOriginal<typeof StoreModule>();
  return {
    ...actual,
    insertResetLink: (...args: Parameters<typeof actual.insertResetLink>) =>
      control.insertFails
        ? Promise.reject(new RangeError("told to fail"))
        : actual.insertResetLink(...args),
  };
});

const NEW_PASSWORD = "a brand new pass phrase 77";

type Line = Readonly<Record<string, unknown>>;

describe.skipIf(TEST_DATABASE_URL === undefined)("password reset and change, rarer paths", () => {
  let db: TestDatabase;
  let test: TestApp;
  let lines: string[] = [];
  let counter = 0;
  const newEmail = (): string => {
    counter += 1;
    return `paths${counter}@najd.sa`;
  };
  const keys = createAuthKeys(testConfig().auth.secret);

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });
  beforeEach(() => {
    lines = [];
    control.gateBusyOnce = false;
    control.insertFails = false;
  });

  /** The structured events logged since the test began, by name. */
  const events = (name: string): Line[] =>
    lines
      .map((line) => JSON.parse(line) as Line)
      .filter((line) => line["event"] === name)
      .map(
        ({ event: _event, level: _l, time: _t, pid: _p, hostname: _h, reqId: _r, ...rest }) => rest,
      );

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  const requestReset = async (
    email: string,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> => {
    const response = await test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/reset/request",
      headers: browserHeaders(headers),
      payload: { email, lang: "en" },
    });
    await test.deferred.idle();
    return response;
  };

  const linkToken = (email: string): string => {
    const text = test.mail.to(email).at(-1)?.text ?? "";
    return /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? "";
  };

  const confirm = (token: string, newPassword = NEW_PASSWORD) =>
    test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/reset/confirm",
      headers: browserHeaders(),
      payload: { token, newPassword },
    });

  const change = (cookie: string, currentPassword: string, newPassword = NEW_PASSWORD) =>
    test.app.inject({
      method: "POST",
      url: "/v1/staff/password",
      headers: withSession(cookie),
      payload: { currentPassword, newPassword },
    });

  const failures = async (email: string): Promise<number> =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1 AND key = $2",
        [BUCKETS.failEmail, keys.emailKey(email)],
      )
    )[0]?.n ?? -1;

  const linksOf = async (email: string): Promise<number> =>
    (
      await owner<{ n: number }>(
        `SELECT count(*)::int AS n FROM staff_password_reset r
         JOIN staff_user u ON u.id = r.staff_user_id WHERE u.email = $1`,
        [email],
      )
    )[0]?.n ?? -1;

  describe("asking for a link", () => {
    it("logs the link sent with the user id, and says it works for 30 minutes", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      await requestReset(email);
      expect(events("staff.reset_sent")).toEqual([{ addr: expect.any(String), user: id }]);
      expect(test.mail.to(email).at(-1)?.text).toContain("The link works once, for 30 minutes.");
      expect(events("staff.reset_failed")).toEqual([]);
    });

    it("leaves no failure behind for an unknown email or text that is not an email", async () => {
      await requestReset("nobody.here@najd.sa");
      await requestReset("not an email");
      expect(events("staff.reset_failed")).toEqual([]);
      expect(events("staff.reset_sent")).toEqual([]);
    });

    it("logs an email that could not be sent, by the error's name only", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      test.mail.failing = true;
      try {
        await requestReset(email);
      } finally {
        test.mail.failing = false;
      }
      expect(events("staff.reset_email_unavailable")).toEqual([
        { addr: expect.any(String), reason: "EmailSendError" },
      ]);
    });

    it("logs a failure after the answer instead of losing it", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      control.insertFails = true;
      expect((await requestReset(email)).statusCode).toBe(202);
      expect(events("staff.reset_failed")).toEqual([
        { addr: expect.any(String), reason: "RangeError" },
      ]);
      expect(test.mail.to(email)).toEqual([]);
    });

    it("logs a throttled request with its step", async () => {
      const email = newEmail();
      for (let count = 0; count < 4; count += 1) {
        await requestReset(email);
      }
      expect(events("staff.throttled")).toEqual([
        { addr: expect.any(String), step: "reset_request" },
      ]);
    });

    it("asks to retry in a second while another request for the same email holds its lock", async () => {
      const email = newEmail();
      const lockKey = keys.emailKey(email).readBigInt64BE(0).toString();
      await db.owner.query("BEGIN");
      try {
        await db.owner.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey]);
        const response = await requestReset(email);
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe("1");
      } finally {
        await db.owner.query("ROLLBACK");
      }
    });
  });

  describe("using a link", () => {
    it("logs why a link was refused: unknown, expired, used", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await confirm("Q".repeat(43));
      await requestReset(email);
      const token = linkToken(email);
      expect((await confirm(token)).statusCode).toBe(204);
      expect((await confirm(token)).statusCode).toBe(410);
      const other = newEmail();
      await createStaff(db.owner, { email: other });
      await requestReset(other);
      await owner(
        `UPDATE staff_password_reset SET expires_at = now() - interval '1 second'
         WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = $1)`,
        [other],
      );
      await confirm(linkToken(other));
      expect(events("staff.reset_link_invalid").map((line) => line["why"])).toEqual([
        "unknown",
        "unknown",
        "expired",
      ]);
    });

    it("logs the reset with the user id", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      await requestReset(email);
      await confirm(linkToken(email));
      expect(events("staff.password_reset")).toEqual([{ addr: expect.any(String), user: id }]);
    });

    it("asks nothing of the breach list for an expired link, or one whose account is disabled", async () => {
      const expired = newEmail();
      const disabled = newEmail();
      await createStaff(db.owner, { email: expired });
      await createStaff(db.owner, { email: disabled });
      await requestReset(expired);
      await requestReset(disabled);
      await owner(
        `UPDATE staff_password_reset SET expires_at = now() - interval '1 second'
         WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = $1)`,
        [expired],
      );
      await owner("UPDATE staff_user SET status = 'disabled' WHERE email = $1", [disabled]);
      const seen = test.breach.seen.length;
      expect((await confirm(linkToken(expired))).statusCode).toBe(410);
      expect((await confirm(linkToken(disabled))).statusCode).toBe(410);
      expect(test.breach.seen.length).toBe(seen);
      expect(events("staff.reset_link_invalid").map((line) => line["why"])).toEqual([
        "expired",
        "disabled",
      ]);
    });

    it("answers busy when no hashing place is free, and keeps the link", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      control.gateBusyOnce = true;
      const response = await confirm(linkToken(email));
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "busy" });
      expect(await linksOf(email)).toBe(1);
    });

    it("logs the breach check being down, and fails loudly on any other breach-check error", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      test.breach.down = true;
      try {
        await confirm(linkToken(email));
      } finally {
        test.breach.down = false;
      }
      expect(events("staff.breach_check_unavailable")).toEqual([
        { addr: expect.any(String), reason: "BreachCheckUnavailable" },
      ]);
      test.breach.broken = true;
      try {
        expect((await confirm(linkToken(email))).statusCode).toBe(500);
      } finally {
        test.breach.broken = false;
      }
      expect(await linksOf(email)).toBe(1);
    });

    it("logs a notice that could not be sent, under its own name", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      const token = linkToken(email);
      test.mail.failing = true;
      try {
        expect((await confirm(token)).statusCode).toBe(204);
        await test.deferred.idle();
      } finally {
        test.mail.failing = false;
      }
      expect(events("staff.password_notice_failed")).toEqual([
        { addr: expect.any(String), reason: "EmailSendError" },
      ]);
    });

    it("links the notice back to the forgot-password page of this dashboard", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      await confirm(linkToken(email));
      await test.deferred.idle();
      const notice = test.mail.to(email).at(-1)?.text ?? "";
      expect(notice).toContain(`${DASHBOARD_ORIGIN}/ar/forgot-password`);
      expect(notice).toContain(`${DASHBOARD_ORIGIN}/en/forgot-password`);
    });

    it("sends a staff member's notice only to them, never to the security mailbox", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      const before = test.mail.to("security@questify.test").length;
      await confirm(linkToken(email));
      await test.deferred.idle();
      expect(test.mail.to("security@questify.test")).toHaveLength(before);
    });
  });

  describe("an admin's notice with no security mailbox set", () => {
    it("goes to the admin alone", async () => {
      const bare = await startApp(db, false, { securityAlertEmail: undefined });
      try {
        const email = newEmail();
        await createStaff(db.owner, { email, admin: true });
        await bare.app.inject({
          method: "POST",
          url: "/v1/staff/auth/reset/request",
          headers: browserHeaders(),
          payload: { email, lang: "en" },
        });
        await bare.deferred.idle();
        const token = /#token=([A-Za-z0-9_-]{43})/.exec(
          bare.mail.to(email).at(-1)?.text ?? "",
        )?.[1];
        await bare.app.inject({
          method: "POST",
          url: "/v1/staff/auth/reset/confirm",
          headers: browserHeaders(),
          payload: { token, newPassword: NEW_PASSWORD },
        });
        await bare.deferred.idle();
        expect(bare.mail.sent.map((mail) => mail.to)).toEqual([email, email]);
      } finally {
        await bare.close();
      }
    });
  });

  describe("changing the password", () => {
    it("takes back the reserved failure once the current password is right", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const before = await failures(email);
      expect((await change(cookie, PASSWORD)).statusCode).toBe(204);
      expect(await failures(email)).toBe(before);
    });

    it("logs the change, a wrong current password, and a throttled caller", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email, { "x-forwarded-for": freshIp() });
      lines = [];
      await change(cookie, "a wrong current password");
      expect(events("staff.password_change_failed")).toEqual([
        { addr: expect.any(String), user: id },
      ]);
      for (let count = 1; count < 8; count += 1) {
        await change(cookie, "a wrong current password");
      }
      await change(cookie, PASSWORD);
      expect(events("staff.throttled")).toEqual([
        { addr: expect.any(String), step: "password_change" },
      ]);
    });

    it("logs a successful change with the user id", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      await change(cookie, PASSWORD);
      expect(events("staff.password_changed")).toEqual([{ addr: expect.any(String), user: id }]);
    });

    it("answers busy when the current-password check cannot start, and counts no failure", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const before = await failures(email);
      control.gateBusyOnce = true;
      const response = await change(cookie, PASSWORD);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "busy" });
      expect(await failures(email)).toBe(before);
    });
  });
});
