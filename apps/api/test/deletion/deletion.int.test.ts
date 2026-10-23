import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { withRequestContext } from "#src/db/context";
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

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
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
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A player with a phone, an email and a bearer session. */
  const newPlayer = async () => {
    counter += 1;
    const phone = `+9665${String(20_000_000 + counter).slice(-8)}`;
    const email = `leaving${counter}@najd.sa`;
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
    return { id, token, phone, email };
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
});
