import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { freshIp, startApp, testConfig, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Changing or adding a phone or email over HTTP (T-108): the code goes to the new contact and says what it is for; the
 * account takes it only with the right code; the old value and the other channel are told; nothing names a contact in
 * the logs; every request counts in the player's window.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("changing a contact", () => {
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

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newPhone = () => {
    counter += 1;
    return `+9665${String(30_000_000 + counter).slice(-8)}`;
  };

  /** A player with a bearer session and these contacts. */
  const newPlayer = async (contact: { phone?: string; email?: string }) => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`contact_http_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      contact.phone ?? null,
      contact.email ?? null,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const post = (
    path: "code" | "verify",
    token: string,
    payload: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: "POST",
      url: `/v1/me/contact/${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": freshIp(),
        ...(path === "verify" ? { "idempotency-key": randomUUID() } : {}),
        ...headers,
      },
      payload,
    });

  const spend = (bucket: string, name: string, count: number) =>
    owner(
      "INSERT INTO auth_throttle (bucket, key, at) SELECT $1, $2, now() FROM generate_series(1, $3)",
      [bucket, createHash("sha256").update(name).digest(), count],
    );
  const clear = (bucket: string) => owner("DELETE FROM auth_throttle WHERE bucket = $1", [bucket]);

  /** The log lines written so far, as objects. */
  const logged = () => lines.map((line) => JSON.parse(line) as Row);

  const contactOf = async (player: string) =>
    (
      await owner<{ phone_e164: string | null; email: string | null }>(
        "SELECT phone_e164, email FROM player_contact WHERE player_id = $1",
        [player],
      )
    )[0];

  describe("a phone-only player adding an email", () => {
    it("sends a code that says what it is for, adds the email with it, and tells the phone", async () => {
      const phone = newPhone();
      const player = await newPlayer({ phone });
      const asked = await post("code", player.token, {
        channel: "email",
        value: " Sara@Najd.SA ",
        lang: "en",
      });
      expect(asked.statusCode).toBe(202);
      expect(asked.json()).toEqual({ challengeToken: expect.any(String), expiresInSeconds: 300 });
      const mail = test.mail.to("sara@najd.sa").at(-1);
      expect(mail?.subject).toContain("add this email");
      expect(mail?.subject).not.toMatch(/sign-in code/i);
      expect(await contactOf(player.id)).toEqual({ phone_e164: phone, email: null });

      const code = test.mail.lastCode("sara@najd.sa");
      const done = await post("verify", player.token, {
        challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
        code: [...code].map((digit) => String.fromCharCode(0x0660 + Number(digit))).join(""),
        lang: "ar",
      });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({
        identifiers: { phone: `•••• ${phone.slice(-4)}`, email: "s•••@najd.sa" },
      });
      expect(await contactOf(player.id)).toEqual({ phone_e164: phone, email: "sara@najd.sa" });
      const notice = test.sms.sent.filter((sms) => sms.to === phone).at(-1);
      expect(notice?.text).toBe(
        "تغيّرت بيانات دخولك في كويستفاي. إن لم تكن أنت، تواصل معنا من التطبيق.",
      );
      expect(notice?.text).not.toContain("sara");
      const log = lines.join("");
      expect(log).toContain('"event":"player.contact_changed"');
      expect(log).toContain('"event":"player.notice_sent"');
      // The contacts themselves, not digit runs: a log line's hex address tag may hold any digits.
      for (const contact of ["sara@najd.sa", "Sara@Najd.SA", phone, phone.slice(4)]) {
        expect(log).not.toContain(contact);
      }
    });
  });

  describe("changing a phone", () => {
    it("texts the new number, then tells the old number and the email, never naming the new number", async () => {
      const old = newPhone();
      const player = await newPlayer({ phone: old, email: `p${counter}@najd.sa` });
      const fresh = newPhone();
      const asked = await post("code", player.token, {
        channel: "phone",
        value: `0${fresh.slice(4)}`,
        lang: "ar",
      });
      expect(asked.statusCode).toBe(202);
      const text = test.sms.sent.filter((sms) => sms.to === fresh).at(-1)?.text ?? "";
      expect(text).toContain("رمز إضافة هذا الرقم");
      expect(text.length).toBeLessThanOrEqual(70);
      const done = await post("verify", player.token, {
        challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
        code: test.sms.lastCode(fresh),
        lang: "en",
      });
      expect(done.statusCode).toBe(200);
      expect((await contactOf(player.id))?.phone_e164).toBe(fresh);
      expect(test.sms.sent.filter((sms) => sms.to === old).at(-1)?.text).toBe(
        "Your Questify sign-in details changed. If this was not you, contact us in the app.",
      );
      const email = test.mail.sent.at(-1);
      expect(email?.text).toContain("The phone number on your Questify account was changed.");
      expect(email?.text).not.toContain(fresh.slice(-8));
    });

    it("keeps the change when a notice fails", async () => {
      const player = await newPlayer({ phone: newPhone(), email: `fail${counter}@najd.sa` });
      const fresh = newPhone();
      const asked = await post("code", player.token, { channel: "phone", value: fresh });
      test.mail.failing = true;
      const done = await post("verify", player.token, {
        challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
        code: test.sms.lastCode(fresh),
      });
      expect(done.statusCode).toBe(200);
      expect((await contactOf(player.id))?.phone_e164).toBe(fresh);
      expect(lines.join("")).toContain('"event":"player.notice_failed"');
    });
  });

  it("logs a refused notice SMS as failed, and keeps the change", async () => {
    const old = newPhone();
    const player = await newPlayer({ phone: old });
    const asked = await post("code", player.token, {
      channel: "email",
      value: `notice${counter}@najd.sa`,
    });
    test.sms.next = { kind: "refused", reason: "gateway" };
    const done = await post("verify", player.token, {
      challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
      code: test.mail.lastCode(`notice${counter}@najd.sa`),
    });
    expect(done.statusCode).toBe(200);
    expect((await contactOf(player.id))?.email).toBe(`notice${counter}@najd.sa`);
    expect(lines.join("")).toContain('"event":"player.notice_failed"');
    expect(lines.join("")).not.toContain('"event":"player.notice_sent"');
  });

  it("logs each step by its event and channel, never a contact", async () => {
    const old = newPhone();
    const player = await newPlayer({ phone: old });
    const email = `log${counter}@najd.sa`;
    const asked = await post("code", player.token, { channel: "email", value: email });
    expect(test.mail.to(email).at(-1)?.text).toContain("صالح لمدة 5 دقائق");
    const challengeToken = asked.json<{ challengeToken: string }>().challengeToken;
    await post("verify", player.token, { challengeToken, code: "000000" });
    test.sms.next = { kind: "unknown", reason: "timeout" };
    await post("verify", player.token, { challengeToken, code: test.mail.lastCode(email) });
    test.sms.next = { kind: "sent" };
    const fresh = newPhone();
    await post("code", player.token, { channel: "phone", value: fresh });
    test.sms.next = { kind: "refused", reason: "gateway" };
    await post("code", player.token, { channel: "phone", value: newPhone() });
    for (const event of [
      { event: "player.contact_code_sent", channel: "email" },
      { event: "player.contact_code_failed" },
      { event: "player.contact_changed", channel: "email", kind: "added" },
      { event: "player.notice_sent", channel: "phone", outcome: "unknown_timeout" },
      { event: "player.contact_code_sent", channel: "phone" },
      { event: "player.sms_refused", gateway: "recording", reason: "gateway" },
    ]) {
      expect(logged()).toContainEqual(expect.objectContaining(event));
    }
    // Three requests so far; two more fill the window of five, and the sixth is refused.
    test.sms.next = { kind: "sent" };
    await post("code", player.token, { channel: "phone", value: newPhone() });
    await post("code", player.token, { channel: "phone", value: newPhone() });
    const window = await post("code", player.token, { channel: "phone", value: newPhone() });
    expect(window.statusCode).toBe(429);
    expect(logged()).toContainEqual(
      expect.objectContaining({ event: "player.throttled", step: "contact_window" }),
    );
    for (const contact of [email, old, fresh]) {
      expect(lines.join("")).not.toContain(contact);
    }
  });

  describe("limits and outages", () => {
    it("holds a new contact to the sign-in send windows, whoever asks", async () => {
      const target = newPhone();
      for (let i = 0; i < 5; i += 1) {
        const player = await newPlayer({ phone: newPhone() });
        expect(
          (await post("code", player.token, { channel: "phone", value: target })).statusCode,
        ).toBe(202);
      }
      const late = await newPlayer({ phone: newPhone() });
      const blocked = await post("code", late.token, { channel: "phone", value: target });
      expect(blocked.statusCode).toBe(429);
      expect(logged()).toContainEqual(
        expect.objectContaining({
          event: "player.throttled",
          step: "contact_code",
          channel: "phone",
        }),
      );
    });

    it("says SMS or email is unavailable when the platform budget is spent, and opens nothing", async () => {
      const player = await newPlayer({ phone: newPhone() });
      await spend("sms_platform", "questify.sms_platform", 5000);
      try {
        const sms = await post("code", player.token, { channel: "phone", value: newPhone() });
        expect([sms.statusCode, sms.json<{ code: string }>().code]).toEqual([
          503,
          "sms_unavailable",
        ]);
        expect(logged()).toContainEqual(
          expect.objectContaining({ event: "player.budget_spent", channel: "phone" }),
        );
      } finally {
        await clear("sms_platform");
      }
      expect(
        await owner("SELECT 1 FROM player_contact_challenge WHERE player_id = $1", [player.id]),
      ).toEqual([]);
      await spend("player_email_platform", "questify.player_email_platform", 1000);
      try {
        const mail = await post("code", player.token, {
          channel: "email",
          value: `b${counter}@najd.sa`,
        });
        expect([mail.statusCode, mail.json<{ code: string }>().code]).toEqual([
          503,
          "email_unavailable",
        ]);
      } finally {
        await clear("player_email_platform");
      }
    });

    it("says email is unavailable when the code email cannot be sent", async () => {
      const player = await newPlayer({ phone: newPhone() });
      test.mail.failing = true;
      const refused = await post("code", player.token, {
        channel: "email",
        value: `down${counter}@najd.sa`,
      });
      expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        503,
        "email_unavailable",
      ]);
      expect(logged()).toContainEqual(
        expect.objectContaining({ event: "player.email_unavailable", reason: "EmailSendError" }),
      );
    });

    it("texts the code in English when asked", async () => {
      const player = await newPlayer({ email: `en${counter}@najd.sa` });
      const fresh = newPhone();
      await post("code", player.token, { channel: "phone", value: fresh, lang: "en" });
      expect(test.sms.sent.filter((sms) => sms.to === fresh).at(-1)?.text).toBe(
        `Your code to add this number to a Questify account: ${test.sms.lastCode(fresh)}. Do not share it.`,
      );
    });

    it("skips a notice when the platform budget is spent, and keeps the change", async () => {
      const old = newPhone();
      const player = await newPlayer({ phone: old });
      const email = `skip${counter}@najd.sa`;
      const asked = await post("code", player.token, { channel: "email", value: email });
      await spend("sms_platform", "questify.sms_platform", 5000);
      try {
        const done = await post("verify", player.token, {
          challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
          code: test.mail.lastCode(email),
        });
        expect(done.statusCode).toBe(200);
      } finally {
        await clear("sms_platform");
      }
      expect(logged()).toContainEqual(
        expect.objectContaining({ event: "player.notice_skipped", channel: "phone" }),
      );
      expect(test.sms.sent.filter((sms) => sms.to === old)).toEqual([]);
      expect((await contactOf(player.id))?.email).toBe(email);
    });

    it("stops a player after too many wrong codes, across challenges", async () => {
      const player = await newPlayer({ phone: newPhone() });
      for (let round = 0; round < 4; round += 1) {
        const asked = await post("code", player.token, {
          channel: "email",
          value: `w${round}${counter}@najd.sa`,
        });
        const challengeToken = asked.json<{ challengeToken: string }>().challengeToken;
        for (let i = 0; i < 3 && round * 3 + i < 10; i += 1) {
          expect(
            (await post("verify", player.token, { challengeToken, code: "000000" })).statusCode,
          ).toBe(422);
        }
        if (round === 3) {
          const blocked = await post("verify", player.token, { challengeToken, code: "000000" });
          expect(blocked.statusCode).toBe(429);
        }
      }
    });
  });

  describe("refusals", () => {
    it("answers a wrong code with 422 and the tries left, then the challenge is over", async () => {
      const player = await newPlayer({ phone: newPhone() });
      const fresh = newPhone();
      const asked = await post("code", player.token, { channel: "phone", value: fresh });
      const challengeToken = asked.json<{ challengeToken: string }>().challengeToken;
      for (const left of [2, 1, 0]) {
        const wrong = await post("verify", player.token, { challengeToken, code: "000000" });
        expect([wrong.statusCode, wrong.json()]).toMatchObject([
          422,
          { code: "invalid_code", details: { attemptsLeft: left } },
        ]);
      }
      const late = await post("verify", player.token, {
        challengeToken,
        code: test.sms.lastCode(fresh),
      });
      expect([late.statusCode, late.json<{ code: string }>().code]).toEqual([
        410,
        "challenge_expired",
      ]);
      expect((await contactOf(player.id))?.phone_e164).not.toBe(fresh);
    });

    it("sends a code to another account's email, and refuses it only when that code comes back", async () => {
      await newPlayer({ email: "held@najd.sa" });
      const player = await newPlayer({ phone: newPhone() });
      const asked = await post("code", player.token, { channel: "email", value: "held@najd.sa" });
      expect(asked.statusCode).toBe(202);
      const taken = await post("verify", player.token, {
        challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
        code: test.mail.lastCode("held@najd.sa"),
      });
      expect([taken.statusCode, taken.json<{ code: string }>().code]).toEqual([
        409,
        "contact_in_use",
      ]);
      expect((await contactOf(player.id))?.email).toBeNull();
    });

    it("refuses the player's own contact, malformed ones and bad bodies", async () => {
      const phone = newPhone();
      const player = await newPlayer({ phone });
      const own = await post("code", player.token, { channel: "phone", value: phone });
      expect([own.statusCode, own.json<{ code: string }>().code]).toEqual([
        409,
        "contact_unchanged",
      ]);
      const foreign = await post("code", player.token, { channel: "phone", value: "+14155550100" });
      expect([foreign.statusCode, foreign.json<{ code: string }>().code]).toEqual([
        422,
        "phone_not_supported",
      ]);
      expect(
        (await post("code", player.token, { channel: "email", value: "not an email" })).statusCode,
      ).toBe(400);
      for (const payload of [
        {},
        { channel: "fax", value: "1" },
        { channel: "phone", value: phone, extra: 1 },
      ]) {
        expect((await post("code", player.token, payload)).statusCode).toBe(400);
      }
      const unsigned = await test.app.inject({
        method: "POST",
        url: "/v1/me/contact/code",
        payload: { channel: "phone", value: newPhone() },
      });
      expect(unsigned.statusCode).toBe(401);
    });

    it("counts every request in the player's window, refused ones too", async () => {
      const phone = newPhone();
      const player = await newPlayer({ phone });
      for (let i = 0; i < 5; i += 1) {
        expect(
          (await post("code", player.token, { channel: "phone", value: phone })).statusCode,
        ).toBe(409);
      }
      const blocked = await post("code", player.token, { channel: "phone", value: newPhone() });
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    });

    it("says the SMS gateway refused, and changes nothing", async () => {
      const player = await newPlayer({ phone: newPhone() });
      test.sms.next = { kind: "refused", reason: "gateway" };
      const refused = await post("code", player.token, { channel: "phone", value: newPhone() });
      expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        503,
        "sms_unavailable",
      ]);
    });
  });

  it("replays a confirmed change for a retry with the same key", async () => {
    const player = await newPlayer({ phone: newPhone() });
    const fresh = newPhone();
    const asked = await post("code", player.token, { channel: "phone", value: fresh });
    const payload = {
      challengeToken: asked.json<{ challengeToken: string }>().challengeToken,
      code: test.sms.lastCode(fresh),
    };
    const key = { "idempotency-key": randomUUID() };
    const first = await post("verify", player.token, payload, key);
    const retry = await post("verify", player.token, payload, key);
    expect([first.statusCode, retry.statusCode]).toEqual([200, 200]);
    expect(retry.json()).toEqual(first.json());
  });
});
