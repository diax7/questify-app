import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { PLAYER_SIGN_IN_LIMITS as L } from "#src/auth/limits";
import {
  createPlayerSignIn,
  type Asker,
  type PlayerSignIn,
  type PlayerSignInDeps,
} from "#src/players/sign-in";
import {
  RecordingEmailSender,
  RecordingSmsSender,
  freshIp,
  testConfig,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Logged = Readonly<{ event: string; fields: Record<string, unknown> }>;

const KEYS = createAuthKeys(testConfig().auth.secret);

/**
 * The player sign-in flow below the routes (T-107): what it logs for each outcome, the contact lock, the platform budget
 * warning, resend timing and the retention sweep. The routes' own tests cover the answers.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the player sign-in flow", () => {
  let db: TestDatabase;
  let pool: Pool;
  let deps: PlayerSignInDeps;
  let sms: RecordingSmsSender;
  let mail: RecordingEmailSender;
  let flow: PlayerSignIn;
  let logged: Logged[];
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });
  beforeEach(() => {
    sms = new RecordingSmsSender();
    mail = new RecordingEmailSender();
    deps = { pool, keys: KEYS, sms, email: mail };
    flow = createPlayerSignIn(deps);
    logged = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const asker = (): Asker => ({
    address: freshIp(),
    userAgent: null,
    requestId: undefined,
    deviceId: undefined,
    log: (event, fields) => logged.push({ event, fields: { ...fields } }),
  });
  const events = () => logged.map((entry) => entry.event);
  const fieldsOf = (event: string) => logged.find((entry) => entry.event === event)?.fields;

  const newPhone = (): string => {
    counter += 1;
    return `+9665${String(20_000_000 + counter).slice(-8)}`;
  };
  const newEmail = (): string => {
    counter += 1;
    return `flow${counter}@najd.sa`;
  };
  const ask = (value: string) =>
    flow.requestCode(
      {
        channel: value.includes("@") ? "email" : "phone",
        value,
        lang: "ar",
        accept: { terms: "0.1", privacy: "0.1" },
      },
      asker(),
    );
  const tokenOf = async (value: string): Promise<string> => {
    const result = await ask(value);
    if (result.kind !== "code_sent") {
      throw new Error(`No code: ${result.kind}`);
    }
    return result.challengeToken;
  };

  /** Holds the contact's lock from another connection while `work` runs. */
  const withContactLocked = async <T>(contact: string, work: () => Promise<T>): Promise<T> => {
    const lock = KEYS.contactThrottleKey(contact).readBigInt64BE(0).toString();
    await owner("SELECT pg_advisory_lock($1::bigint)", [lock]);
    try {
      return await work();
    } finally {
      await owner("SELECT pg_advisory_unlock($1::bigint)", [lock]);
    }
  };

  const staleChallenge = async (): Promise<Buffer> => {
    const token = randomBytes(32);
    await owner(
      `INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                           terms_version, privacy_version, contact_fp)
       VALUES (gen_random_uuid(), $1, 'phone', $2, $3, $4, now() - interval '2 hours', '0.1', '0.1', $5)`,
      [token, newPhone(), randomBytes(32), randomBytes(32), randomBytes(32)],
    );
    return token;
  };
  const exists = async (token: Buffer) =>
    (await owner("SELECT 1 FROM player_login_challenge WHERE token_hash = $1", [token])).length ===
    1;

  describe("what each send logs", () => {
    it("logs a texted code as sent, an unknown answer with its reason, and a refusal with the gateway's code", async () => {
      await ask(newPhone());
      expect(fieldsOf("player.code_sent")).toMatchObject({ channel: "phone", outcome: "sent" });
      logged = [];
      sms.next = { kind: "unknown", reason: "timeout" };
      await ask(newPhone());
      expect(fieldsOf("player.code_sent")).toMatchObject({
        channel: "phone",
        outcome: "unknown_timeout",
      });
      logged = [];
      sms.next = { kind: "refused", reason: "1120" };
      expect(await ask(newPhone())).toEqual({ kind: "sms_unavailable" });
      expect(fieldsOf("player.sms_refused")).toMatchObject({
        gateway: "recording",
        reason: "1120",
      });
      expect(events()).not.toContain("player.code_sent");
    });

    it("emails a code valid 5 minutes and logs it; a failed email is logged with its reason", async () => {
      const email = newEmail();
      await ask(email);
      expect(mail.to(email)[0]?.text).toContain("It is valid for 5 minutes.");
      expect(fieldsOf("player.code_sent")).toMatchObject({ channel: "email", outcome: "sent" });
      logged = [];
      mail.failing = true;
      expect(await ask(newEmail())).toEqual({ kind: "email_unavailable" });
      expect(fieldsOf("player.email_unavailable")).toMatchObject({ reason: "EmailSendError" });
    });

    it("logs a throttled request with its step and channel", async () => {
      const phone = newPhone();
      for (let n = 0; n < L.codesPerContactHour.max; n += 1) {
        await ask(phone);
      }
      logged = [];
      expect(await ask(phone)).toMatchObject({ kind: "throttled" });
      expect(fieldsOf("player.throttled")).toMatchObject({ step: "code", channel: "phone" });
    });

    it("warns once the platform's SMS budget reaches half, and logs when it is spent", async () => {
      const key = createHash("sha256").update("questify.sms_platform").digest();
      const half = Math.floor(L.smsPerHour.max / 2);
      // Earlier sends in this file are in the same bucket: start from an exact count.
      await owner("DELETE FROM auth_throttle WHERE bucket = 'sms_platform'");
      await owner(
        "INSERT INTO auth_throttle (bucket, key, at) SELECT 'sms_platform', $1, now() FROM generate_series(1, $2)",
        [key, half - 2],
      );
      try {
        await ask(newPhone());
        expect(events()).not.toContain("player.budget_half");
        await ask(newPhone());
        expect(fieldsOf("player.budget_half")).toEqual({
          addr: expect.any(String),
          channel: "phone",
        });
        logged = [];
        await ask(newPhone());
        expect(events()).not.toContain("player.budget_half");
        await owner(
          "INSERT INTO auth_throttle (bucket, key, at) SELECT 'sms_platform', $1, now() FROM generate_series(1, $2)",
          [key, L.smsPerHour.max],
        );
        expect(await ask(newPhone())).toEqual({ kind: "sms_unavailable" });
        expect(fieldsOf("player.budget_spent")).toMatchObject({ channel: "phone" });
      } finally {
        await owner("DELETE FROM auth_throttle WHERE bucket = 'sms_platform'");
      }
    });
  });

  describe("the contact lock", () => {
    it("answers a code request for a contact busy elsewhere with a one-second wait, sending nothing", async () => {
      const phone = newPhone();
      const result = await withContactLocked(phone, () => ask(phone));
      expect(result).toEqual({ kind: "throttled", retryAfterSeconds: 1 });
      expect(sms.sent).toEqual([]);
    });

    it("answers a guess for a contact busy elsewhere with a one-second wait, judging nothing", async () => {
      const phone = newPhone();
      const token = await tokenOf(phone);
      const code = sms.lastCode(phone);
      const busy = await withContactLocked(phone, () =>
        flow.verify({ challengeToken: token, code }, asker()),
      );
      expect(busy).toEqual({ kind: "throttled", retryAfterSeconds: 1 });
      expect(fieldsOf("player.throttled")).toMatchObject({ step: "verify" });
      expect(await flow.verify({ challengeToken: token, code }, asker())).toMatchObject({
        kind: "new",
      });
    });

    it("answers a resend for a contact busy elsewhere with a one-second wait", async () => {
      const phone = newPhone();
      const token = await tokenOf(phone);
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = now() - interval '61 seconds' WHERE contact = $1",
        [phone],
      );
      const busy = await withContactLocked(phone, () =>
        flow.resend({ challengeToken: token, lang: "ar" }, asker()),
      );
      expect(busy).toEqual({ kind: "throttled", retryAfterSeconds: 1 });
    });
  });

  describe("verifying and the rest", () => {
    it("logs a wrong code, and nothing for an expired challenge", async () => {
      const phone = newPhone();
      const token = await tokenOf(phone);
      logged = [];
      await flow.verify({ challengeToken: token, code: "000000" }, asker());
      expect(fieldsOf("player.code_failed")).toMatchObject({ step: "verify" });
      expect(events()).not.toContain("player.throttled");
      logged = [];
      await flow.verify({ challengeToken: "Z".repeat(43), code: "000000" }, asker());
      expect(events()).toEqual([]);
    });

    it("logs the new player and a returning sign-in with the player id", async () => {
      const phone = newPhone();
      const verified = await flow.verify(
        { challengeToken: await tokenOf(phone), code: sms.lastCode(phone) },
        asker(),
      );
      if (verified.kind !== "new") {
        throw new Error(verified.kind);
      }
      counter += 1;
      const created = await flow.signup(
        {
          signupToken: verified.signupToken,
          username: `flow_${counter}`,
          birthYear: 1990,
          avatar: "falcon",
        },
        asker(),
      );
      if (created.kind !== "created") {
        throw new Error(created.kind);
      }
      expect(fieldsOf("player.signed_up")).toMatchObject({ player: created.issued.player.id });
      logged = [];
      await flow.verify(
        { challengeToken: await tokenOf(phone), code: sms.lastCode(phone) },
        asker(),
      );
      expect(fieldsOf("player.signed_in")).toMatchObject({ player: created.issued.player.id });
      logged = [];
      const refreshed = await flow.refresh({ refreshToken: created.issued.refreshToken }, asker());
      expect(refreshed.kind).toBe("rotated");
      expect(events()).toEqual([]);
      expect(await flow.refresh({ refreshToken: "Y".repeat(43) }, asker())).toEqual({
        kind: "invalid",
      });
      expect(events()).toEqual([]);
    });

    it("says how long to wait before a resend, and spends no send when the resends are used up", async () => {
      const email = newEmail();
      const token = await tokenOf(email);
      await owner(
        "UPDATE player_login_challenge SET last_sent_at = now() - interval '20 seconds' WHERE contact = $1",
        [email],
      );
      const early = await flow.resend({ challengeToken: token, lang: "en" }, asker());
      expect(early.kind).toBe("resend_too_soon");
      expect(early.kind === "resend_too_soon" ? early.retryAfterSeconds : 0).toBeGreaterThanOrEqual(
        39,
      );
      expect(early.kind === "resend_too_soon" ? early.retryAfterSeconds : 99).toBeLessThanOrEqual(
        41,
      );

      await owner("UPDATE player_login_challenge SET resends = 3 WHERE contact = $1", [email]);
      const sends = async () =>
        (
          await owner<{ n: number }>(
            "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = 'player_code_contact' AND key = $1",
            [KEYS.contactThrottleKey(email)],
          )
        )[0]?.n;
      const before = await sends();
      expect(await flow.resend({ challengeToken: token, lang: "en" }, asker())).toEqual({
        kind: "resend_limit",
      });
      expect(await sends()).toBe(before);
    });
  });

  describe("the retention sweep", () => {
    it("runs on the first request, then not again for ten minutes", async () => {
      const start = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(start);
      const first = await staleChallenge();
      await ask(newPhone());
      expect(await exists(first)).toBe(false);

      const second = await staleChallenge();
      clock.mockReturnValue(start + 9 * 60 * 1000);
      await ask(newPhone());
      expect(await exists(second)).toBe(true);

      clock.mockReturnValue(start + 11 * 60 * 1000);
      await flow.verify({ challengeToken: "X".repeat(43), code: "1" }, asker());
      expect(await exists(second)).toBe(false);
    });

    it("logs a failed sweep and still answers", async () => {
      await owner("REVOKE EXECUTE ON FUNCTION sweep_player_sign_in() FROM questify_app");
      try {
        expect((await ask(newPhone())).kind).toBe("code_sent");
        expect(fieldsOf("player.sweep_failed")).toMatchObject({ reason: "error" });
      } finally {
        await owner("GRANT EXECUTE ON FUNCTION sweep_player_sign_in() TO questify_app");
      }
    });
  });
});
