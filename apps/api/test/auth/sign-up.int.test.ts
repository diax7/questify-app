import { createHash, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import {
  BREACHED_PASSWORD,
  DASHBOARD_ORIGIN,
  browserHeaders,
  createStaff,
  freshIp,
  sessionCookieOf,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const PASSWORD = "a long and new pass phrase";
const ACCEPT = { terms: "0.1", dpa: "0.1", contentRules: "0.1" };
const OUTBOUND_KEY = createHash("sha256").update("questify.outbound_mail").digest();

const tokenOf = (response: LightMyRequestResponse): string =>
  response.json<{ challengeToken: string }>().challengeToken;
const wrongCode = (code: string): string => (code === "000000" ? "000001" : "000000");

describe.skipIf(TEST_DATABASE_URL === undefined)("organizer sign-up (T-101)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const newEmail = (): string => {
    counter += 1;
    return `founder${counter}@riyadh.test`;
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

  const signUp = (
    email: string,
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    app: TestApp = test,
  ): Promise<LightMyRequestResponse> =>
    app.app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-up",
      headers: browserHeaders(headers),
      payload: {
        email,
        password: PASSWORD,
        organizerName: "Riyadh Expo",
        accept: ACCEPT,
        ...overrides,
      },
    });

  const enterCode = (challengeToken: string, code: string, app: TestApp = test) =>
    app.app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-up/code",
      headers: browserHeaders(),
      payload: { challengeToken, code },
    });

  const resend = (challengeToken: string) =>
    test.app.inject({
      method: "POST",
      url: "/v1/staff/auth/sign-up/resend",
      headers: browserHeaders(),
      payload: { challengeToken },
    });

  const pendingOf = async (email: string): Promise<number> =>
    (
      await owner<{ n: number }>("SELECT count(*)::int AS n FROM staff_signup WHERE email = $1", [
        email,
      ])
    )[0]?.n ?? -1;

  describe("a new email", () => {
    it("creates the account and its organizer after the emailed code, and signs the person in", async () => {
      const email = newEmail();
      const started = await signUp(email);
      expect(started.statusCode).toBe(200);
      expect(Object.keys(started.json()).toSorted()).toEqual([
        "challengeToken",
        "expiresInSeconds",
      ]);
      const mail = test.mail.to(email).at(-1);
      expect(mail?.subject).toContain("Your Questify sign-up code");
      expect(mail?.text).not.toContain("Riyadh Expo");

      const done = await enterCode(tokenOf(started), test.mail.lastCode(email));
      expect(done.statusCode).toBe(200);
      const body = done.json<{ account: { id: string; email: string }; organizerId: string }>();
      expect(body.account.email).toBe(email);
      const me = await test.app.inject({
        url: "/v1/staff/me",
        headers: withSession(sessionCookieOf(done)),
      });
      expect(me.json()).toMatchObject({
        id: body.account.id,
        memberships: [
          { organizerId: body.organizerId, organizerName: "Riyadh Expo", role: "owner" },
        ],
      });
      const accepted = await owner<{ document: string; version: string }>(
        "SELECT document, version FROM organizer_acceptance WHERE organizer_id = $1 ORDER BY document",
        [body.organizerId],
      );
      expect(accepted.map((row) => `${row.document}@${row.version}`)).toEqual([
        "organizer_content_rules@0.1",
        "organizer_dpa@0.1",
        "organizer_terms@0.1",
      ]);
      const audit = await owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY id",
        [body.account.id],
      );
      expect(audit.map((row) => row.action)).toEqual([
        "staff.signup",
        "organizer.create",
        "staff.session.open",
      ]);
      expect(await pendingOf(email)).toBe(0);
    });

    it("counts wrong codes and stops after five", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      const code = test.mail.lastCode(email);
      const first = await enterCode(token, wrongCode(code));
      expect(first.statusCode).toBe(401);
      expect(first.json()).toMatchObject({ code: "invalid_code", details: { attemptsLeft: 4 } });
      for (let count = 1; count < 5; count += 1) {
        await enterCode(token, wrongCode(code));
      }
      expect((await enterCode(token, code)).statusCode).toBe(410);
    });

    it("gives an Arabic name a random slug and keeps the name itself", async () => {
      const email = newEmail();
      const started = await signUp(email, { organizerName: "  فعاليات   الرياض " });
      const done = await enterCode(tokenOf(started), test.mail.lastCode(email));
      const { organizerId } = done.json<{ organizerId: string }>();
      const rows = await owner<{ name: string; slug: string }>(
        "SELECT name, slug FROM organizer WHERE id = $1",
        [organizerId],
      );
      expect(rows[0]?.name).toBe("فعاليات الرياض");
      expect(rows[0]?.slug).toMatch(/^org-[a-z0-9]{10}$/);
    });

    it("answers 410 when an account with the email appears between the two steps", async () => {
      const email = newEmail();
      const started = await signUp(email);
      await createStaff(db.owner, { email });
      expect((await enterCode(tokenOf(started), test.mail.lastCode(email))).statusCode).toBe(410);
    });
  });

  describe("an email that already has an account", () => {
    it("answers exactly like a new email, mails a note with no code, and can never complete", async () => {
      const active = newEmail();
      const disabled = newEmail();
      await createStaff(db.owner, { email: active });
      await createStaff(db.owner, { email: disabled, status: "disabled" });
      const fresh = await signUp(newEmail());
      for (const email of [active, disabled]) {
        const response = await signUp(email);
        expect(response.statusCode).toBe(fresh.statusCode);
        expect(Object.keys(response.json()).toSorted()).toEqual(
          Object.keys(fresh.json()).toSorted(),
        );
        expect(response.json<{ expiresInSeconds: number }>().expiresInSeconds).toBe(
          fresh.json<{ expiresInSeconds: number }>().expiresInSeconds,
        );
        const note = test.mail.to(email).at(-1);
        expect(note?.subject).toContain("You already have a Questify account");
        expect(note?.text).toContain(`${DASHBOARD_ORIGIN}/en/sign-in`);
        expect(note?.text).not.toMatch(/(?<![0-9])[0-9]{6}(?![0-9])/);
        const token = tokenOf(response);
        for (const guess of ["000000", "123456", "999999", "424242", "111111"]) {
          const attempt = await enterCode(token, guess);
          expect(attempt.statusCode).not.toBe(200);
        }
        expect((await enterCode(token, "000000")).statusCode).toBe(410);
      }
    });

    it("sends the note again on a resend, with the same spacing", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email });
      const token = tokenOf(await signUp(email));
      expect((await resend(token)).statusCode).toBe(429);
      await owner(
        "UPDATE staff_signup SET last_sent_at = now() - interval '61 seconds' WHERE email = $1",
        [email],
      );
      expect((await resend(token)).statusCode).toBe(200);
      expect(test.mail.to(email).map((mail) => mail.subject.includes("already"))).toEqual([
        true,
        true,
      ]);
    });
  });

  describe("refusals", () => {
    it("refuses documents accepted at another version, naming them", async () => {
      const response = await signUp(newEmail(), { accept: { ...ACCEPT, dpa: "0.0" } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        code: "acceptance_required",
        details: { documents: ["organizer_dpa"] },
      });
    });

    it("refuses a name that reads as an address, and an email that is not one", async () => {
      const named = await signUp(newEmail(), { organizerName: "Win a prize at pay-now.co" });
      expect(named.json()).toMatchObject({
        code: "invalid_organizer_name",
        details: { reason: "looks_like_address" },
      });
      expect((await signUp("not an email")).statusCode).toBe(400);
    });

    it("refuses a breached or weak password, and changes nothing when the breach list is down", async () => {
      expect((await signUp(newEmail(), { password: BREACHED_PASSWORD })).json()).toMatchObject({
        details: { reason: "breached" },
      });
      expect((await signUp(newEmail(), { password: "short" })).json()).toMatchObject({
        details: { reason: "too_short" },
      });
      const email = newEmail();
      test.breach.down = true;
      try {
        expect((await signUp(email)).statusCode).toBe(503);
      } finally {
        test.breach.down = false;
      }
      expect(await pendingOf(email)).toBe(0);
    });

    it("allows three sign-ups an hour per email and ten per address", async () => {
      const email = newEmail();
      for (let count = 0; count < 3; count += 1) {
        expect((await signUp(email)).statusCode).toBe(200);
      }
      expect((await signUp(email)).statusCode).toBe(429);
      const ip = freshIp();
      for (let count = 0; count < 10; count += 1) {
        expect((await signUp(newEmail(), {}, { "x-forwarded-for": ip })).statusCode).toBe(200);
      }
      expect((await signUp(newEmail(), {}, { "x-forwarded-for": ip })).statusCode).toBe(429);
    });

    it("answers 503 and stores nothing once the day's mail budget is spent, so sign-in codes keep their room", async () => {
      await db.owner.query(
        "INSERT INTO auth_throttle (bucket, key) SELECT 'outbound_mail', $1 FROM generate_series(1, 400)",
        [OUTBOUND_KEY],
      );
      try {
        const email = newEmail();
        const response = await signUp(email);
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: "email_unavailable" });
        expect(await pendingOf(email)).toBe(0);
        expect(test.mail.to(email)).toEqual([]);
      } finally {
        await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'outbound_mail'");
      }
    });

    it("drops the pending sign-up when its email cannot be sent", async () => {
      const email = newEmail();
      test.mail.failing = true;
      try {
        expect((await signUp(email)).statusCode).toBe(503);
      } finally {
        test.mail.failing = false;
      }
      expect(await pendingOf(email)).toBe(0);
    });
  });

  describe("the day's mail budget", () => {
    it("lets requests that arrive together both through: they wait for the counter, not fail", async () => {
      const { takeOutboundMail } = await import("#src/auth/outbound");
      const results = await Promise.all(
        Array.from({ length: 6 }, () => takeOutboundMail(test.pool)),
      );
      expect(results).toEqual([true, true, true, true, true, true]);
      await db.owner.query("DELETE FROM auth_throttle WHERE bucket = 'outbound_mail'");
    });
  });

  describe("a resend", () => {
    it("sends a new code that replaces the old one", async () => {
      const email = newEmail();
      const token = tokenOf(await signUp(email));
      const first = test.mail.lastCode(email);
      await owner(
        "UPDATE staff_signup SET last_sent_at = now() - interval '61 seconds' WHERE email = $1",
        [email],
      );
      expect((await resend(token)).statusCode).toBe(200);
      const second = test.mail.lastCode(email);
      if (first !== second) {
        expect((await enterCode(token, first)).statusCode).toBe(401);
      }
      expect((await enterCode(token, second)).statusCode).toBe(200);
    });
  });

  describe("creating another organizer while signed in", () => {
    it("creates it with the person as owner, and allows five a day", async () => {
      const email = newEmail();
      await createStaff(db.owner, { email, password: "correct horse battery staple" });
      const cookie = await signInFully(test, email);
      const create = (name: string, accept = ACCEPT, key: string = randomUUID()) =>
        test.app.inject({
          method: "POST",
          url: "/v1/staff/organizers",
          headers: withSession(cookie, { "idempotency-key": key }),
          payload: { name, accept },
        });
      const made = await create("Second Venture", ACCEPT, "double-click");
      expect(made.statusCode).toBe(201);
      const { organizerId } = made.json<{ organizerId: string }>();
      const replay = await create("Second Venture", ACCEPT, "double-click");
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.json()).toEqual({ organizerId });
      const owned = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM organizer_member WHERE staff_user_id = (SELECT id FROM staff_user WHERE email = $1)",
        [email],
      );
      expect(owned[0]?.n).toBe(1);
      const me = await test.app.inject({ url: "/v1/staff/me", headers: withSession(cookie) });
      expect(me.json()).toMatchObject({ memberships: [{ organizerId, role: "owner" }] });
      expect((await create("Third", { ...ACCEPT, terms: "0.0" })).statusCode).toBe(422);
      for (let count = 1; count < 5; count += 1) {
        expect((await create(`Venture ${count}`)).statusCode).toBe(201);
      }
      expect((await create("One too many")).statusCode).toBe(429);
    });
  });

  describe("what the logs hold", () => {
    it("records the sign-up events and none of the email, password, code or token", async () => {
      const lines: string[] = [];
      const logged = await startApp(db, {
        ...loggerOptions(testConfig()),
        level: "debug",
        stream: { write: (line: string) => void lines.push(line) },
      });
      try {
        const email = newEmail();
        const started = await signUp(email, {}, {}, logged);
        const token = tokenOf(started);
        const code = logged.mail.lastCode(email);
        await enterCode(token, code, logged);
        const text = lines.join("\n");
        expect(text).toContain("staff.sign_up_started");
        expect(text).toContain("staff.signed_up");
        for (const secret of [email, PASSWORD, code, token, "Riyadh Expo"]) {
          expect(text, `log contains ${secret.slice(0, 6)}`).not.toContain(secret);
        }
      } finally {
        await logged.close();
      }
    });
  });
});
