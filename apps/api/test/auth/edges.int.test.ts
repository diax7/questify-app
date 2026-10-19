import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import {
  PASSWORD,
  browserHeaders,
  createStaff,
  freshIp,
  postCode,
  postPassword,
  startApp,
  testConfig,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Logged = { event?: string; [key: string]: unknown };

const parse = (lines: string[]): Logged[] =>
  lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Logged;
      return entry.event === undefined ? [] : [entry];
    } catch {
      return [];
    }
  });

const resendWith = (test: TestApp, token: string) =>
  test.app.inject({
    method: "POST",
    url: "/v1/staff/auth/resend",
    headers: browserHeaders(),
    payload: { challengeToken: token },
  });

const challengeTokenOf = (response: { json: <T>() => T }): string =>
  response.json<{ challengeToken: string }>().challengeToken;

describe.skipIf(TEST_DATABASE_URL === undefined)("staff sign-in edge cases", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const keys = createAuthKeys(testConfig().auth.secret);
  const newEmail = (): string => {
    counter += 1;
    return `edge${counter}@najd.sa`;
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

  const exists = async (name: string) =>
    (
      await owner("SELECT 1 FROM staff_session WHERE token_hash = sha256($1::bytea)", [
        Buffer.from(name),
      ])
    ).length;

  /** Holds the advisory lock for a key, as a busy sign-in would, until the returned function is called. */
  const holdLock = async (key: Buffer): Promise<() => Promise<void>> => {
    const id = key.readBigInt64BE(0).toString();
    await db.owner.query("SELECT pg_advisory_lock($1::bigint)", [id]);
    return async () => {
      await db.owner.query("SELECT pg_advisory_unlock($1::bigint)", [id]);
    };
  };

  const withLogs = async <T>(
    work: (logged: TestApp, events: () => Logged[]) => Promise<T>,
    auth: Parameters<typeof startApp>[2] = {},
  ): Promise<T> => {
    const lines: string[] = [];
    const logged = await startApp(
      db,
      { level: "debug", stream: { write: (line: string) => void lines.push(line) } },
      auth,
    );
    try {
      return await work(logged, () => parse(lines));
    } finally {
      await logged.close();
    }
  };

  describe("what is logged for each outcome", () => {
    it("names every event with its fields and a keyed address tag", async () => {
      await withLogs(async (logged, events) => {
        const email = newEmail();
        const id = await createStaff(db.owner, { email, admin: true });
        const ip = freshIp();
        const header = { "x-forwarded-for": ip };

        await postPassword(logged, email, "not the password at all", header);
        const first = await postPassword(logged, email, PASSWORD, header);
        const code = logged.mail.lastCode(email);
        await postCode(
          logged,
          challengeTokenOf(first),
          code === "000000" ? "000001" : "000000",
          header,
        );
        logged.mail.failing = true;
        const done = await postCode(logged, challengeTokenOf(first), code, header);
        logged.mail.failing = false;
        expect(done.statusCode).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const all = events();
        const find = (event: string) => all.filter((entry) => entry.event === event);
        expect(find("staff.password_failed")).toHaveLength(1);
        expect(find("staff.password_ok")[0]).toMatchObject({ user: id });
        expect(find("staff.code_failed")[0]).toMatchObject({ attemptsLeft: 4 });
        expect(find("staff.session_opened")[0]).toMatchObject({ user: id });
        expect(find("staff.alert_failed")[0]).toMatchObject({ reason: "EmailSendError" });
        const expectedTag = keys.addressKey(ip).toString("hex").slice(0, 12);
        for (const entry of all) {
          expect(entry["addr"]).toBe(expectedTag);
        }
      });
    });

    it("logs each kind of throttle with the step that hit it", async () => {
      await withLogs(async (logged, events) => {
        const email = newEmail();
        await createStaff(db.owner, { email });
        const ip = freshIp();
        const header = { "x-forwarded-for": ip };
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await postPassword(logged, email, "wrong password here", header);
        }
        await postPassword(logged, email, "wrong password here", header);
        const capped = newEmail();
        await createStaff(db.owner, { email: capped });
        for (let count = 0; count < 6; count += 1) {
          await postPassword(logged, capped);
        }
        const codeUser = newEmail();
        await createStaff(db.owner, { email: codeUser });
        const codeIp = { "x-forwarded-for": freshIp() };
        const firstChallenge = await postPassword(logged, codeUser, PASSWORD, codeIp);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await postCode(logged, challengeTokenOf(firstChallenge), "123456", codeIp);
        }
        const secondChallenge = await postPassword(logged, codeUser, PASSWORD, codeIp);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await postCode(logged, challengeTokenOf(secondChallenge), "123456", codeIp);
        }
        const blocked = await postCode(logged, challengeTokenOf(secondChallenge), "123456", codeIp);
        expect(blocked.statusCode).toBe(429);

        const steps = events()
          .filter((entry) => entry.event === "staff.throttled")
          .map((entry) => entry["step"])
          .toSorted();
        expect(steps).toEqual(["challenge_cap", "code", "password"]);
      });
    });

    it("logs an email that could not be sent, with the reason", async () => {
      await withLogs(async (logged, events) => {
        const email = newEmail();
        await createStaff(db.owner, { email });
        logged.mail.failing = true;
        await postPassword(logged, email);
        logged.mail.failing = false;
        expect(events().find((entry) => entry.event === "staff.email_unavailable")).toMatchObject({
          reason: "EmailSendError",
        });
      });
    });
  });

  describe("when another request holds the lock", () => {
    it("answers a password attempt with 429 and Retry-After 1, without counting it", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const release = await holdLock(keys.emailKey(email));
      try {
        const response = await postPassword(test, email, "wrong password here");
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toMatchObject({ code: "too_many_attempts" });
      } finally {
        await release();
      }
      const rows = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1 AND key = $2",
        [BUCKETS.failEmail, keys.emailKey(email)],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it("answers a code attempt with 429 and does not use up an attempt", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const release = await holdLock(keys.emailKey(email));
      try {
        const response = await postCode(test, challengeTokenOf(first), test.mail.lastCode(email));
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe("1");
      } finally {
        await release();
      }
      const rows = await owner<{ attempts: number }>(
        "SELECT attempts FROM staff_login_challenge ORDER BY created_at DESC LIMIT 1",
      );
      expect(rows[0]?.attempts).toBe(0);
      expect(
        (await postCode(test, challengeTokenOf(first), test.mail.lastCode(email))).statusCode,
      ).toBe(200);
    });

    it("answers a new sign-in code request with 429 too_many_challenges", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      const release = await holdLock(keys.userKey(id));
      try {
        const response = await postPassword(test, email);
        expect(response.statusCode).toBe(429);
        expect(response.headers["retry-after"]).toBe("1");
        expect(response.json()).toMatchObject({ code: "too_many_challenges" });
      } finally {
        await release();
      }
      expect(test.mail.to(email)).toEqual([]);
    });
  });

  describe("an account that changes while a code is waiting", () => {
    it("refuses the code and a resend once the account is disabled", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const code = test.mail.lastCode(email);
      await owner("UPDATE staff_user SET status = 'disabled' WHERE email = $1", [email]);
      await owner("UPDATE staff_login_challenge SET last_sent_at = now() - interval '2 minutes'");
      const resend = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/resend",
        headers: browserHeaders(),
        payload: { challengeToken: challengeTokenOf(first) },
      });
      expect(resend.statusCode).toBe(410);
      expect((await postCode(test, challengeTokenOf(first), code)).statusCode).toBe(410);
      expect(
        await owner(
          "SELECT 1 FROM staff_session WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = $1)",
          [email],
        ),
      ).toEqual([]);
    });
  });

  describe("resending", () => {
    it("says how long to wait, never more than a minute", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const response = await resendWith(test, challengeTokenOf(first));
      const wait = Number(response.headers["retry-after"]);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60);
      expect(response.json()).toMatchObject({ details: { retryAfterSeconds: wait } });
    });

    it("refuses a resend once all five code attempts are used", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await postPassword(test, email);
      const code = test.mail.lastCode(email);
      const wrong = code === "000000" ? "000001" : "000000";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await postCode(test, challengeTokenOf(first), wrong);
      }
      await owner("UPDATE staff_login_challenge SET last_sent_at = now() - interval '2 minutes'");
      expect((await resendWith(test, challengeTokenOf(first))).statusCode).toBe(410);
    });
  });

  describe("housekeeping", () => {
    it("sweeps at most once per interval for one running service", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      const fresh = await startApp(db);
      const oldSession = async (name: string) =>
        owner(
          `INSERT INTO staff_session (staff_user_id, token_hash, last_seen_at, revoked_at)
           VALUES ($1, sha256($2::bytea), now() - interval '90 days', now() - interval '60 days')`,
          [id, Buffer.from(name)],
        );
      try {
        await oldSession("first");
        await postPassword(fresh, email);
        expect(await exists("first")).toBe(0);
        await oldSession("second");
        await postPassword(fresh, email);
        expect(await exists("second")).toBe(1);
      } finally {
        await fresh.close();
      }
    });

    it("also removes challenges older than a day", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      await owner(
        `INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at, created_at)
         VALUES ($1, sha256('stale-challenge'), sha256('x'), now() - interval '2 days', now() - interval '2 days')`,
        [id],
      );
      const fresh = await startApp(db);
      try {
        await postPassword(fresh, newEmail().replace("edge", "other"));
        const other = newEmail();
        await createStaff(db.owner, { email: other });
        await postPassword(fresh, other);
      } finally {
        await fresh.close();
      }
      expect(
        await owner(
          "SELECT 1 FROM staff_login_challenge WHERE token_hash = sha256('stale-challenge')",
        ),
      ).toEqual([]);
    });

    it("stores the browser and the address on the session, cut to a sane length", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const ip = freshIp();
      const agent = `Browser/${"x".repeat(400)}`;
      const first = await postPassword(test, email, PASSWORD, { "x-forwarded-for": ip });
      const done = await postCode(test, challengeTokenOf(first), test.mail.lastCode(email), {
        "x-forwarded-for": ip,
        "user-agent": agent,
      });
      expect(done.statusCode).toBe(200);
      const rows = await owner<{ user_agent: string; ip: string }>(
        "SELECT user_agent, ip FROM staff_session WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = $1)",
        [email],
      );
      expect(rows[0]?.ip).toBe(ip);
      expect(rows[0]?.user_agent).toBe(agent.slice(0, 300));
    });
  });

  describe("admin alerts", () => {
    it("goes only to the admin when no security mailbox is configured", async () => {
      const bare = await startApp(db, false, { securityAlertEmail: undefined });
      try {
        const admin = newEmail();
        await createStaff(db.owner, { email: admin, admin: true });
        const first = await postPassword(bare, admin);
        await postCode(bare, challengeTokenOf(first), bare.mail.lastCode(admin));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(bare.mail.sent.map((mail) => mail.to)).toEqual([admin, admin]);
      } finally {
        await bare.close();
      }
    });
  });
});
