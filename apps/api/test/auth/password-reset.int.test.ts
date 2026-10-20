import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { createAuthKeys } from "#src/auth/keys";
import { addressBucket } from "#src/auth/normalize";
import { BUCKETS } from "#src/auth/throttle";
import {
  BREACHED_PASSWORD,
  DASHBOARD_ORIGIN,
  PASSWORD,
  browserHeaders,
  createStaff,
  freshIp,
  postPassword,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const NEW_PASSWORD = "a brand new pass phrase 77";

describe.skipIf(TEST_DATABASE_URL === undefined)("staff password reset and change (T-020)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const newEmail = (): string => {
    counter += 1;
    return `reset${counter}@najd.sa`;
  };
  const keys = createAuthKeys(testConfig().auth.secret);

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

  const requestReset = async (
    email: string,
    headers: Record<string, string> = {},
    lang: "ar" | "en" = "en",
    app: TestApp = test,
  ): Promise<LightMyRequestResponse> => {
    const response = await app.app.inject({
      method: "POST",
      url: "/v1/staff/auth/reset/request",
      headers: browserHeaders(headers),
      payload: { email, lang },
    });
    await app.deferred.idle();
    return response;
  };

  /** The token from the newest reset email to this address. */
  const linkToken = (email: string, app: TestApp = test): string => {
    const mail = app.mail.to(email).filter((message) => message.text.includes("reset-password"));
    const found = /#token=([A-Za-z0-9_-]{43})/.exec(mail.at(-1)?.text ?? "")?.[1];
    if (found === undefined) {
      throw new Error(`No reset link was emailed to ${email}.`);
    }
    return found;
  };

  const confirm = (
    token: string,
    newPassword = NEW_PASSWORD,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/reset/confirm",
      headers: browserHeaders(headers),
      payload: { token, newPassword },
    });

  const change = (cookie: string, currentPassword: string, newPassword = NEW_PASSWORD) =>
    test.app.inject({
      method: "POST",
      url: "/v1/staff/password",
      headers: withSession(cookie),
      payload: { currentPassword, newPassword },
    });

  const me = (cookie: string) =>
    test.app.inject({ method: "GET", url: "/v1/staff/me", headers: withSession(cookie) });

  const linksOf = async (email: string): Promise<number> =>
    (
      await owner<{ n: number }>(
        `SELECT count(*)::int AS n FROM staff_password_reset r
         JOIN staff_user u ON u.id = r.staff_user_id WHERE u.email = $1`,
        [email],
      )
    )[0]?.n ?? -1;

  const countIn = async (bucket: string, key: Buffer): Promise<number> =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1 AND key = $2",
        [bucket, key],
      )
    )[0]?.n ?? -1;

  const newestAudit = async (action: string) =>
    (
      await owner<{ actor_id: string; target_id: string; after: unknown; before: unknown }>(
        "SELECT actor_id, target_id, after, before FROM audit_log WHERE action = $1 ORDER BY id DESC LIMIT 1",
        [action],
      )
    )[0];

  describe("asking for a link", () => {
    it("answers every email the same, and mails only an active account", async () => {
      const known = newEmail();
      const disabled = newEmail();
      await createStaff(db.owner, { email: known });
      await createStaff(db.owner, { email: disabled, status: "disabled" });
      const answers = [];
      for (const email of [known, disabled, "nobody.at.all@najd.sa", "not an email"]) {
        const response = await requestReset(email);
        answers.push([response.statusCode, response.body]);
      }
      expect(answers).toEqual(Array.from({ length: 4 }, () => [202, "{}"]));
      expect(test.mail.to(known)).toHaveLength(1);
      expect(test.mail.to(disabled)).toEqual([]);
      expect(test.mail.to("nobody.at.all@najd.sa")).toEqual([]);
    });

    it("links to the reset page in the asked language, holding the token in the fragment", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(` ${email.toUpperCase()} `, {}, "ar");
      const text = test.mail.to(email).at(-1)?.text ?? "";
      expect(text).toMatch(
        new RegExp(`${DASHBOARD_ORIGIN}/ar/reset-password#token=[A-Za-z0-9_-]{43}(\\s|$)`),
      );
      expect(await linksOf(email)).toBe(1);
    });

    it("keeps a pending link when someone signs in with the password meanwhile", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      expect((await postPassword(test, email)).statusCode).toBe(200);
      expect(await linksOf(email)).toBe(1);
      expect((await confirm(linkToken(email))).statusCode).toBe(204);
    });

    it("keeps one link per person: a new request replaces the old link", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      const first = linkToken(email);
      await requestReset(email);
      expect(await linksOf(email)).toBe(1);
      expect((await confirm(first)).statusCode).toBe(410);
      expect((await confirm(linkToken(email))).statusCode).toBe(204);
    });

    it("allows three requests an hour per email, and ten per address, whoever owns the email", async () => {
      const email = newEmail();
      for (let count = 0; count < 3; count += 1) {
        expect((await requestReset(email)).statusCode).toBe(202);
      }
      const fourth = await requestReset(email);
      expect(fourth.statusCode).toBe(429);
      expect(Number(fourth.headers["retry-after"])).toBeGreaterThan(0);

      const ip = freshIp();
      for (let count = 0; count < 10; count += 1) {
        expect((await requestReset(newEmail(), { "x-forwarded-for": ip })).statusCode).toBe(202);
      }
      expect((await requestReset(newEmail(), { "x-forwarded-for": ip })).statusCode).toBe(429);
    });

    it("still answers 202 when the email cannot be sent", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      test.mail.failing = true;
      try {
        expect((await requestReset(email)).statusCode).toBe(202);
      } finally {
        test.mail.failing = false;
      }
    });

    it("refuses a request from another site", async () => {
      const response = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/reset/request",
        headers: { origin: "https://evil.example", "x-forwarded-for": freshIp() },
        payload: { email: "a@najd.sa", lang: "en" },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("using a link", () => {
    it("sets the new password once: the old one stops, the new one signs in, the link is gone", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      await requestReset(email);
      const token = linkToken(email);
      const done = await confirm(token);
      expect(done.statusCode).toBe(204);
      expect(done.body).toBe("");
      expect((await postPassword(test, email)).statusCode).toBe(401);
      expect((await postPassword(test, email, NEW_PASSWORD)).statusCode).toBe(200);
      expect((await confirm(token, "another long pass phrase")).statusCode).toBe(410);
      expect(await linksOf(email)).toBe(0);
      expect(await newestAudit("staff.password.reset")).toEqual({
        actor_id: id,
        target_id: id,
        before: null,
        after: { sessionsEnded: 0 },
      });
    });

    it("ends every session the person had", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const first = await signInFully(test, email);
      const second = await signInFully(test, email);
      await requestReset(email);
      expect((await confirm(linkToken(email))).statusCode).toBe(204);
      expect((await me(first)).statusCode).toBe(401);
      expect((await me(second)).statusCode).toBe(401);
      expect((await newestAudit("staff.password.reset"))?.after).toEqual({ sessionsEnded: 2 });
    });

    it("tells the person, and for an admin the security mailbox too, without any secret", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email, admin: true });
      await requestReset(email);
      const token = linkToken(email);
      const before = test.mail.to("security@questify.test").length;
      await confirm(token);
      await test.deferred.idle();
      const notice = test.mail.to(email).at(-1);
      expect(notice?.subject).toContain("Your Questify password was changed");
      expect(notice?.text).not.toContain(token);
      expect(test.mail.to("security@questify.test")).toHaveLength(before + 1);
    });

    it("frees a locked-out person: after a reset the first sign-in works", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      for (let count = 0; count < 8; count += 1) {
        await postPassword(test, email, "a wrong password guess");
      }
      expect((await postPassword(test, email)).statusCode).toBe(429);
      await requestReset(email);
      expect((await confirm(linkToken(email))).statusCode).toBe(204);
      expect(await countIn(BUCKETS.failEmail, keys.emailKey(email))).toBe(0);
      expect((await postPassword(test, email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it("lets exactly one of two confirms racing with the same link win", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      const token = linkToken(email);
      const answers = await Promise.all([
        confirm(token, "first racer pass phrase"),
        confirm(token, "second racer pass phrase"),
      ]);
      expect(answers.map((answer) => answer.statusCode).toSorted()).toEqual([204, 410]);
    });

    it("answers an expired link with 410 and does not count it against the address", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      await owner(
        `UPDATE staff_password_reset SET expires_at = now() - interval '1 second'
         WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = $1)`,
        [email],
      );
      const ip = freshIp();
      const response = await confirm(linkToken(email), NEW_PASSWORD, { "x-forwarded-for": ip });
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({ code: "reset_link_invalid" });
      expect(await countIn(BUCKETS.failAddress, keys.addressKey(addressBucket(ip)))).toBe(0);
    });

    it("counts an unknown token against the address, and stops it at 30 failures", async () => {
      const ip = freshIp();
      const unknown = "U".repeat(43);
      expect((await confirm(unknown, NEW_PASSWORD, { "x-forwarded-for": ip })).statusCode).toBe(
        410,
      );
      expect(await countIn(BUCKETS.failAddress, keys.addressKey(addressBucket(ip)))).toBe(1);
      for (let count = 1; count < 30; count += 1) {
        await confirm(unknown, NEW_PASSWORD, { "x-forwarded-for": ip });
      }
      expect((await confirm(unknown, NEW_PASSWORD, { "x-forwarded-for": ip })).statusCode).toBe(
        429,
      );
    });

    it.each([
      ["too_short", "short one"],
      ["context_word", "my questify pass phrase"],
      ["breached", BREACHED_PASSWORD],
    ])("refuses a %s password and keeps the link usable", async (reason, password) => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      const token = linkToken(email);
      const refused = await confirm(token, password);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ code: "weak_password", details: { reason } });
      expect((await confirm(token)).statusCode).toBe(204);
    });

    it("refuses the account's own email as the password", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      const refused = await confirm(linkToken(email), email.toUpperCase());
      expect(refused.json()).toMatchObject({ details: { reason: "same_as_email" } });
    });

    it("changes nothing when the breach check cannot answer, and asks to retry", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      test.breach.down = true;
      let response: LightMyRequestResponse;
      try {
        response = await confirm(linkToken(email));
      } finally {
        test.breach.down = false;
      }
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("30");
      expect(response.json()).toMatchObject({ code: "breach_check_unavailable" });
      expect(await linksOf(email)).toBe(1);
      expect((await postPassword(test, email)).statusCode).toBe(200);
    });

    it("refuses a link whose account was disabled during the check, and leaves the link in place", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      await requestReset(email);
      test.breach.during = async () => {
        await owner("UPDATE staff_user SET status = 'disabled' WHERE email = $1", [email]);
      };
      let response: LightMyRequestResponse;
      try {
        response = await confirm(linkToken(email));
      } finally {
        test.breach.during = undefined;
      }
      expect(response.statusCode).toBe(410);
      expect(await linksOf(email)).toBe(1);
      const hash = await owner<{ ok: boolean }>(
        "SELECT password_hash IS NOT NULL AS ok FROM staff_user WHERE email = $1",
        [email],
      );
      expect(hash).toEqual([{ ok: true }]);
    });
  });

  describe("changing the password while signed in", () => {
    it("keeps the current session, ends the others, and swaps the passwords", async () => {
      const email = newEmail();
      const id = await createStaff(db.owner, { email });
      const here = await signInFully(test, email);
      const elsewhere = await signInFully(test, email);
      const response = await change(here, PASSWORD);
      expect(response.statusCode).toBe(204);
      expect((await me(here)).statusCode).toBe(200);
      expect((await me(elsewhere)).statusCode).toBe(401);
      expect((await postPassword(test, email)).statusCode).toBe(401);
      expect((await postPassword(test, email, NEW_PASSWORD)).statusCode).toBe(200);
      expect(await newestAudit("staff.password.change")).toEqual({
        actor_id: id,
        target_id: id,
        before: null,
        after: { sessionsEnded: 1 },
      });
      await test.deferred.idle();
      expect(
        test.mail.to(email).filter((mail) => mail.subject.includes("password was changed")),
      ).toHaveLength(1);
    });

    it("refuses a wrong current password with 403 and counts it toward the sign-in lockout", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const before = await countIn(BUCKETS.failEmail, keys.emailKey(email));
      const response = await change(cookie, "not my current password");
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "current_password_wrong" });
      expect(await countIn(BUCKETS.failEmail, keys.emailKey(email))).toBe(before + 1);
      expect((await me(cookie)).statusCode).toBe(200);
    });

    it("refuses a weak new password before checking the current one, counting nothing", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const before = await countIn(BUCKETS.failEmail, keys.emailKey(email));
      const seen = test.breach.seen.length;
      const response = await change(cookie, "anything at all", "short");
      expect(response.json()).toMatchObject({
        code: "weak_password",
        details: { reason: "too_short" },
      });
      expect(await countIn(BUCKETS.failEmail, keys.emailKey(email))).toBe(before);
      expect(test.breach.seen.length).toBe(seen);
    });

    it("never asks the breach list about a password whose owner gave a wrong current password", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const seen = test.breach.seen.length;
      await change(cookie, "not my current password");
      expect(test.breach.seen.length).toBe(seen);
    });

    it("refuses a breached new password and keeps the old one", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const response = await change(cookie, PASSWORD, BREACHED_PASSWORD);
      expect(response.json()).toMatchObject({ details: { reason: "breached" } });
      expect((await postPassword(test, email)).statusCode).toBe(200);
    });

    it("stops a caller who has used up the sign-in failures", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      for (let count = 0; count < 8; count += 1) {
        await change(cookie, "a wrong current password");
      }
      expect((await change(cookie, PASSWORD)).statusCode).toBe(429);
    });

    it("needs a session and the dashboard's origin", async () => {
      const anonymous = await test.app.inject({
        method: "POST",
        url: "/v1/staff/password",
        headers: browserHeaders(),
        payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(anonymous.statusCode).toBe(401);
    });
  });

  describe("what the logs hold", () => {
    it("records the reset events, and none of the email, token or passwords", async () => {
      const lines: string[] = [];
      const logged = await startApp(db, {
        ...loggerOptions(testConfig()),
        level: "debug",
        stream: { write: (line: string) => void lines.push(line) },
      });
      try {
        const email = newEmail();
        await createStaff(db.owner, { email });
        await requestReset(email, {}, "en", logged);
        const token = linkToken(email, logged);
        const done = await logged.app.inject({
          method: "POST",
          url: "/v1/staff/auth/reset/confirm",
          headers: browserHeaders(),
          payload: { token, newPassword: NEW_PASSWORD },
        });
        expect(done.statusCode).toBe(204);
        await logged.deferred.idle();
        const text = lines.join("\n");
        expect(text).toContain("staff.reset_sent");
        expect(text).toContain("staff.password_reset");
        for (const secret of [email, token, NEW_PASSWORD, PASSWORD]) {
          expect(text, `log contains ${secret.slice(0, 8)}`).not.toContain(secret);
        }
      } finally {
        await logged.close();
      }
    });
  });
});
