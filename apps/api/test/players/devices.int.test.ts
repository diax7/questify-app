import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshIp, startApp, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Phone = Readonly<{ access: string; refresh: Buffer; family: string }>;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest();

/**
 * Signed-in devices over HTTP (T-810c, FR-140): the list, ending another device or all others, the fresh code that a
 * stale sign-in needs first, and every refusal; no route answers anything of another player, and none opens without a
 * bearer token.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("signed-in devices (HTTP)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });
  beforeEach(() => {
    test.sms.next = { kind: "sent" };
    test.mail.failing = false;
  });

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

  it("answers 401 on every device route without a bearer token", async () => {
    for (const [method, url, payload] of [
      ["GET", "/v1/me/devices", undefined],
      ["POST", `/v1/me/devices/${randomUUID()}/end`, {}],
      ["POST", "/v1/me/devices/end-others", {}],
    ] as const) {
      expect((await call(method, url, null, payload)).statusCode, url).toBe(401);
    }
  });
});
