import { createHash, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { PLAYER_SIGN_IN_LIMITS } from "#src/auth/limits";
import { freshIp, startApp, testConfig, type TestApp } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Sent = { challengeToken: string };
type Issued = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  player: { id: string; username: string };
};

const L = PLAYER_SIGN_IN_LIMITS;
const riyadhYear = () =>
  Number(
    new Intl.DateTimeFormat("en", { timeZone: "Asia/Riyadh", year: "numeric" }).format(new Date()),
  );

/**
 * Player sign-in over HTTP (T-107): codes by SMS and email, the profile step, tokens, refresh and sign-out, every
 * limit, and what reaches the log. The database rules themselves are in test/db/player-sign-in.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("player sign-in", () => {
  let db: TestDatabase;
  let test: TestApp;
  let lines: string[] = [];
  let counter = 0;

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
    test.sms.next = { kind: "sent" };
    test.mail.failing = false;
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A Saudi mobile nobody has used yet, as stored. */
  const newPhone = (): string => {
    counter += 1;
    return `+9665${String(10_000_000 + counter).slice(-8)}`;
  };
  const newEmail = (): string => {
    counter += 1;
    return `player${counter}@najd.sa`;
  };

  const post = (
    path: string,
    payload: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: "POST",
      url: `/v1/auth/${path}`,
      headers: { "x-forwarded-for": freshIp(), ...headers },
      payload,
    });

  const askCode = (value: string, extra: object = {}, headers: Record<string, string> = {}) =>
    post("code", { channel: value.includes("@") ? "email" : "phone", value, ...extra }, headers);

  const codeFor = (contact: string): string =>
    contact.includes("@") ? test.mail.lastCode(contact) : test.sms.lastCode(contact);

  /** Asks for a code and returns the challenge token and the code that was sent. */
  const challenge = async (contact: string): Promise<{ token: string; code: string }> => {
    const asked = await askCode(contact);
    expect(asked.statusCode).toBe(202);
    return { token: asked.json<Sent>().challengeToken, code: codeFor(contact) };
  };

  /** Signs up a new player through the endpoints and returns the issued tokens. */
  const signUp = async (contact = newPhone()): Promise<Issued & { contact: string }> => {
    const { token, code } = await challenge(contact);
    const verified = await post("verify", { challengeToken: token, code });
    const { signupToken } = verified.json<{ signupToken: string }>();
    counter += 1;
    const created = await post("signup", {
      signupToken,
      username: `runner_${counter}`,
      birthYear: 1998,
    });
    expect(created.statusCode).toBe(201);
    return { ...created.json<Issued>(), contact };
  };

  /** A signup token for a new phone, after its right code. */
  const signupToken = async (): Promise<string> => {
    const { token, code } = await challenge(newPhone());
    return (await post("verify", { challengeToken: token, code })).json<{ signupToken: string }>()
      .signupToken;
  };

  const meStatus = async (accessToken: string): Promise<number> => {
    const response = await test.app.inject({
      method: "POST",
      url: `/v1/quests/${randomUUID()}/complete`,
      headers: { authorization: `Bearer ${accessToken}`, "idempotency-key": randomUUID() },
      payload: { proof: { type: "code", code: "X" } },
    });
    // 404 (no such quest) means the guard let the player through; 401 means the token is dead.
    return response.statusCode;
  };

  describe("asking for a code", () => {
    it("texts a Saudi mobile, in Arabic by default, and says when to resend and when to offer email", async () => {
      const phone = newPhone();
      const asked = await askCode(`0${phone.slice(4, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`);
      expect(asked.statusCode).toBe(202);
      expect(asked.headers["cache-control"]).toBe("no-store");
      expect(asked.json()).toEqual({
        challengeToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
        emailFallbackAfterSeconds: 30,
      });
      const [sms] = test.sms.sent.filter((message) => message.to === phone);
      expect(sms?.text).toMatch(/^رمز الدخول إلى كويستفاي: [0-9]{6}\. لا تشاركه مع أحد\.$/);
    });

    it("texts in English when asked, and reads Arabic-Indic digits", async () => {
      const phone = newPhone();
      const eastern = phone
        .slice(4)
        .replace(/[0-9]/g, (digit) => String.fromCodePoint(0x0660 + Number(digit)));
      expect((await askCode(`+966${eastern}`, { lang: "en" })).statusCode).toBe(202);
      expect(test.sms.sent.at(-1)).toEqual({
        to: phone,
        text: expect.stringMatching(/^Your Questify sign-in code is [0-9]{6}\. Do not share it\.$/),
      });
    });

    it("emails a code, without an email offer", async () => {
      const email = newEmail();
      const asked = await askCode(email.toUpperCase());
      expect(asked.statusCode).toBe(202);
      expect(asked.json()).not.toHaveProperty("emailFallbackAfterSeconds");
      expect(test.mail.lastCode(email)).toMatch(/^[0-9]{6}$/);
    });

    it("answers the same for a contact with an account and one without", async () => {
      const known = await signUp();
      const [first, second] = [await askCode(known.contact), await askCode(newPhone())];
      expect(first.statusCode).toBe(second.statusCode);
      expect(Object.keys(first.json()).toSorted()).toEqual(Object.keys(second.json()).toSorted());
    });

    it("refuses a number that is not a Saudi mobile and offers email; nothing is sent", async () => {
      const before = test.sms.sent.length;
      for (const value of ["+971501234567", "0112345678", "12345"]) {
        const refused = await askCode(value);
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "phone_not_supported",
          details: { emailOffered: true },
        });
      }
      expect(test.sms.sent).toHaveLength(before);
    });

    it("refuses an unusable email and a malformed body", async () => {
      expect((await post("code", { channel: "email", value: "not an email" })).statusCode).toBe(
        400,
      );
      expect((await post("code", { channel: "fax", value: "1" })).statusCode).toBe(400);
      expect(
        (await post("code", { channel: "phone", value: newPhone(), extra: true })).statusCode,
      ).toBe(400);
      expect(
        (await post("verify", { challengeToken: "A".repeat(44), code: "123456" })).statusCode,
      ).toBe(400);
      expect(
        (await post("verify", { challengeToken: `!${"A".repeat(43)}`, code: "123456" })).statusCode,
      ).toBe(400);
      expect((await askCode(newPhone(), { lang: "ar" })).statusCode).toBe(202);
      expect((await askCode(newPhone(), { lang: "fr" })).statusCode).toBe(400);
    });

    it("keeps the code alive when Msegat's answer is unknown: the app offers email after 30 seconds", async () => {
      test.sms.next = { kind: "unknown", reason: "timeout" };
      const phone = newPhone();
      const { token, code } = await challenge(phone);
      expect((await post("verify", { challengeToken: token, code })).statusCode).toBe(200);
    });

    it("answers 503 with an email offer when Msegat refuses, and ends that code", async () => {
      test.sms.next = { kind: "refused", reason: "1060" };
      const phone = newPhone();
      const refused = await askCode(phone);
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({
        code: "sms_unavailable",
        details: { emailOffered: true },
      });
      expect(
        await owner(
          "SELECT 1 FROM player_login_challenge WHERE contact = $1 AND cancelled_at IS NULL",
          [phone],
        ),
      ).toEqual([]);
      expect(lines.join("")).toContain('"reason":"1060"');
    });

    it("answers 503 when the email cannot be sent", async () => {
      test.mail.failing = true;
      const refused = await askCode(newEmail());
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ code: "email_unavailable" });
    });

    it("ends the SMS code when the email fallback names it (FR-1812)", async () => {
      const sms = await challenge(newPhone());
      const email = newEmail();
      expect((await askCode(email, { previous: sms.token })).statusCode).toBe(202);
      const late = await post("verify", { challengeToken: sms.token, code: sms.code });
      expect(late.statusCode).toBe(410);
    });

    it("keeps the SMS code when the email fallback could not be sent", async () => {
      const sms = await challenge(newPhone());
      test.mail.failing = true;
      expect((await askCode(newEmail(), { previous: sms.token })).statusCode).toBe(503);
      const still = await post("verify", { challengeToken: sms.token, code: sms.code });
      expect(still.statusCode).toBe(200);
    });

    it("ignores a previous token that is unknown", async () => {
      const unknown = "A".repeat(43);
      expect((await askCode(newEmail(), { previous: unknown })).statusCode).toBe(202);
    });
  });

  describe("limits", () => {
    it("allows 5 codes an hour per contact, then 429 with retry-after (first and resent alike)", async () => {
      const phone = newPhone();
      for (let n = 0; n < L.codesPerContactHour.max; n += 1) {
        expect((await askCode(phone)).statusCode).toBe(202);
      }
      const stopped = await askCode(phone);
      expect(stopped.statusCode).toBe(429);
      const wait = Number(stopped.headers["retry-after"]);
      expect(wait).toBeGreaterThan(0);
      expect(stopped.json()).toMatchObject({
        code: "too_many_attempts",
        details: { retryAfterSeconds: wait },
      });
    });

    it("counts resends in the same limits: the sixth send in an hour is refused", async () => {
      const phone = newPhone();
      let token = "";
      for (let n = 0; n < L.codesPerContactHour.max - 1; n += 1) {
        token = (await challenge(phone)).token;
      }
      const backdate = () =>
        owner(
          "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE contact = $1",
          [phone],
        );
      await backdate();
      expect((await post("resend", { challengeToken: token })).statusCode).toBe(202);
      await backdate();
      const stopped = await post("resend", { challengeToken: token });
      expect(stopped.statusCode).toBe(429);
      expect(stopped.json()).toMatchObject({ code: "too_many_attempts" });
    });

    it("allows 10 codes an hour per install, across contacts", async () => {
      const device = { "x-device-id": randomUUID() };
      for (let n = 0; n < L.codesPerDeviceHour.max; n += 1) {
        expect((await askCode(newPhone(), {}, device)).statusCode).toBe(202);
      }
      expect((await askCode(newPhone(), {}, device)).statusCode).toBe(429);
      expect((await askCode(newPhone(), {}, { "x-device-id": randomUUID() })).statusCode).toBe(202);
    });

    it("stops wrong codes for a contact after 10 in 15 minutes, across codes", async () => {
      const phone = newPhone();
      // 3 + 3 + 3 + 1 wrong guesses over four codes, then a fifth code (5 an hour) with the right one.
      for (const guesses of [3, 3, 3, 1]) {
        const { token } = await challenge(phone);
        for (let n = 0; n < guesses; n += 1) {
          const wrong = await post("verify", { challengeToken: token, code: "000000" });
          expect(wrong.statusCode).toBe(401);
        }
      }
      const { token, code } = await challenge(phone);
      const stopped = await post("verify", { challengeToken: token, code });
      expect(stopped.statusCode).toBe(429);
      expect(Number(stopped.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("refuses SMS for the whole platform once the hour's ceiling is spent, and email once the day's is", async () => {
      const ceilings = [
        ["sms_platform", "questify.sms_platform", L.smsPerHour.max, newPhone(), "sms_unavailable"],
        [
          "player_email_platform",
          "questify.player_email_platform",
          L.playerEmailsPerDay.max,
          newEmail(),
          "email_unavailable",
        ],
      ] as const;
      for (const [bucket, name, max, contact, code] of ceilings) {
        const key = createHash("sha256").update(name).digest();
        // Exactly the ceiling: earlier sends in this file are in the same bucket.
        await owner("DELETE FROM auth_throttle WHERE bucket = $1", [bucket]);
        await owner(
          "INSERT INTO auth_throttle (bucket, key, at) SELECT $1, $2, now() FROM generate_series(1, $3)",
          [bucket, key, max],
        );
        try {
          const refused = await askCode(contact);
          expect(refused.statusCode).toBe(503);
          expect(refused.json()).toMatchObject({ code });
        } finally {
          await owner("DELETE FROM auth_throttle WHERE bucket = $1", [bucket]);
        }
      }
    });
  });

  describe("verifying", () => {
    it("counts down three tries, then ends the code", async () => {
      const { token, code } = await challenge(newPhone());
      for (const left of [2, 1, 0]) {
        const wrong = await post("verify", { challengeToken: token, code: "000000" });
        expect(wrong.statusCode).toBe(401);
        expect(wrong.json()).toMatchObject({
          code: "invalid_code",
          details: { attemptsLeft: left },
        });
      }
      expect((await post("verify", { challengeToken: token, code })).statusCode).toBe(410);
    });

    it("accepts a code typed with Arabic-Indic digits", async () => {
      const { token, code } = await challenge(newPhone());
      const eastern = code.replace(/[0-9]/g, (digit) =>
        String.fromCodePoint(0x0660 + Number(digit)),
      );
      const verified = await post("verify", { challengeToken: token, code: eastern });
      expect(verified.json()).toMatchObject({ isNew: true });
    });

    it("signs a returning player in, with a working access token", async () => {
      const known = await signUp();
      const { token, code } = await challenge(known.contact);
      const verified = await post("verify", { challengeToken: token, code });
      expect(verified.statusCode).toBe(200);
      const issued = verified.json<Issued>();
      expect(issued).toEqual({
        accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expiresInSeconds: 3600,
        player: known.player,
      });
      expect(await meStatus(issued.accessToken)).toBe(404);
    });

    it("tells a banned player after a right code, and issues nothing", async () => {
      const known = await signUp();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [known.player.id]);
      const { token, code } = await challenge(known.contact);
      const refused = await post("verify", { challengeToken: token, code });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "account_banned" });
    });

    it("answers 410 for an unknown challenge", async () => {
      const unknown = await post("verify", { challengeToken: "B".repeat(43), code: "123456" });
      expect(unknown.statusCode).toBe(410);
    });
  });

  describe("resending", () => {
    it("waits 60 seconds, then sends a new code that replaces the old one", async () => {
      const phone = newPhone();
      const { token, code } = await challenge(phone);
      const early = await post("resend", { challengeToken: token });
      expect(early.statusCode).toBe(429);
      const wait = Number(early.headers["retry-after"]);
      expect(wait).toBeGreaterThan(0);
      expect(early.json()).toMatchObject({
        code: "resend_too_soon",
        details: { retryAfterSeconds: wait },
      });
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE contact = $1",
        [phone],
      );
      const resent = await post("resend", { challengeToken: token, lang: "en" });
      expect(resent.statusCode).toBe(202);
      expect(resent.json()).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
      const fresh = test.sms.lastCode(phone);
      if (fresh !== code) {
        expect((await post("verify", { challengeToken: token, code })).statusCode).toBe(401);
      }
      expect((await post("verify", { challengeToken: token, code: fresh })).statusCode).toBe(200);
    });

    it("stops after three resends, and answers 410 for an unknown challenge", async () => {
      const email = newEmail();
      const { token } = await challenge(email);
      for (let n = 0; n < L.maxResends; n += 1) {
        await owner(
          "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE contact = $1",
          [email],
        );
        expect((await post("resend", { challengeToken: token })).statusCode).toBe(202);
      }
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE contact = $1",
        [email],
      );
      const limit = await post("resend", { challengeToken: token });
      expect(limit.statusCode).toBe(429);
      expect(limit.json()).toMatchObject({ code: "resend_limit" });
      expect((await post("resend", { challengeToken: "C".repeat(43) })).statusCode).toBe(410);
    });

    it("ends the code when the resent SMS is refused", async () => {
      const phone = newPhone();
      const { token, code } = await challenge(phone);
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE contact = $1",
        [phone],
      );
      test.sms.next = { kind: "refused", reason: "M0037" };
      expect((await post("resend", { challengeToken: token })).statusCode).toBe(503);
      expect((await post("verify", { challengeToken: token, code })).statusCode).toBe(410);
    });
  });

  describe("signing up", () => {
    it("creates the player from the profile step, with its name, and audits it", async () => {
      const made = await signUp();
      expect(made.player.username).toMatch(/^runner_/);
      expect(await meStatus(made.accessToken)).toBe(404);
      expect(
        await owner("SELECT action FROM audit_log WHERE target_id = $1", [made.player.id]),
      ).toEqual([{ action: "player.signup" }]);
    });

    it("signs up by email too, and an Arabic username", async () => {
      const email = newEmail();
      const { token, code } = await challenge(email);
      const { signupToken: fromEmail } = (
        await post("verify", { challengeToken: token, code })
      ).json<{ signupToken: string }>();
      counter += 1;
      const created = await post("signup", {
        signupToken: fromEmail,
        username: `لاعب_${counter}`,
        birthYear: 2000,
      });
      expect(created.statusCode).toBe(201);
      expect(
        await owner("SELECT email FROM player_contact WHERE player_id = $1", [
          created.json<Issued>().player.id,
        ]),
      ).toEqual([{ email }]);
    });

    it("refuses a bad username with its reason, and keeps the token", async () => {
      const token = await signupToken();
      for (const [username, reason] of [
        ["ab", "length"],
        ["has space", "characters"],
        ["abcلاعب", "mixed_scripts"],
      ]) {
        const refused = await post("signup", { signupToken: token, username, birthYear: 1990 });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({ code: "invalid_username", details: { reason } });
      }
      counter += 1;
      const created = await post("signup", {
        signupToken: token,
        username: `kept_${counter}`,
        birthYear: 1990,
      });
      expect(created.statusCode).toBe(201);
    });

    it("answers each refusal from the database with its own code", async () => {
      const taken = await signUp();
      const token = await signupToken();
      const answers = [
        [{ username: taken.player.username.toUpperCase(), birthYear: 1990 }, 409, "username_taken"],
        [{ username: "future_one", birthYear: riyadhYear() + 1 }, 422, "invalid_birth_year"],
        [{ username: "too_young_x", birthYear: riyadhYear() - 12 }, 422, "too_young"],
        [{ username: "after_young", birthYear: 1990 }, 410, "signup_expired"],
      ] as const;
      for (const [fields, status, code] of answers) {
        const refused = await post("signup", { signupToken: token, ...fields });
        expect(refused.statusCode).toBe(status);
        expect(refused.json()).toMatchObject({ code });
      }
    });

    it("answers contact_taken when the same contact signed up in parallel", async () => {
      const phone = newPhone();
      const { token, code } = await challenge(phone);
      const { signupToken: first } = (await post("verify", { challengeToken: token, code })).json<{
        signupToken: string;
      }>();
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`raced_${counter}`],
      );
      await owner("INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, $2)", [
        player?.id,
        phone,
      ]);
      const refused = await post("signup", {
        signupToken: first,
        username: `second_${counter}`,
        birthYear: 1990,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "contact_taken" });
    });
  });

  describe("sessions", () => {
    it("rotate on refresh: the new pair works, the old access token ends", async () => {
      const made = await signUp();
      const refreshed = await post("refresh", { refreshToken: made.refreshToken });
      expect(refreshed.statusCode).toBe(200);
      const next = refreshed.json<Issued>();
      expect(next.player).toEqual(made.player);
      expect(await meStatus(next.accessToken)).toBe(404);
      expect(await meStatus(made.accessToken)).toBe(401);
    });

    it("answer 401 to an unknown refresh token and to a reused one, which ends the family", async () => {
      expect((await post("refresh", { refreshToken: "D".repeat(43) })).statusCode).toBe(401);
      const made = await signUp();
      const next = (await post("refresh", { refreshToken: made.refreshToken })).json<Issued>();
      await post("refresh", { refreshToken: next.refreshToken });
      expect((await post("refresh", { refreshToken: made.refreshToken })).statusCode).toBe(401);
      expect(lines.join("")).toContain("player.refresh_reuse");
    });

    it("end on sign-out by the refresh token, even with an expired access token; always 204", async () => {
      const made = await signUp();
      await owner("UPDATE player_session SET expires_at = now() WHERE player_id = $1", [
        made.player.id,
      ]);
      const out = await post("logout", { refreshToken: made.refreshToken });
      expect(out.statusCode).toBe(204);
      expect((await post("refresh", { refreshToken: made.refreshToken })).statusCode).toBe(401);
      expect((await post("logout", { refreshToken: "E".repeat(43) })).statusCode).toBe(204);
    });

    it("complete a quest end to end: sign up, enroll, complete", async () => {
      const ids = await seedTwoTenants(db.owner);
      const made = await signUp();
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [ids.orgA, ids.eventA, made.player.id],
      );
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        ids.eventA,
      ]);
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, $2, 'enter_code', 'Gate', 15, 1, '{"code":"NAJD2030"}') RETURNING id`,
        [ids.eventA, general?.id],
      );
      const done = await test.app.inject({
        method: "POST",
        url: `/v1/quests/${quest?.id}/complete`,
        headers: {
          authorization: `Bearer ${made.accessToken}`,
          "idempotency-key": randomUUID(),
        },
        payload: { proof: { type: "code", code: "najd2030" } },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ points: 15, score: 15 });
    });
  });

  it("never writes a phone, an email, a code or a token to the log", async () => {
    const phone = newPhone();
    const email = newEmail();
    const sms = await challenge(phone);
    const mail = await challenge(email);
    await post("verify", { challengeToken: sms.token, code: "000000" });
    const verified = await post("verify", { challengeToken: mail.token, code: mail.code });
    const log = lines.join("");
    expect(log).toContain("player.code_sent");
    for (const secret of [
      phone,
      phone.slice(1),
      email,
      sms.code,
      mail.code,
      sms.token,
      mail.token,
    ]) {
      expect(log).not.toContain(secret);
    }
    expect(log).not.toContain(verified.json<{ signupToken: string }>().signupToken);
  });
});
