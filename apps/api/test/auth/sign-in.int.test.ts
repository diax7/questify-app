import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as passwordModule from "#src/auth/password";
import { createAuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import { testConfig } from "#test/support/auth-app";
import {
  PASSWORD,
  browserHeaders,
  createStaff,
  freshIp,
  postCode,
  postPassword,
  sessionCookieOf,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

vi.mock("#src/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof passwordModule>();
  return {
    ...actual,
    dummyVerify: vi.fn(actual.dummyVerify),
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

/** How many dummy and real password checks one wrong-password attempt for this email cost. */
const checksFor = async (test: TestApp, email: string): Promise<[number, number]> => {
  vi.mocked(passwordModule.dummyVerify).mockClear();
  vi.mocked(passwordModule.verifyPassword).mockClear();
  await postPassword(test, email, "not the password at all");
  return [
    vi.mocked(passwordModule.dummyVerify).mock.calls.length,
    vi.mocked(passwordModule.verifyPassword).mock.calls.length,
  ];
};

const token = (response: { json: <T>() => T }): string =>
  response.json<{ challengeToken: string }>().challengeToken;
const wrongCode = (code: string): string => (code === "000000" ? "000001" : "000000");
describe.skipIf(TEST_DATABASE_URL === undefined)("staff sign-in flow", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const newEmail = (): string => {
    counter += 1;
    return `staff${counter}@najd.sa`;
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
  const keys = createAuthKeys(testConfig().auth.secret);
  const failuresOf = async (email: string): Promise<number> => {
    const rows = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1 AND key = $2",
      [BUCKETS.failEmail, keys.emailKey(email)],
    );
    return rows[0]?.n ?? -1;
  };
  const allThrottleRows = async (): Promise<number> =>
    (await owner<{ n: number }>("SELECT count(*)::int AS n FROM auth_throttle"))[0]?.n ?? -1;

  describe("the three steps", () => {
    it("opens a session only after the password and then the emailed code", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });

      const first = await postPassword(test, email);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ challengeToken: expect.any(String), expiresInSeconds: 600 });
      expect(first.headers["set-cookie"]).toBeUndefined();
      expect(first.headers["cache-control"]).toBe("no-store");

      const mail = test.mail.to(email);
      expect(mail).toHaveLength(1);
      expect(mail[0]?.text).toContain(test.mail.lastCode(email));

      const second = await postCode(test, token(first), test.mail.lastCode(email));
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({
        account: { id: expect.any(String), email, platformRole: "none" },
      });
      expect(second.json()).not.toHaveProperty("account.passwordHash");

      const me = await test.app.inject({
        method: "GET",
        url: "/v1/staff/me",
        headers: withSession(sessionCookieOf(second)),
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ email, platformRole: "none", memberships: [] });
    });

    it("sets a __Host- cookie that is HttpOnly, Secure, SameSite=Strict, Path=/ and has no Domain", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const done = await postCode(test, token(first), test.mail.lastCode(email));
      const header = String(done.headers["set-cookie"]);
      expect(header).toMatch(/^__Host-qs_session=[A-Za-z0-9_-]{43};/);
      for (const attribute of [
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Max-Age=43200",
      ]) {
        expect(header).toContain(attribute);
      }
      expect(header).not.toMatch(/Domain=/i);
    });

    it("reaches nothing after the password step alone, or with the challenge token as a cookie", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      for (const headers of [
        browserHeaders(),
        withSession(`__Host-qs_session=${token(first)}`),
        withSession("__Host-qs_session=garbage"),
      ]) {
        const response = await test.app.inject({ method: "GET", url: "/v1/staff/me", headers });
        expect(response.statusCode).toBe(401);
      }
    });

    it("stores the session by hash, never the token itself", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const value = cookie.split("=")[1] ?? "";
      const rows = await owner<{ token_hash: Buffer }>(
        "SELECT token_hash FROM staff_session WHERE token_hash = sha256($1::bytea)",
        [Buffer.from(value)],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.token_hash.toString("utf8")).not.toContain(value);
    });
  });

  describe("passwords", () => {
    it("gives the same answer for a wrong password, an unknown email and a disabled account", async () => {
      const email = newEmail();
      const disabled = newEmail();
      await createStaff(db.owner, { email });
      await createStaff(db.owner, { email: disabled, status: "disabled" });
      const answers = await Promise.all([
        postPassword(test, email, "not the password at all"),
        postPassword(test, "nobody@najd.sa"),
        postPassword(test, disabled),
      ]);
      for (const answer of answers) {
        expect(answer.statusCode).toBe(401);
        expect(answer.json()).toEqual(answers[0]?.json());
      }
      expect(test.mail.to("nobody@najd.sa")).toEqual([]);
      expect(test.mail.to(disabled)).toEqual([]);
    });

    it("pays for exactly one password check whatever the email, so timing reveals nothing", async () => {
      const real = newEmail();
      const disabled = newEmail();
      await createStaff(db.owner, { email: real });
      await createStaff(db.owner, { email: disabled, status: "disabled" });
      // [dummy checks, real checks]: an unknown or disabled account does a dummy check, a real one a real check.
      expect(await checksFor(test, "ghost@najd.sa")).toEqual([1, 0]);
      expect(await checksFor(test, disabled)).toEqual([1, 0]);
      expect(await checksFor(test, "nobody")).toEqual([1, 0]);
      expect(await checksFor(test, real)).toEqual([0, 1]);
    });

    it.each([
      ["text with no @", "nobody"],
      ["an address with a space", "a b@najd.sa"],
      ["an address with a control character", `a${String.fromCodePoint(1)}b@najd.sa`],
      ["a compatibility character that expands past 254", `${"\uFDFA".repeat(40)}@najd.sa`],
    ])("answers %s exactly like an unknown email, and counts it", async (_label, email) => {
      const ip = freshIp();
      const unknown = await postPassword(test, "ghost@najd.sa", "wrong password here", {
        "x-forwarded-for": ip,
      });
      const malformed = await postPassword(test, email, "wrong password here", {
        "x-forwarded-for": ip,
      });
      expect(malformed.statusCode).toBe(401);
      expect(malformed.json()).toEqual(unknown.json());
      const rows = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = 'fail_address' AND key = $1",
        [keys.addressKey(ip)],
      );
      expect(rows[0]?.n).toBe(2);
    });

    it("treats an email typed in capitals or with spaces as the same account", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const response = await postPassword(test, `  ${email.toUpperCase()} `);
      expect(response.statusCode).toBe(200);
    });

    it("answers 401 for a password over 128 characters without touching the throttle", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const before = await allThrottleRows();
      const response = await postPassword(test, email, "a".repeat(129));
      expect(response.statusCode).toBe(401);
      expect(await allThrottleRows()).toBe(before);
    });

    it.each([
      ["a missing password", { email: "a@najd.sa" }],
      ["an empty password", { email: "a@najd.sa", password: "" }],
      ["a huge password", { email: "a@najd.sa", password: "x".repeat(2000) }],
      ["a missing email", { password: "something" }],
      ["a number for the email", { email: 5, password: "something" }],
    ])("rejects %s with 400 before any database work", async (_label, payload) => {
      const response = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/password",
        headers: browserHeaders(),
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_request" });
    });

    it("rejects a body over 4 KB", async () => {
      const response = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/password",
        headers: browserHeaders(),
        payload: { email: "a@najd.sa", password: "x".repeat(5000) },
      });
      expect(response.statusCode).toBe(413);
    });

    it("upgrades an old password hash to the current parameters after a good sign-in", async () => {
      const email = newEmail();
      const { hash } = await import("@node-rs/argon2");
      const older = await hash(PASSWORD, {
        algorithm: 2,
        memoryCost: 19456,
        timeCost: 1,
        parallelism: 1,
      });
      expect(older).toContain("t=1");
      await createStaff(db.owner, { email, passwordHash: older });
      const response = await postPassword(test, email);
      expect(response.statusCode).toBe(200);
      const rows = await owner<{ password_hash: string }>(
        "SELECT password_hash FROM staff_user WHERE email = $1",
        [email],
      );
      expect(rows[0]?.password_hash).toContain("m=19456,t=2,p=1");
      const again = await postPassword(test, email);
      expect(again.statusCode).toBe(200);
    });
  });

  describe("limits on wrong guesses", () => {
    it("blocks the ninth password attempt for an email, for an unknown email just the same", async () => {
      const email = newEmail();
      const unknown = newEmail();
      await createStaff(db.owner, { email });
      for (const target of [email, unknown]) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const wrong = await postPassword(test, target, "wrong password here");
          expect(wrong.statusCode).toBe(401);
        }
        const blocked = await postPassword(test, target, "wrong password here");
        expect(blocked.statusCode).toBe(429);
        expect(blocked.headers["retry-after"]).toMatch(/^[0-9]+$/);
        expect(blocked.json()).toMatchObject({ code: "too_many_attempts" });
      }
      const right = await postPassword(test, email);
      expect(right.statusCode).toBe(429);
    });

    it("does not add to the count while a person is already blocked", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const ip = freshIp();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await postPassword(test, email, "wrong password here", { "x-forwarded-for": ip });
      }
      expect(await failuresOf(email)).toBe(8);
    });

    it("blocks a whole address after 30 failures, whatever emails it tries", async () => {
      const ip = freshIp();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await postPassword(test, newEmail(), "wrong password here", {
          "x-forwarded-for": ip,
        });
        expect(response.statusCode).toBe(401);
      }
      const blocked = await postPassword(test, newEmail(), "wrong password here", {
        "x-forwarded-for": ip,
      });
      expect(blocked.statusCode).toBe(429);
      const fresh = await postPassword(test, newEmail(), "wrong password here");
      expect(fresh.statusCode).toBe(401);
    });

    it("counts all of one IPv6 /64 as one address", async () => {
      const prefix = "2001:db8:5:6";
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await postPassword(test, newEmail(), "wrong password here", {
          "x-forwarded-for": `${prefix}:${attempt}::1`,
        });
      }
      const blocked = await postPassword(test, newEmail(), "wrong password here", {
        "x-forwarded-for": `${prefix}:ffff::9`,
      });
      expect(blocked.statusCode).toBe(429);
    });

    it("ignores a spoofed X-Forwarded-For when choosing the address to count", async () => {
      const real = freshIp();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await postPassword(test, newEmail(), "wrong password here", {
          "x-forwarded-for": `${freshIp()}, ${real}`,
        });
      }
      const blocked = await postPassword(test, newEmail(), "wrong password here", {
        "x-forwarded-for": `${freshIp()}, ${real}`,
      });
      expect(blocked.statusCode).toBe(429);
    });

    it("takes back the reserved failure when the password is right", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const ip = freshIp();
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await postPassword(test, email, "wrong password here", { "x-forwarded-for": ip });
      }
      expect(await failuresOf(email)).toBe(7);
      const right = await postPassword(test, email, PASSWORD, { "x-forwarded-for": ip });
      expect(right.statusCode).toBe(200);
      expect(await failuresOf(email)).toBe(7);
    });

    it("keeps parallel guesses within the limit", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const ip = freshIp();
      const answers = await Promise.all(
        Array.from({ length: 40 }, () =>
          postPassword(test, email, "wrong password here", { "x-forwarded-for": ip }),
        ),
      );
      const counts = answers.reduce<Record<number, number>>(
        (all, answer) => ({ ...all, [answer.statusCode]: (all[answer.statusCode] ?? 0) + 1 }),
        {},
      );
      expect(counts[401] ?? 0).toBeLessThanOrEqual(8);
      expect(await failuresOf(email)).toBeLessThanOrEqual(8);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(40);
      for (const code of Object.keys(counts)) {
        expect([401, 429, 503]).toContain(Number(code));
      }
    });
  });

  describe("the emailed code", () => {
    it("counts each wrong code even though it answers with an error (the count survives)", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const code = test.mail.lastCode(email);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const wrong = await postCode(test, token(first), wrongCode(code));
        expect(wrong.statusCode).toBe(401);
        expect(wrong.json()).toMatchObject({
          code: "invalid_code",
          details: { attemptsLeft: 5 - attempt },
        });
        const rows = await owner<{ attempts: number }>(
          "SELECT attempts FROM staff_login_challenge ORDER BY created_at DESC LIMIT 1",
        );
        expect(rows[0]?.attempts).toBe(attempt);
      }
      const late = await postCode(test, token(first), code);
      expect(late.statusCode).toBe(410);
      expect(late.json()).toMatchObject({ code: "challenge_expired" });
    });

    it.each([
      ["five digits", "12345"],
      ["seven digits", "1234567"],
      ["letters", "abcdef"],
      ["Arabic-Indic digits", "١٢٣٤٥٦"],
    ])("rejects %s with 400 and does not count an attempt", async (_label, code) => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const response = await postCode(test, token(first), code);
      expect(response.statusCode).toBe(400);
      const rows = await owner<{ attempts: number }>(
        "SELECT attempts FROM staff_login_challenge ORDER BY created_at DESC LIMIT 1",
      );
      expect(rows[0]?.attempts).toBe(0);
    });

    it("refuses an unknown challenge token with 410", async () => {
      const response = await postCode(test, "A".repeat(43), "123456");
      expect(response.statusCode).toBe(410);
    });

    it("accepts the code until the moment it expires and not after", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      await owner(
        "UPDATE staff_login_challenge SET expires_at = now() + interval '5 seconds' WHERE created_at = (SELECT max(created_at) FROM staff_login_challenge)",
      );
      const ok = await postCode(test, token(first), test.mail.lastCode(email));
      expect(ok.statusCode).toBe(200);

      const second = await postPassword(test, email);
      await owner(
        "UPDATE staff_login_challenge SET expires_at = now() - interval '1 second' WHERE created_at = (SELECT max(created_at) FROM staff_login_challenge)",
      );
      const expired = await postCode(test, token(second), test.mail.lastCode(email));
      expect(expired.statusCode).toBe(410);
    });

    it("does not accept the same code twice", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const code = test.mail.lastCode(email);
      expect((await postCode(test, token(first), code)).statusCode).toBe(200);
      expect((await postCode(test, token(first), code)).statusCode).toBe(410);
    });

    it("makes one session when the right code is sent twice at once", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const code = test.mail.lastCode(email);
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => postCode(test, token(first), code)),
      );
      expect(answers.filter((answer) => answer.statusCode === 200)).toHaveLength(1);
      const rows = await owner("SELECT 1 FROM staff_session WHERE staff_user_id = $1", [id]);
      expect(rows).toHaveLength(1);
    });

    it("lets only five of many parallel wrong guesses count", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const code = test.mail.lastCode(email);
      const answers = await Promise.all(
        Array.from({ length: 12 }, () => postCode(test, token(first), wrongCode(code))),
      );
      expect(answers.filter((answer) => answer.statusCode === 401).length).toBeLessThanOrEqual(5);
      const rows = await owner<{ attempts: number }>(
        "SELECT attempts FROM staff_login_challenge ORDER BY created_at DESC LIMIT 1",
      );
      expect(rows[0]?.attempts).toBeLessThanOrEqual(5);
    });

    it("keeps counting failures across challenges, so starting over does not reset the limit", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const ip = freshIp();
      const header = { "x-forwarded-for": ip };
      const first = await postPassword(test, email, PASSWORD, header);
      const firstCode = test.mail.lastCode(email);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await postCode(test, token(first), wrongCode(firstCode), header);
      }
      const second = await postPassword(test, email, PASSWORD, header);
      const secondCode = test.mail.lastCode(email);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const wrong = await postCode(test, token(second), wrongCode(secondCode), header);
        expect(wrong.statusCode).toBe(401);
      }
      const blocked = await postCode(test, token(second), secondCode, header);
      expect(blocked.statusCode).toBe(429);
    });

    it("replaces the earlier challenge when a new password step succeeds", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const firstCode = test.mail.lastCode(email);
      await postPassword(test, email);
      const old = await postCode(test, token(first), firstCode);
      expect(old.statusCode).toBe(410);
    });

    it("allows five challenges an hour and refuses the sixth", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      for (let count = 0; count < 5; count += 1) {
        expect((await postPassword(test, email)).statusCode).toBe(200);
      }
      const sixth = await postPassword(test, email);
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json()).toMatchObject({ code: "too_many_challenges" });
      expect(sixth.headers["retry-after"]).toBeDefined();
      expect(test.mail.to(email)).toHaveLength(5);
    });

    it("tells the person to start over when the code cannot be emailed", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      test.mail.failing = true;
      const response = await postPassword(test, email);
      test.mail.failing = false;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "email_unavailable" });
      const live = await owner(
        "SELECT 1 FROM staff_login_challenge WHERE consumed_at IS NULL AND staff_user_id = (SELECT id FROM staff_user WHERE email = $1)",
        [email],
      );
      expect(live).toEqual([]);
    });
  });

  describe("resending the code", () => {
    it("refuses a resend within a minute and allows it after", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const soon = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/resend",
        headers: browserHeaders(),
        payload: { challengeToken: token(first) },
      });
      expect(soon.statusCode).toBe(429);
      expect(soon.json()).toMatchObject({ code: "resend_too_soon" });
      expect(Number(soon.headers["retry-after"])).toBeGreaterThan(0);

      await owner("UPDATE staff_login_challenge SET last_sent_at = now() - interval '61 seconds'");
      const later = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/resend",
        headers: browserHeaders(),
        payload: { challengeToken: token(first) },
      });
      expect(later.statusCode).toBe(200);
      expect(later.json()).toEqual({});
      expect(test.mail.to(email)).toHaveLength(2);
    });

    it("makes the old code stop working and keeps the attempt count", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const oldCode = test.mail.lastCode(email);
      await postCode(test, token(first), wrongCode(oldCode));
      await postCode(test, token(first), wrongCode(oldCode));
      await owner("UPDATE staff_login_challenge SET last_sent_at = now() - interval '61 seconds'");
      await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/resend",
        headers: browserHeaders(),
        payload: { challengeToken: token(first) },
      });
      const newCode = test.mail.lastCode(email);
      const rows = await owner<{ attempts: number }>(
        "SELECT attempts FROM staff_login_challenge ORDER BY created_at DESC LIMIT 1",
      );
      expect(rows[0]?.attempts).toBe(2);
      if (newCode !== oldCode) {
        expect((await postCode(test, token(first), oldCode)).statusCode).toBe(401);
      }
      expect((await postCode(test, token(first), newCode)).statusCode).toBe(200);
    });

    it("allows three resends and refuses the fourth", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const resend = () =>
        test.app.inject({
          method: "POST",
          url: "/v1/staff/auth/resend",
          headers: browserHeaders(),
          payload: { challengeToken: token(first) },
        });
      for (let count = 0; count < 3; count += 1) {
        await owner(
          "UPDATE staff_login_challenge SET last_sent_at = now() - interval '61 seconds'",
        );
        expect((await resend()).statusCode).toBe(200);
      }
      await owner("UPDATE staff_login_challenge SET last_sent_at = now() - interval '61 seconds'");
      const fourth = await resend();
      expect(fourth.statusCode).toBe(429);
      expect(fourth.json()).toMatchObject({ code: "resend_limit" });
    });

    it("refuses a resend for an unknown or dead challenge", async () => {
      const response = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/resend",
        headers: browserHeaders(),
        payload: { challengeToken: "B".repeat(43) },
      });
      expect(response.statusCode).toBe(410);
    });
  });

  describe("admins", () => {
    it("emails the admin and the security mailbox about a new session, but not a regular user", async () => {
      const admin = newEmail();
      const regular = newEmail();
      await createStaff(db.owner, { email: admin, admin: true });
      await createStaff(db.owner, { email: regular });
      const before = test.mail.to("security@questify.test").length;
      await signInFully(test, admin, { "user-agent": "Chrome on Windows" });
      await signInFully(test, regular);
      await vi.waitFor(() => {
        expect(test.mail.to("security@questify.test")).toHaveLength(before + 1);
        expect(test.mail.to(admin).some((mail) => mail.subject.includes("New sign-in"))).toBe(true);
      });
      const alerts = test.mail.to(admin).filter((mail) => mail.subject.includes("New sign-in"));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.text).toContain("Chrome on Windows");
      expect(test.mail.to(regular)).toHaveLength(1);
    });

    it("still signs the admin in when the alert cannot be sent", async () => {
      const admin = newEmail();
      await createStaff(db.owner, { email: admin, admin: true });
      const first = await postPassword(test, admin);
      test.mail.failing = true;
      const done = await postCode(test, token(first), test.mail.lastCode(admin));
      test.mail.failing = false;
      expect(done.statusCode).toBe(200);
    });
  });

  describe("the retention sweep", () => {
    it("never blocks a sign-in when it fails, and says so in the log", async () => {
      const lines: string[] = [];
      const logged = await startApp(db, {
        level: "debug",
        stream: { write: (line: string) => void lines.push(line) },
      });
      const email = newEmail();
      await createStaff(db.owner, { email });
      await owner(
        `CREATE OR REPLACE FUNCTION sweep_boom() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'sweep is broken'; END $$`,
      );
      await owner(
        `CREATE TRIGGER sweep_boom BEFORE DELETE ON auth_throttle
         FOR EACH ROW WHEN (OLD.at < now() - interval '12 hours') EXECUTE FUNCTION sweep_boom()`,
      );
      await owner(
        "INSERT INTO auth_throttle (bucket, key, at) VALUES ('fail_email', sha256('stale'), now() - interval '2 days')",
      );
      try {
        const response = await postPassword(logged, email);
        expect(response.statusCode).toBe(200);
        const failed = lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((entry) => entry["event"] === "staff.sweep_failed");
        expect(failed).toMatchObject({ reason: expect.any(String) });
      } finally {
        await owner("DROP TRIGGER sweep_boom ON auth_throttle");
        await owner("DELETE FROM auth_throttle WHERE key = sha256('stale')");
        await logged.close();
      }
    });
  });

  describe("retention", () => {
    it("clears out old sessions, challenges and throttle rows on a sign-in", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      await owner(
        `INSERT INTO staff_session (staff_user_id, token_hash, last_seen_at, revoked_at)
         VALUES ($1, sha256('old-1'), now() - interval '90 days', now() - interval '60 days'),
                ($1, sha256('old-2'), now() - interval '40 days', NULL)`,
        [id],
      );
      await owner(
        `INSERT INTO auth_throttle (bucket, key, at) VALUES ('fail_email', sha256('old'), now() - interval '3 days')`,
      );
      const fresh = await startApp(db);
      try {
        await postPassword(fresh, email);
      } finally {
        await fresh.close();
      }
      expect(
        await owner(
          "SELECT 1 FROM staff_session WHERE token_hash IN (sha256('old-1'), sha256('old-2'))",
        ),
      ).toEqual([]);
      expect(await owner("SELECT 1 FROM auth_throttle WHERE key = sha256('old')")).toEqual([]);
    });
  });
});
