import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  notificationListSchema,
  notificationsUnreadSchema,
  pushTopicsSchema,
} from "@questify/shared";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeProvider } from "#src/push/fake";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const ios = (token = randomBytes(32).toString("hex").toUpperCase()) => ({
  platform: "ios",
  token,
  environment: "production",
  language: "ar",
  appVersion: "1.4.0",
});
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the worker");
};

/**
 * Push, the center and the topics over HTTP (T-501): the device bound to the request's own sign-in, its bucket, refusals
 * with a field and never the token, the center rendered in the request's language with its cursor, the read marks, the
 * topics, `GET /v1/me`'s count, staff kept out, and the worker end to end on the fake provider.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("push over HTTP", () => {
  let f: PushFixture;
  let test: TestApp;
  let lines: string[];
  let workerPool: Pool;
  const fake = createFakeProvider("apns:production");

  beforeAll(async () => {
    f = await pushFixture();
    lines = [];
    workerPool = new Pool({ connectionString: f.db.appUrl, max: 3 });
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    test = await startApp(
      f.db,
      { level: "debug", stream },
      {},
      {
        push: { pool: workerPool, providers: [fake] },
      },
    );
  });
  afterAll(async () => {
    await test.close();
    await workerPool.end();
    await f.close();
  });

  /** A player with a live sign-in: the bearer token, its session's hash and family. */
  const session = async () => {
    const player = await f.newPlayer();
    const token = randomBytes(32).toString("base64url");
    const family = randomUUID();
    await f.owner(
      `INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '180 days')`,
      [player, family, randomBytes(32)],
    );
    await f.owner(
      `INSERT INTO player_session (player_id, token_hash, expires_at, refresh_family)
       VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [player, createHash("sha256").update(token).digest(), family],
    );
    return { player, token, family };
  };
  const as = (token: string, method: Method, url: string, payload?: object, language = "en") =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "accept-language": language },
      ...(payload === undefined ? {} : { payload }),
    });
  describe("the device", () => {
    it("registers this sign-in's device, lower-cases an iOS token and keeps it out of the logs", async () => {
      const { token, family, player } = await session();
      const body = ios();
      const answer = await as(token, "PUT", "/v1/me/push-device", body);
      expect(answer.statusCode).toBe(204);
      expect(answer.headers["cache-control"]).toBe("private, no-store");
      const [row] = await f.owner<{ player_id: string; token: string }>(
        "SELECT player_id, token FROM push_device WHERE family = $1",
        [family],
      );
      expect(row).toEqual({ player_id: player, token: body.token.toLowerCase() });
      const logged = lines.join("");
      expect(logged).not.toContain(body.token);
      expect(logged).not.toContain(body.token.toLowerCase());
    });

    it("refuses a body that is not a device, naming nothing of the token", async () => {
      const { token } = await session();
      for (const body of [
        { ...ios(), environment: undefined },
        { ...ios(), token: "nothex".repeat(10) },
        { ...ios(), platform: "web" },
        {
          platform: "android",
          token: "fcm_token_1234567890",
          language: "en",
          appVersion: "1",
          environment: "production",
        },
      ]) {
        const answer = await as(token, "PUT", "/v1/me/push-device", body);
        expect(answer.statusCode, JSON.stringify(body)).toBe(400);
        expect(answer.json()).toMatchObject({ code: "invalid_request" });
        expect(answer.body).not.toContain(String(body.token));
      }
    });

    it("allows 20 registrations an hour per player", async () => {
      const { token } = await session();
      for (let i = 0; i < 20; i += 1) {
        expect((await as(token, "PUT", "/v1/me/push-device", ios())).statusCode).toBe(204);
      }
      const over = await as(token, "PUT", "/v1/me/push-device", ios());
      expect(over.statusCode).toBe(429);
      expect(over.headers["retry-after"]).toBeDefined();
    });

    it("removes this sign-in's device, twice without harm", async () => {
      const { token, family } = await session();
      await as(token, "PUT", "/v1/me/push-device", ios());
      expect((await as(token, "DELETE", "/v1/me/push-device")).statusCode).toBe(204);
      expect((await as(token, "DELETE", "/v1/me/push-device")).statusCode).toBe(204);
      expect(await f.count("push_device WHERE family = $1", [family])).toBe(0);
    });

    it("keeps staff and strangers out of every push route", async () => {
      await createStaff(f.db.owner, { email: "staff@push.test" });
      const cookie = await signInFully(test, "staff@push.test");
      for (const [method, url] of [
        ["PUT", "/v1/me/push-device"],
        ["DELETE", "/v1/me/push-device"],
        ["GET", "/v1/me/notifications"],
        ["POST", "/v1/me/notifications/read"],
        ["GET", "/v1/me/push-topics"],
        ["PUT", "/v1/me/push-topics"],
      ] as const) {
        const anonymous = await test.app.inject({ method, url, payload: {} });
        expect(anonymous.statusCode, url).toBe(401);
        const staff = await test.app.inject({
          method,
          url,
          headers: withSession(cookie),
          payload: {},
        });
        expect(staff.statusCode, url).toBe(401);
      }
    });
  });

  describe("the center and the topics", () => {
    it("lists the caller's rows newest first in the request's language, pages by cursor and marks them read", async () => {
      const { token, player } = await session();
      const kind = await f.kind();
      const promo = await f.kind({ class: "promo", membership: "none" });
      for (let i = 0; i < 3; i += 1) {
        await f.notice(kind, { player, params: { event: { ar: "مهرجان", en: "Fest" } } });
      }
      await f.notice(promo, { player });
      await waitFor(
        async () => (await f.count("notification WHERE player_id = $1", [player])) === 4,
      );
      const first = notificationListSchema.parse(
        (await as(token, "GET", "/v1/me/notifications?limit=2")).json(),
      );
      expect(first.items).toHaveLength(2);
      expect(first.unread).toBe(4);
      expect(first.items[0]).toMatchObject({
        title: "Questify",
        body: "You have a new message",
        optOut: true,
      });
      expect(first.items[1]).toMatchObject({
        title: "Fest",
        read: false,
        optOut: false,
        topic: null,
      });
      expect(first.nextBefore).toBe(first.items[1]?.id);
      const arabic = await as(
        token,
        "GET",
        `/v1/me/notifications?limit=2&before=${first.nextBefore}`,
        undefined,
        "ar",
      );
      expect(arabic.headers["cache-control"]).toBe("private, no-store");
      const second = notificationListSchema.parse(arabic.json());
      expect(second.items.map((item) => item.title)).toEqual(["مهرجان", "مهرجان"]);
      expect(second.items[0]?.body).toBe("لديك رسالة جديدة");
      expect(second.nextBefore).toBe(second.items[1]?.id);
      const last = notificationListSchema.parse(
        (await as(token, "GET", `/v1/me/notifications?before=${second.nextBefore}`)).json(),
      );
      expect(last).toMatchObject({ items: [], nextBefore: null });
      const marked = await as(token, "POST", "/v1/me/notifications/read", {
        ids: [first.items[0]?.id],
      });
      expect(notificationsUnreadSchema.parse(marked.json())).toEqual({ unread: 3 });
      expect((await as(token, "GET", "/v1/me")).json().notifications).toEqual({ unread: 3 });
      expect((await as(token, "POST", "/v1/me/notifications/read", { all: true })).json()).toEqual({
        unread: 0,
      });
      expect((await as(token, "POST", "/v1/me/notifications/read", { ids: [] })).statusCode).toBe(
        400,
      );
      expect((await as(token, "GET", "/v1/me/notifications?limit=51")).statusCode).toBe(400);
    });

    it("reads and changes the topics, the others kept", async () => {
      const { token } = await session();
      expect(pushTopicsSchema.parse((await as(token, "GET", "/v1/me/push-topics")).json())).toEqual(
        {
          announcements: true,
          rank: true,
          community: true,
          reminders: true,
        },
      );
      const off = await as(token, "PUT", "/v1/me/push-topics", { rank: false, community: false });
      expect(off.json()).toEqual({
        announcements: true,
        rank: false,
        community: false,
        reminders: true,
      });
      const back = await as(token, "PUT", "/v1/me/push-topics", { community: true });
      expect(back.json()).toEqual({
        announcements: true,
        rank: false,
        community: true,
        reminders: true,
      });
      expect((await as(token, "PUT", "/v1/me/push-topics", {})).statusCode).toBe(400);
      expect((await as(token, "PUT", "/v1/me/push-topics", { offers: false })).statusCode).toBe(
        400,
      );
    });
  });

  describe("the worker, end to end on the fake provider", () => {
    it("fans a personal notice out to the center and a send; a kind with no template is never pushed", async () => {
      const { token, player } = await session();
      expect((await as(token, "PUT", "/v1/me/push-device", ios())).statusCode).toBe(204);
      const kind = await f.kind();
      const id = await f.notice(kind, { player });
      await waitFor(async () => (await f.sends(id)).some((row) => row.state === "failed"));
      expect((await f.sends(id)).map((row) => [row.state, row.code])).toEqual([
        ["failed", "no_template"],
      ]);
      expect(fake.sent).toEqual([]);
      expect(await f.recipients(id)).toEqual([player]);
    });
  });
});
