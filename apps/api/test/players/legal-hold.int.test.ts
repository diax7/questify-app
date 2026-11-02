import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * A player who accepted an earlier version of the terms or the privacy policy is held (T-707, ADR-446): every write
 * answers 403 `legal_acceptance_required` until the version in force is accepted. Reads, the acceptance itself and
 * leaving the account stay open.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the player legal hold (HTTP)", () => {
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

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newPlayer = async (): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`legal_hold_${counter}`],
    );
    const id = made?.id ?? "";
    await owner(
      `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'terms_of_use', '0.1', 'signup'), ($1, 'privacy_policy', '0.1', 'signup')`,
      [id],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const call = (
    token: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: object,
  ) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(body === undefined ? {} : { payload: body }),
    });

  const WRITES = [
    ["POST", `/v1/quests/${randomUUID()}/complete`, {}],
    ["POST", "/v1/me/blocks", { username: "someone" }],
    ["POST", "/v1/reports", {}],
    ["PUT", "/v1/me/marketing", { optIn: true }],
    ["POST", "/v1/join", {}],
    ["POST", `/v1/rewards/${randomUUID()}/reserve`, {}],
  ] as const;

  it("is not held while the version in force is the one accepted", async () => {
    const player = await newPlayer();
    for (const [method, url, body] of WRITES) {
      const answer = await call(player.token, method, url, body);
      expect(answer.json<{ code: string }>().code, url).not.toBe("legal_acceptance_required");
    }
  });

  it("refuses writes after a new version, keeps reads and the exits open, and lifts on acceptance", async () => {
    const player = await newPlayer();
    await owner("INSERT INTO legal_version (document, version) VALUES ('terms_of_use', '0.2')");
    for (const [method, url, body] of WRITES) {
      const answer = await call(player.token, method, url, body);
      expect(answer.statusCode, url).toBe(403);
      expect(answer.json()).toMatchObject({ code: "legal_acceptance_required" });
    }
    expect((await call(player.token, "GET", "/v1/me")).statusCode).toBe(200);
    expect((await call(player.token, "DELETE", "/v1/me/push-device")).statusCode).not.toBe(403);
    expect((await call(player.token, "POST", "/v1/me/deletion/code", {})).json()).not.toMatchObject(
      {
        code: "legal_acceptance_required",
      },
    );
    const accepted = await call(player.token, "POST", "/v1/me/acceptances", {
      terms: "0.2",
      privacy: "0.1",
    });
    expect(accepted.statusCode).toBe(200);
    for (const [method, url, body] of WRITES) {
      const answer = await call(player.token, method, url, body);
      expect(answer.json<{ code: string }>().code, url).not.toBe("legal_acceptance_required");
    }
  });
});
