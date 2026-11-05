import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { createAuthKeys } from "#src/auth/keys";
import { asDevicePlayer, labelDevice } from "#src/players/devices";
import { freshIp, startApp, testConfig, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Phone = Readonly<{ access: string; refresh: Buffer; family: string }>;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest();
/** The keys the test app derives from its secret, to seed and read its throttle windows. */
const keys = createAuthKeys(testConfig().auth.secret);
const newMailbox = () => `r${randomUUID().slice(0, 8)}@najd.sa`;

/**
 * Signed-in devices over HTTP (T-810c, FR-140): the list, ending another device or all others, the fresh code that a
 * stale sign-in needs first, and every refusal; no route answers anything of another player, and none opens without a
 * bearer token.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("signed-in devices (HTTP)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;
  const lines: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      ...loggerOptions(testConfig()),
      level: "debug",
      stream: { write: (line: string) => void lines.push(line) },
    });
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });
  beforeEach(() => {
    test.sms.next = { kind: "sent" };
    test.mail.failing = false;
    lines.length = 0;
  });

  /** The auth events logged since the test began, each with its own fields. */
  const events = (): Row[] =>
    lines.map((line) => JSON.parse(line) as Row).filter((line) => "event" in line);

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A sign-in on a new phone: a family issued as the sign-in functions do (issue_player_tokens). */
  const signIn = async (player: string): Promise<Phone> => {
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32);
    const family = randomUUID();
    await owner("SELECT issue_player_tokens($1, $2, $3, $4)", [
      player,
      sha(access),
      sha(refresh),
      family,
    ]);
    return { access, refresh, family };
  };

  const newPlayer = async (email: string | null = null) => {
    counter += 1;
    const phone = `+9665${String(40_000_000 + counter).slice(-8)}`;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`devices_http_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      phone,
      email,
    ]);
    return { id, phone };
  };

  const stale = (family: string) =>
    owner(
      "UPDATE player_sign_in_device SET signed_in_at = now() - interval '11 minutes' WHERE family = $1",
      [family],
    );
  const deviceId = async (family: string) =>
    (
      await owner<{ id: string }>("SELECT id FROM player_sign_in_device WHERE family = $1", [
        family,
      ])
    )[0]?.id ?? "";
  const liveRefresh = async (family: string) =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM player_refresh WHERE family = $1 AND revoked_at IS NULL",
        [family],
      )
    )[0]?.n;

  const call = (
    method: "GET" | "POST",
    url: string,
    phone: Phone | null,
    payload?: object,
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: {
        ...(phone === null ? {} : { authorization: `Bearer ${phone.access}` }),
        "x-forwarded-for": freshIp(),
        ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  it("lists the caller's devices, this one first, with no family id, and none of another player's", async () => {
    const player = await newPlayer();
    const laptop = await signIn(player.id);
    const here = await signIn(player.id);
    const stranger = await signIn((await newPlayer()).id);
    const listed = await call("GET", "/v1/me/devices", here);
    expect(listed.statusCode).toBe(200);
    expect(listed.headers["cache-control"]).toContain("no-store");
    const body = listed.json<{ devices: Row[]; freshUntil: string | null }>();
    expect(body.devices.map((d) => d["current"])).toEqual([true, false]);
    expect(body.devices[1]?.["id"]).toBe(await deviceId(laptop.family));
    expect(body.freshUntil).not.toBeNull();
    expect(listed.body).not.toContain(laptop.family);
    expect(listed.body).not.toContain(await deviceId(stranger.family));
    expect(Object.keys(body.devices[0] ?? {}).toSorted()).toEqual(
      ["current", "id", "lastUsedAt", "model", "platform", "signedInAt"].toSorted(),
    );
  });

  it("ends another device, answers 204 again for it, and refuses this one, an unknown one and another player's", async () => {
    const player = await newPlayer();
    const laptop = await signIn(player.id);
    const here = await signIn(player.id);
    const other = await signIn((await newPlayer()).id);
    const end = (id: string) => call("POST", `/v1/me/devices/${id}/end`, here, {});
    expect((await end(await deviceId(laptop.family))).statusCode).toBe(204);
    expect(await liveRefresh(laptop.family)).toBe(0);
    expect((await end(await deviceId(laptop.family))).statusCode).toBe(204);
    const current = await end(await deviceId(here.family));
    expect([current.statusCode, current.json<Row>()["code"]]).toEqual([422, "current_device"]);
    expect((await end(randomUUID())).statusCode).toBe(404);
    expect((await end(await deviceId(other.family))).statusCode).toBe(404);
    expect(await liveRefresh(other.family)).toBe(1);
    const gone = await call("GET", "/v1/me/devices", laptop);
    expect(gone.statusCode).toBe(401);
  });

  it("asks a stale sign-in for a fresh code, then ends the others", async () => {
    const player = await newPlayer();
    const laptop = await signIn(player.id);
    const tablet = await signIn(player.id);
    const here = await signIn(player.id);
    await stale(here.family);
    const refused = await call("POST", "/v1/me/devices/end-others", here, {});
    expect([refused.statusCode, refused.json<Row>()["code"]]).toEqual([403, "reauth_required"]);
    const noEmail = await call("POST", "/v1/me/reauth/code", here, {
      channel: "email",
      lang: "en",
    });
    expect([noEmail.statusCode, noEmail.json<Row>()["code"]]).toEqual([422, "no_contact"]);
    const asked = await call("POST", "/v1/me/reauth/code", here, { channel: "phone", lang: "en" });
    expect(asked.statusCode).toBe(202);
    const sent = asked.json<{ challengeToken: string; sentTo: string; expiresInSeconds: number }>();
    expect(sent.sentTo).toBe(`${player.phone.slice(0, 5)}•••••${player.phone.slice(-2)}`);
    expect(sent.expiresInSeconds).toBe(300);
    const text = test.sms.sent.filter((sms) => sms.to === player.phone).at(-1)?.text ?? "";
    expect(text).toContain("confirm it's you");
    const wrong = await call("POST", "/v1/me/reauth/verify", here, {
      challengeToken: sent.challengeToken,
      code: "000000" === test.sms.lastCode(player.phone) ? "111111" : "000000",
    });
    expect([wrong.statusCode, wrong.json<Row>()["code"]]).toEqual([422, "invalid_code"]);
    expect(wrong.json<{ details: Row }>().details["attemptsLeft"]).toBe(2);
    const fromLaptop = await call("POST", "/v1/me/reauth/verify", laptop, {
      challengeToken: sent.challengeToken,
      code: test.sms.lastCode(player.phone),
    });
    expect(fromLaptop.statusCode).toBe(410);
    const right = await call("POST", "/v1/me/reauth/verify", here, {
      challengeToken: sent.challengeToken,
      code: test.sms.lastCode(player.phone),
    });
    expect(right.statusCode).toBe(200);
    expect(typeof right.json<Row>()["freshUntil"]).toBe("string");
    const ended = await call("POST", "/v1/me/devices/end-others", here, {});
    expect([ended.statusCode, ended.json<Row>()["ended"]]).toEqual([200, 2]);
    expect(await liveRefresh(laptop.family)).toBe(0);
    expect(await liveRefresh(tablet.family)).toBe(0);
    expect(await liveRefresh(here.family)).toBe(1);
  });

  /** Rows of a throttle window under one key (`bucket` alone: the platform budget, whatever its stripe). */
  const counted = async (bucket: string, key?: Buffer) =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM auth_throttle WHERE bucket = $1 AND ($2::bytea IS NULL OR key = $2)",
        [bucket, key ?? null],
      )
    )[0]?.n;
  const fill = (bucket: string, key: Buffer, n: number) =>
    owner(
      "INSERT INTO auth_throttle (bucket, key, at) SELECT $1, $2, clock_timestamp() FROM generate_series(1, $3)",
      [bucket, key, n],
    );
  const askCode = (phone: Phone, payload: object) =>
    call("POST", "/v1/me/reauth/code", phone, payload);

  it("texts the code in Arabic by default, emails it on the email channel, and spends one platform unit a text", async () => {
    const email = newMailbox();
    const player = await newPlayer(email);
    const here = await signIn(player.id);
    const budget = await counted("sms_platform");
    const texted = await askCode(here, { channel: "phone" });
    expect(texted.statusCode).toBe(202);
    expect(await counted("sms_platform")).toBe((budget ?? 0) + 1);
    const code = test.sms.lastCode(player.phone);
    expect(test.sms.sent.at(-1)?.text).toBe(
      `رمز تأكيد هويتك في كويستفاي: ${code}. لا تشاركه مع أحد.`,
    );
    const mailed = await askCode(here, { channel: "email", lang: "en" });
    expect(mailed.statusCode).toBe(202);
    const sent = mailed.json<{ challengeToken: string; sentTo: string }>();
    expect(sent.sentTo).toBe(`${email.slice(0, 1)}•••@najd.sa`);
    expect(test.mail.to(email).at(-1)?.text).toContain("It is valid for 5 minutes.");
    const right = await call("POST", "/v1/me/reauth/verify", here, {
      challengeToken: sent.challengeToken,
      code: test.mail.lastCode(email),
    });
    expect(right.statusCode).toBe(200);
    const said = events().filter((line) => line["event"] === "player.reauth_code_sent");
    expect(said.map((line) => line["channel"])).toEqual(["phone", "email"]);
    expect(lines.join("\n")).not.toContain(email);
  });

  it("answers 503 when the gateway refuses the text or the email fails, and logs only why", async () => {
    const email = newMailbox();
    const player = await newPlayer(email);
    const here = await signIn(player.id);
    test.sms.next = { kind: "refused", reason: "blocked" };
    const refused = await askCode(here, { channel: "phone" });
    expect([refused.statusCode, refused.json<Row>()["code"]]).toEqual([503, "sms_unavailable"]);
    expect(refused.json<{ details: Row }>().details["emailOffered"]).toBe(false);
    test.mail.failing = true;
    const failed = await askCode(here, { channel: "email" });
    expect([failed.statusCode, failed.json<Row>()["code"]]).toEqual([503, "email_unavailable"]);
    expect(events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "player.sms_refused",
          gateway: "recording",
          reason: "blocked",
        }),
        expect.objectContaining({ event: "player.email_unavailable", reason: "EmailSendError" }),
      ]),
    );
    expect(events().some((line) => line["event"] === "player.reauth_code_sent")).toBe(false);
  });

  it("answers 429 with retry-after once the contact's hourly codes are spent, and gives the platform unit back", async () => {
    const player = await newPlayer();
    const here = await signIn(player.id);
    await fill("player_code_contact", keys.contactThrottleKey(player.phone), 5);
    const budget = await counted("sms_platform");
    const held = await askCode(here, { channel: "phone" });
    expect([held.statusCode, held.json<Row>()["code"]]).toEqual([429, "too_many_attempts"]);
    expect(Number(held.headers["retry-after"])).toBeGreaterThan(0);
    expect(held.json<{ details: Row }>().details["retryAfterSeconds"]).toBe(
      Number(held.headers["retry-after"]),
    );
    expect(await counted("sms_platform")).toBe(budget);
    expect(test.sms.sent.filter((sms) => sms.to === player.phone)).toHaveLength(0);
    expect(events()).toContainEqual(
      expect.objectContaining({ event: "player.throttled", step: "reauth_code", channel: "phone" }),
    );
  });

  it("counts a wrong code against the player but not a right one, and refuses a verify once that window is full", async () => {
    const player = await newPlayer();
    const here = await signIn(player.id);
    const failures = keys.playerKey(player.id);
    const asked = await askCode(here, { channel: "phone" });
    const { challengeToken } = asked.json<{ challengeToken: string }>();
    const code = test.sms.lastCode(player.phone);
    const verify = (typed: string) =>
      call("POST", "/v1/me/reauth/verify", here, { challengeToken, code: typed });
    expect((await verify(code === "000000" ? "111111" : "000000")).statusCode).toBe(422);
    expect(await counted("contact_fail_player", failures)).toBe(1);
    expect((await verify(code)).statusCode).toBe(200);
    expect(await counted("contact_fail_player", failures)).toBe(1);
    expect(events().filter((line) => line["event"] === "player.reauth_code_failed")).toHaveLength(
      1,
    );
    await fill("contact_fail_player", failures, 9);
    const held = await verify(code);
    expect([held.statusCode, held.json<Row>()["code"]]).toEqual([429, "too_many_attempts"]);
    expect(Number(held.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("answers 401 when this device's sign-in has ended though its access token is still live", async () => {
    const player = await newPlayer();
    const here = await signIn(player.id);
    await owner("UPDATE player_sign_in_device SET ended_at = now() WHERE family = $1", [
      here.family,
    ]);
    expect((await call("GET", "/v1/me/devices", here)).statusCode).toBe(401);
    expect((await askCode(here, { channel: "phone" })).statusCode).toBe(401);
    expect(test.sms.sent.filter((sms) => sms.to === player.phone)).toHaveLength(0);
  });

  it("passes on a device door's error that is not PN401 unchanged", async () => {
    const player = await newPlayer();
    const broken = new Error("the door broke");
    await expect(asDevicePlayer(test.pool, player.id, () => Promise.reject(broken))).rejects.toBe(
      broken,
    );
  });

  it("asks a stale sign-in for a fresh code before it ends one device, and takes no body or an empty one only", async () => {
    const player = await newPlayer();
    const laptop = await signIn(player.id);
    const here = await signIn(player.id);
    await stale(here.family);
    const one = `/v1/me/devices/${await deviceId(laptop.family)}/end`;
    const ended = await call("POST", one, here);
    expect([ended.statusCode, ended.json<Row>()["code"]]).toEqual([403, "reauth_required"]);
    expect((await call("POST", one, here, { extra: 1 })).statusCode).toBe(400);
    const others = await call("POST", "/v1/me/devices/end-others", here);
    expect(others.statusCode).toBe(403);
    expect((await call("POST", "/v1/me/devices/end-others", here, { extra: 1 })).statusCode).toBe(
      400,
    );
    expect(await liveRefresh(laptop.family)).toBe(1);
  });

  it("labels a live sign-in's device with its platform and its model, spaces folded", async () => {
    const player = await newPlayer();
    const phone = await signIn(player.id);
    await labelDevice(
      { pool: test.pool, keys },
      sha(phone.refresh),
      { platform: "ios", model: "  iPhone   15 Pro " },
      { address: "127.0.0.1", userAgent: null, log: () => undefined },
    );
    const [row] = await owner<{ platform: string; model: string }>(
      "SELECT platform, model FROM player_sign_in_device WHERE family = $1",
      [phone.family],
    );
    expect(row).toEqual({ platform: "ios", model: "iPhone 15 Pro" });
  });

  it("answers 401 on every device route without a bearer token", async () => {
    for (const [method, url, payload] of [
      ["GET", "/v1/me/devices", undefined],
      ["POST", `/v1/me/devices/${randomUUID()}/end`, {}],
      ["POST", "/v1/me/devices/end-others", {}],
      ["POST", "/v1/me/reauth/code", { channel: "phone" }],
      ["POST", "/v1/me/reauth/verify", { challengeToken: "x".repeat(43), code: "123456" }],
    ] as const) {
      expect((await call(method, url, null, payload)).statusCode, url).toBe(401);
    }
  });
});
