import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshIp, startApp, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Issued = Readonly<{ accessToken: string; refreshToken: string }>;

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest();
const PLAYER_ACCEPT = { terms: "0.1", privacy: "0.1" };

/**
 * The `web` device platform (T-803 P2, migration 0188, ADR-820): the forwarder labels a browser sign-in `{ platform:
 * "web" }`; the API stores it without a model, lists and exports it, and counts it in the ten live families (ADR-717),
 * so an eleventh sign-in ends the oldest family. A web re-sign-in that logs its old cookie out first (the forwarder's
 * step 1) leaves every phone signed in.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the web sign-in device", () => {
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

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newPlayer = async () => {
    counter += 1;
    const phone = `+9665${String(41_000_000 + counter).slice(-8)}`;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`web_device_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, $2)", [id, phone]);
    return { id, phone };
  };

  /** A phone sign-in as the sign-in functions issue it; one transaction each, so each is newer than the last. */
  const phoneFamily = async (player: string) => {
    const family = randomUUID();
    await owner("SELECT issue_player_tokens($1, $2, $3, $4)", [
      player,
      sha(randomBytes(32).toString("base64url")),
      sha(randomBytes(32)),
      family,
    ]);
    await owner("UPDATE player_sign_in_device SET platform = 'ios' WHERE family = $1", [family]);
    return family;
  };

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    test.app.inject({
      method: "POST",
      url,
      headers: { "x-forwarded-for": freshIp(), ...headers },
      payload,
    });

  /** A sign-in by SMS code with the body the forwarder sends: the device always `{ platform: "web" }`, or as given. */
  const webSignIn = async (phone: string, device: object = { platform: "web" }) => {
    const asked = await post("/v1/auth/code", {
      channel: "phone",
      value: phone,
      accept: PLAYER_ACCEPT,
    });
    expect(asked.statusCode).toBe(202);
    const { challengeToken } = asked.json<{ challengeToken: string }>();
    const verified = await post("/v1/auth/verify", {
      challengeToken,
      code: test.sms.lastCode(phone),
      device,
    });
    expect(verified.statusCode).toBe(200);
    return verified.json<Issued>();
  };

  const familyOf = async (refreshToken: string) =>
    (
      await owner<{ family: string }>("SELECT family FROM player_refresh WHERE token_hash = $1", [
        sha(refreshToken),
      ])
    )[0]?.family ?? "";
  const live = async (family: string) =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM player_refresh WHERE family = $1 AND revoked_at IS NULL",
        [family],
      )
    )[0]?.n === 1;
  const deviceRow = async (family: string) =>
    (
      await owner<{ platform: string | null; model: string | null; ended: boolean }>(
        "SELECT platform, model, ended_at IS NOT NULL AS ended FROM player_sign_in_device WHERE family = $1",
        [family],
      )
    )[0];

  it("accepts a web label, stores it without a model, and lists and exports it", async () => {
    const player = await newPlayer();
    const issued = await webSignIn(player.phone, { platform: "web", model: "Chrome 140" });
    expect(await deviceRow(await familyOf(issued.refreshToken))).toEqual({
      platform: "web",
      model: null,
      ended: false,
    });
    const bearer = { authorization: `Bearer ${issued.accessToken}` };
    const listed = await test.app.inject({ url: "/v1/me/devices", headers: bearer });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ devices: Row[] }>().devices).toEqual([
      expect.objectContaining({ platform: "web", model: null, current: true }),
    ]);
    const exported = await post("/v1/me/data-export", {}, bearer);
    expect(exported.statusCode).toBe(200);
    expect(exported.json<{ signedInDevices: Row[] }>().signedInDevices).toEqual([
      expect.objectContaining({ platform: "web", model: null }),
    ]);
  });

  it("refuses any other platform at the API and in the table, and a model on a web row", async () => {
    const player = await newPlayer();
    const asked = await post("/v1/auth/code", {
      channel: "phone",
      value: player.phone,
      accept: PLAYER_ACCEPT,
    });
    const { challengeToken } = asked.json<{ challengeToken: string }>();
    const refused = await post("/v1/auth/verify", {
      challengeToken,
      code: test.sms.lastCode(player.phone),
      device: { platform: "windows" },
    });
    expect(refused.statusCode).toBe(400);
    const family = await phoneFamily(player.id);
    for (const sql of [
      "UPDATE player_sign_in_device SET platform = 'windows' WHERE family = $1",
      "UPDATE player_sign_in_device SET platform = 'web', model = 'Chrome' WHERE family = $1",
    ]) {
      await expect(owner(sql, [family]), sql).rejects.toMatchObject({ code: "23514" });
    }
    await owner(
      "UPDATE player_sign_in_device SET platform = 'web', model = NULL WHERE family = $1",
      [family],
    );
    expect((await deviceRow(family))?.platform).toBe("web");
  });

  it("counts a web sign-in in the ten: ten phones and a web sign-in end the oldest phone and keep the web family", async () => {
    const player = await newPlayer();
    const phones: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      phones.push(await phoneFamily(player.id));
    }
    const web = await familyOf((await webSignIn(player.phone)).refreshToken);
    expect(await live(web)).toBe(true);
    expect((await deviceRow(web))?.platform).toBe("web");
    expect(await live(phones[0] ?? "")).toBe(false);
    expect((await deviceRow(phones[0] ?? ""))?.ended).toBe(true);
    for (const phone of phones.slice(1)) {
      expect(await live(phone)).toBe(true);
    }
  });

  it("keeps all nine phones when a web cookie signs in again after logging its old family out", async () => {
    const player = await newPlayer();
    const phones: string[] = [];
    for (let i = 0; i < 9; i += 1) {
      phones.push(await phoneFamily(player.id));
    }
    const first = await webSignIn(player.phone);
    const oldWeb = await familyOf(first.refreshToken);
    // The forwarder's step 1: the browser still holds a cookie, so it is logged out before the new sign-in.
    expect((await post("/v1/auth/logout", { refreshToken: first.refreshToken })).statusCode).toBe(
      204,
    );
    const again = await familyOf((await webSignIn(player.phone)).refreshToken);
    expect(await live(oldWeb)).toBe(false);
    expect(await live(again)).toBe(true);
    for (const phone of phones) {
      expect(await live(phone), phone).toBe(true);
    }
  });
});
