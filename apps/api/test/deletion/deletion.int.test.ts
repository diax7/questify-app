import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { withRequestContext } from "#src/db/context";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { freshIp, startApp, testConfig, type TestApp } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
const tokenOf = (response: LightMyRequestResponse) =>
  (response.json() as { challengeToken: string }).challengeToken;

/**
 * Account deletion over HTTP (T-217; FR-126, FR-127, FR-128): the app's code to the account's own contact, the web
 * page's code that answers the same for any contact, the code to a deletion token with the pending handovers, the
 * confirmation and its repeat, and what a deleted player can no longer do. No contact reaches the logs.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("account deletion (HTTP)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let lines: string[] = [];
  let counter = 0;
  const store = new MemoryIdempotencyStore();

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    test = await startApp(
      db,
      {
        ...loggerOptions(testConfig()),
        level: "info",
        stream: { write: (line: string) => void lines.push(line) },
      },
      {},
      { idempotencyStore: store },
    );
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

  /** A player with a phone, an email (either can be left out) and a bearer session. */
  const newPlayer = async (has: { phone?: boolean; email?: boolean } = {}) => {
    counter += 1;
    const phone = has.phone === false ? null : `+9665${String(20_000_000 + counter).slice(-8)}`;
    const email = has.email === false ? null : `leaving${counter}@najd.sa`;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`leaving_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      phone,
      email,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token, phone: phone ?? "", email: email ?? "" };
  };

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    test.app.inject({
      method: "POST",
      url,
      headers: { "x-forwarded-for": freshIp(), ...headers },
      payload,
    });
  const ownCode = (token: string, payload: object = {}) =>
    post("/v1/me/deletion/code", payload, { authorization: `Bearer ${token}` });
  const verify = (challengeToken: string, code: string) =>
    post("/v1/deletion/verify", { challengeToken, code });
  const confirm = (deletionToken: string, forfeit?: boolean) =>
    post(
      "/v1/deletion/confirm",
      forfeit === undefined ? { deletionToken } : { deletionToken, forfeit },
    );
  /** The log lines of one event, parsed. */
  const logged = (event: string) =>
    lines.map((line) => JSON.parse(line) as Row).filter((line) => line["event"] === event);
  /** Fills a platform-wide send budget to its ceiling for one request (the sign-in tests' pattern). */
  const withBudgetSpent = async (
    bucket: string,
    name: string,
    max: number,
    work: () => Promise<void>,
  ) => {
    await owner("DELETE FROM auth_throttle WHERE bucket = $1", [bucket]);
    await owner(
      "INSERT INTO auth_throttle (bucket, key, at) SELECT $1, $2, now() FROM generate_series(1, $3)",
      [bucket, createHash("sha256").update(name).digest(), max],
    );
    try {
      await work();
    } finally {
      await owner("DELETE FROM auth_throttle WHERE bucket = $1", [bucket]);
    }
  };
  const statusOf = async (player: string) =>
    (await owner<{ status: string }>("SELECT status FROM player WHERE id = $1", [player]))[0]
      ?.status;

  describe("from the app (FR-126)", () => {
    it("texts the account's own phone a deletion code, then deletes with the token, once", async () => {
      const player = await newPlayer();
      const asked = await ownCode(player.token, { lang: "en" });
      expect(asked.statusCode).toBe(202);
      expect(asked.json()).toEqual({ challengeToken: expect.any(String), expiresInSeconds: 300 });
      const text =
        test.sms.sent.filter((message) => message.to === player.phone).at(-1)?.text ?? "";
      expect(text).toMatch(/account deletion code/);
      expect(text).not.toMatch(/sign-in/);

      const verified = await verify(tokenOf(asked), test.sms.lastCode(player.phone));
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toEqual({
        deletionToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        expiresInSeconds: 600,
        pending: [],
      });
      const { deletionToken } = verified.json() as { deletionToken: string };
      expect((await confirm(deletionToken)).statusCode).toBe(204);
      expect((await confirm(deletionToken)).statusCode).toBe(204);
      expect(await statusOf(player.id)).toBe("deleted");

      const me = await test.app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${player.token}` },
      });
      expect(me.statusCode).toBe(401);
      expect(lines.join("\n")).not.toContain(player.phone);
      expect(lines.join("\n")).toContain("player.deleted");
    });

    it("emails the code when asked for email, in Arabic by default", async () => {
      const player = await newPlayer();
      const asked = await ownCode(player.token, { channel: "email" });
      expect(asked.statusCode).toBe(202);
      expect(test.mail.to(player.email).at(-1)?.subject).toContain("حذف حسابك");
    });

    it("refuses a caller without a session", async () => {
      expect((await post("/v1/me/deletion/code", {})).statusCode).toBe(401);
    });
  });

  describe("from the web page (FR-127)", () => {
    it("answers a known and an unknown contact the same, and texts only the known one, after the answer", async () => {
      const player = await newPlayer();
      const stranger = `+9665${String(29_000_000 + counter).slice(-8)}`;
      const known = await post("/v1/deletion/code", { channel: "phone", value: player.phone });
      const unknown = await post("/v1/deletion/code", { channel: "phone", value: stranger });
      expect([known.statusCode, unknown.statusCode]).toEqual([202, 202]);
      expect(Object.keys(known.json() as Row)).toEqual(Object.keys(unknown.json() as Row));
      expect((unknown.json() as Row)["expiresInSeconds"]).toBe(
        (known.json() as Row)["expiresInSeconds"],
      );
      await test.deferred.idle();
      expect(test.sms.sent.some((message) => message.to === player.phone)).toBe(true);
      expect(test.sms.sent.some((message) => message.to === stranger)).toBe(false);
      expect(await verify(tokenOf(unknown), "123456")).toMatchObject({ statusCode: 422 });
      expect(lines.join("\n")).not.toContain(stranger);
    });

    it("counts a wrong code, ends the code after three, and never lets a deletion code sign in", async () => {
      const player = await newPlayer();
      const asked = await post("/v1/deletion/code", { channel: "email", value: player.email });
      await test.deferred.idle();
      const challengeToken = tokenOf(asked);
      const signIn = await post("/v1/auth/verify", {
        challengeToken,
        code: test.mail.lastCode(player.email),
      });
      expect(signIn.json()).toMatchObject({ code: "challenge_expired" });
      const wrong = await verify(challengeToken, "000000");
      expect(wrong.statusCode).toBe(422);
      expect(wrong.json()).toMatchObject({
        code: "invalid_code",
        details: { attemptsLeft: 2 },
      });
      await verify(challengeToken, "000000");
      await verify(challengeToken, "000000");
      const ended = await verify(challengeToken, test.mail.lastCode(player.email));
      expect(ended.statusCode).toBe(410);
      expect(ended.json()).toMatchObject({ code: "deletion_expired" });
      expect(await statusOf(player.id)).toBe("active");
    });

    it("refuses an unknown deletion token and a malformed body", async () => {
      const stale = await confirm(randomBytes(32).toString("base64url"));
      expect(stale.statusCode).toBe(410);
      expect((await post("/v1/deletion/confirm", { deletionToken: "short" })).statusCode).toBe(400);
      expect(
        (await post("/v1/deletion/code", { channel: "phone", value: "0123" })).statusCode,
      ).toBe(422);
    });
  });

  describe("a pending handover (FR-128)", () => {
    it("lists it with the token, refuses without a forfeit, and deletes with one", async () => {
      const player = await newPlayer();
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, name_ar, status, starts_at, ends_at, welcome_points)
         VALUES ($1, 'HTTPDEL', 'Gone Fest', 'مهرجان', 'live', now() - interval '1 hour', now() + interval '1 day', 50)
         RETURNING id`,
        [ids.orgA],
      );
      const [reward] = await owner<{ id: string }>(
        "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Spa', 5, 3) RETURNING id",
        [event?.id],
      );
      await withRequestContext(db.app, { playerId: player.id }, async () => {
        await db.app.query("SELECT * FROM join_event('HTTPDEL', 'code', '0.2')");
        await db.app.query("SELECT * FROM reserve_reward($1, $2)", [reward?.id, randomUUID()]);
      });
      const asked = await ownCode(player.token);
      const verified = await verify(tokenOf(asked), test.sms.lastCode(player.phone));
      const { deletionToken, pending } = verified.json() as {
        deletionToken: string;
        pending: Row[];
      };
      expect(pending).toEqual([
        {
          redemptionId: expect.any(String),
          eventId: event?.id,
          event: { ar: "مهرجان", en: "Gone Fest" },
          item: { ar: null, en: "Spa" },
          rankPrize: false,
        },
      ]);
      const refused = await confirm(deletionToken);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        code: "handover_pending",
        details: { pending },
      });
      expect(await statusOf(player.id)).toBe("active");
      expect((await confirm(deletionToken, true)).statusCode).toBe(204);
      expect(await statusOf(player.id)).toBe("deleted");
    });
  });

  describe("what each answer says and logs", () => {
    it("drops the deleted player's remembered answers, keeps others', and logs the deletion once", async () => {
      const player = await newPlayer();
      const other = await newPlayer();
      for (const id of [player.id, other.id]) {
        await store.begin(`player:${id}`, "k", "h");
        await store.finish(`player:${id}`, "k", 200, "{}", "application/json");
      }
      const asked = await ownCode(player.token);
      const verified = await verify(tokenOf(asked), test.sms.lastCode(player.phone));
      const { deletionToken } = verified.json() as { deletionToken: string };
      expect(logged("player.deletion_code_failed")).toEqual([]);
      await confirm(deletionToken);
      await confirm(deletionToken);
      expect(await store.begin(`player:${player.id}`, "k", "h")).toEqual({ kind: "new" });
      expect(await store.begin(`player:${other.id}`, "k", "h")).toMatchObject({ kind: "replay" });
      expect(logged("player.deleted")).toEqual([expect.objectContaining({ player: player.id })]);
      await confirm(randomBytes(32).toString("base64url"));
      expect(logged("player.deleted")).toHaveLength(1);
    });

    it("texts in Arabic by default and logs each code sent with its channel", async () => {
      const player = await newPlayer();
      expect((await ownCode(player.token)).statusCode).toBe(202);
      expect(test.sms.sent.filter((m) => m.to === player.phone).at(-1)?.text).toMatch(
        /رمز حذف حسابك/,
      );
      expect((await ownCode(player.token, { channel: "email", lang: "en" })).statusCode).toBe(202);
      expect(test.mail.to(player.email).at(-1)?.text).toContain("valid for 5 minutes");
      expect(logged("player.deletion_code_sent").map((line) => line["channel"])).toEqual([
        "phone",
        "email",
      ]);
    });

    it("falls back to the contact the account has", async () => {
      const phoneOnly = await newPlayer({ email: false });
      expect((await ownCode(phoneOnly.token, { channel: "email" })).statusCode).toBe(202);
      expect(test.sms.sent.some((m) => m.to === phoneOnly.phone)).toBe(true);
      const emailOnly = await newPlayer({ phone: false });
      expect((await ownCode(emailOnly.token)).statusCode).toBe(202);
      expect(test.mail.to(emailOnly.email)).toHaveLength(1);
    });

    it("answers 503 without an email offer when the app's SMS or email is refused, and logs why", async () => {
      const player = await newPlayer();
      test.sms.next = { kind: "refused", reason: "1060" };
      const refused = await ownCode(player.token);
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({
        code: "sms_unavailable",
        details: { emailOffered: false },
      });
      expect(logged("player.sms_refused")).toEqual([expect.objectContaining({ reason: "1060" })]);
      test.mail.failing = true;
      const failed = await ownCode(player.token, { channel: "email" });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toMatchObject({ code: "email_unavailable" });
      expect(logged("player.email_unavailable")).toEqual([
        expect.objectContaining({ reason: expect.any(String) }),
      ]);
      expect(logged("player.deletion_code_sent")).toEqual([]);
    });

    it("answers 503 once the platform's SMS or email budget is spent, offering email on the web page", async () => {
      const player = await newPlayer();
      await withBudgetSpent("sms_platform", "questify.sms_platform", 5000, async () => {
        const app = await ownCode(player.token);
        expect(app.json()).toMatchObject({
          code: "sms_unavailable",
          details: { emailOffered: false },
        });
        const web = await post("/v1/deletion/code", { channel: "phone", value: player.phone });
        expect(web.statusCode).toBe(503);
        expect(web.json()).toMatchObject({
          code: "sms_unavailable",
          details: { emailOffered: true },
        });
      });
      await withBudgetSpent(
        "player_email_platform",
        "questify.player_email_platform",
        1000,
        async () => {
          const web = await post("/v1/deletion/code", { channel: "email", value: player.email });
          expect(web.statusCode).toBe(503);
          expect(web.json()).toMatchObject({ code: "email_unavailable" });
        },
      );
      expect(logged("player.budget_spent").map((line) => line["channel"])).toEqual([
        "phone",
        "phone",
        "email",
      ]);
      expect(test.sms.sent.some((m) => m.to === player.phone)).toBe(false);
    });

    it("stops a sixth code an hour to one contact with 429 and retry-after, from the app and the web page", async () => {
      const player = await newPlayer();
      for (let n = 0; n < 5; n += 1) {
        expect((await ownCode(player.token)).statusCode).toBe(202);
      }
      for (const stopped of [
        await ownCode(player.token),
        await post("/v1/deletion/code", { channel: "phone", value: player.phone }),
      ]) {
        expect(stopped.statusCode).toBe(429);
        const wait = Number(stopped.headers["retry-after"]);
        expect(wait).toBeGreaterThan(0);
        expect(stopped.json()).toMatchObject({
          code: "too_many_attempts",
          details: { retryAfterSeconds: wait },
        });
      }
      expect(logged("player.throttled")).toEqual([
        expect.objectContaining({ step: "deletion_code", channel: "phone" }),
        expect.objectContaining({ step: "deletion_code", channel: "phone" }),
      ]);
    });

    it("stops wrong codes from one address with 429 once its window is full", async () => {
      const player = await newPlayer();
      const address = freshIp();
      const asked = await ownCode(player.token);
      const wrong = await post(
        "/v1/deletion/verify",
        { challengeToken: tokenOf(asked), code: "000000" },
        { "x-forwarded-for": address },
      );
      expect(wrong.statusCode).toBe(422);
      expect(logged("player.deletion_code_failed")).toHaveLength(1);
      // The address's own key, copied from the failure just written, up to the window's ceiling.
      await owner(
        `INSERT INTO auth_throttle (bucket, key, at)
         SELECT last.bucket, last.key, now() FROM (SELECT bucket, key FROM auth_throttle
           WHERE bucket = 'player_fail_address' ORDER BY at DESC LIMIT 1) last, generate_series(1, 100)`,
      );
      const stopped = await post(
        "/v1/deletion/verify",
        { challengeToken: tokenOf(asked), code: test.sms.lastCode(player.phone) },
        { "x-forwarded-for": address },
      );
      expect(stopped.statusCode).toBe(429);
      expect(Number(stopped.headers["retry-after"])).toBeGreaterThan(0);
      expect(stopped.headers["cache-control"]).toBe("no-store");
    });

    it("refuses a phone outside Saudi Arabia with an email offer, and a malformed email", async () => {
      const abroad = await post("/v1/deletion/code", { channel: "phone", value: "+14155550100" });
      expect(abroad.statusCode).toBe(422);
      expect(abroad.json()).toMatchObject({
        code: "phone_not_supported",
        details: { emailOffered: true },
      });
      expect(abroad.headers["cache-control"]).toBe("no-store");
      const bad = await post("/v1/deletion/code", { channel: "email", value: "not-an-email" });
      expect(bad.statusCode).toBe(400);
    });
  });
});
