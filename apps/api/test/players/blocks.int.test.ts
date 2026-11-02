import { createHash, randomBytes, randomUUID } from "node:crypto";
import { blocksAnswerSchema } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { startApp, testConfig, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * A player's block list over HTTP (T-705, FR-1415): the three routes, 404 for an unknown name, the blocked profile not
 * found, an Idempotency-Key on changes, the 60-an-hour limit, and no blocked name in any access log line.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("blocking a player over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let serial = 0;
  const lines: string[] = [];
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

  const player = async () => {
    serial += 1;
    const username = `blocker_${serial}`;
    const [row] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [username],
      )
    ).rows;
    const token = randomBytes(32).toString("base64url");
    await db.owner.query(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [row?.id, createHash("sha256").update(token).digest()],
    );
    return { id: row?.id ?? "", username, token };
  };
  const call = (token: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  it("blocks, lists, hides the profile and unblocks, with no blocked name in the access log", async () => {
    const [me, other] = [await player(), await player()];
    expect((await call(me.token, "GET", `/v1/players/${other.username}`)).statusCode).toBe(200);
    const blocked = await call(me.token, "POST", "/v1/me/blocks", { username: other.username });
    expect(blocked.statusCode).toBe(204);
    const list = await call(me.token, "GET", "/v1/me/blocks");
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(blocksAnswerSchema.parse(list.json()).blocks).toEqual([
      expect.objectContaining({ username: other.username }),
    ]);
    expect((await call(me.token, "GET", `/v1/players/${other.username}`)).statusCode).toBe(404);
    expect((await call(other.token, "GET", `/v1/players/${me.username}`)).statusCode).toBe(200);
    expect(
      blocksAnswerSchema.parse((await call(other.token, "GET", "/v1/me/blocks")).json()),
    ).toEqual({
      blocks: [],
    });
    const removed = await call(me.token, "DELETE", `/v1/me/blocks/${other.username}`);
    expect(removed.statusCode).toBe(204);
    expect((await call(me.token, "GET", `/v1/players/${other.username}`)).statusCode).toBe(200);
    const routed = lines.filter((line) => line.includes("/v1/me/blocks"));
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.filter((line) => line.includes(other.username))).toEqual([]);
  });

  it("answers 404 for an unknown name and the caller, and needs an Idempotency-Key", async () => {
    const me = await player();
    for (const username of ["no_such_player_here", me.username]) {
      expect((await call(me.token, "POST", "/v1/me/blocks", { username })).statusCode).toBe(404);
      expect((await call(me.token, "DELETE", `/v1/me/blocks/${username}`)).statusCode).toBe(404);
    }
    const keyless = await test.app.inject({
      method: "POST",
      url: "/v1/me/blocks",
      headers: { authorization: `Bearer ${me.token}` },
      payload: { username: "anyone" },
    });
    expect(keyless.statusCode).toBe(400);
    expect((await test.app.inject({ method: "GET", url: "/v1/me/blocks" })).statusCode).toBe(401);
  });

  it("holds 60 changes an hour per player", async () => {
    const [me, other] = [await player(), await player()];
    let last = 0;
    for (let change = 0; change < 61; change += 1) {
      last = (
        await call(
          me.token,
          change % 2 === 0 ? "POST" : "DELETE",
          change % 2 === 0 ? "/v1/me/blocks" : `/v1/me/blocks/${other.username}`,
          change % 2 === 0 ? { username: other.username } : undefined,
        )
      ).statusCode;
    }
    expect(last).toBe(429);
  });
});
