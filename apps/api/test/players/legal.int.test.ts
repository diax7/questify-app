import { createHash, randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { freshIp, startApp, testConfig, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

const IN_FORCE = [
  { id: "terms_of_use", version: "0.1" },
  { id: "privacy_policy", version: "0.1" },
];

/**
 * The player's legal steps over HTTP (T-110): nothing is stored before the terms and privacy are accepted, the app
 * learns the versions in force from the server, and re-acceptance and the guidelines are recorded on request.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("player legal steps", () => {
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
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const count = async (table: string) =>
    (await owner<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n ?? 0;

  const askCode = (accept: unknown): Promise<LightMyRequestResponse> => {
    counter += 1;
    return test.app.inject({
      method: "POST",
      url: "/v1/auth/code",
      headers: { "x-forwarded-for": freshIp() },
      payload: {
        channel: "phone",
        value: `+9665${String(50_000_000 + counter).slice(-8)}`,
        ...(accept === undefined ? {} : { accept }),
      },
    });
  };

  /** A player with a bearer session and, unless told otherwise, the sign-up acceptances in force. */
  const newPlayer = async (accepted = true): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`legal_http_${counter}`],
    );
    const id = made?.id ?? "";
    if (accepted) {
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'terms_of_use', '0.1', 'signup'), ($1, 'privacy_policy', '0.1', 'signup')`,
        [id],
      );
    }
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const me = (token: string) =>
    test.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
    });
  const accept = (token: string, payload: object) =>
    test.app.inject({
      method: "POST",
      url: "/v1/me/acceptances",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  describe("before a code is sent", () => {
    it("stores, counts and logs nothing for a request without the versions in force, and names them", async () => {
      const before = {
        challenges: await count("player_login_challenge"),
        throttle: await count("auth_throttle"),
      };
      const missing = await askCode(undefined);
      expect(missing.statusCode).toBe(400);
      for (const stale of [
        { terms: "0.0", privacy: "0.1" },
        { terms: "0.1", privacy: "0.2" },
      ]) {
        const refused = await askCode(stale);
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: "acceptance_required",
          details: { documents: IN_FORCE },
        });
      }
      expect(await count("player_login_challenge")).toBe(before.challenges);
      expect(await count("auth_throttle")).toBe(before.throttle);
      expect(lines.join("")).not.toContain('"event":"player.');
      expect((await askCode({ terms: "0.1", privacy: "0.1" })).statusCode).toBe(202);
      expect(lines.join("")).toContain('"event":"player.code_sent"');
      expect(await count("player_login_challenge")).toBe(before.challenges + 1);
    });

    it("tells every app the versions in force through its configuration", async () => {
      const config = await test.app.inject({ method: "GET", url: "/v1/config" });
      expect(config.json()).toMatchObject({
        legal: { documents: [...IN_FORCE, { id: "community_guidelines", version: "0.1" }] },
      });
    });
  });

  describe("after sign-up", () => {
    it("asks for nothing when the versions in force are accepted, and for what is missing otherwise", async () => {
      const done = await newPlayer();
      expect((await me(done.token)).json()).toMatchObject({
        legal: { toAccept: [], guidelinesAccepted: false },
      });
      const old = await newPlayer(false);
      expect((await me(old.token)).json()).toMatchObject({
        legal: { toAccept: ["terms_of_use", "privacy_policy"], guidelinesAccepted: false },
      });
    });

    it("records re-acceptance and the guidelines, all or nothing", async () => {
      const player = await newPlayer(false);
      const stale = await accept(player.token, { terms: "0.1", privacy: "0.0" });
      expect(stale.statusCode).toBe(422);
      expect(stale.json()).toMatchObject({ code: "acceptance_required" });
      expect((await me(player.token)).json()).toMatchObject({
        legal: { toAccept: ["terms_of_use", "privacy_policy"] },
      });
      const done = await accept(player.token, { terms: "0.1", privacy: "0.1" });
      expect(done.statusCode).toBe(200);
      expect(done.json()).toMatchObject({ legal: { toAccept: [], guidelinesAccepted: false } });
      const guidelines = await accept(player.token, { terms: "0.1", guidelines: "0.1" });
      expect(guidelines.json()).toMatchObject({ legal: { guidelinesAccepted: true } });
      expect(
        await owner<{ document: string; method: string }>(
          "SELECT document, method FROM player_acceptance WHERE player_id = $1 ORDER BY document, method",
          [player.id],
        ),
      ).toEqual([
        { document: "community_guidelines", method: "submission" },
        { document: "privacy_policy", method: "reaccept" },
        { document: "terms_of_use", method: "reaccept" },
      ]);
      for (const body of [{}, { cookies: "0.1" }, { terms: "new" }]) {
        expect((await accept(player.token, body)).statusCode).toBe(400);
      }
    });

    it("names every document in force when a version is stale", async () => {
      const player = await newPlayer();
      const stale = await accept(player.token, { guidelines: "0.2" });
      expect(stale.json()).toMatchObject({
        details: { documents: [...IN_FORCE, { id: "community_guidelines", version: "0.1" }] },
      });
    });
  });

  describe("the version format", () => {
    const WELL_FORMED = ["1", "10.1", "0.10", "1.2.3"];
    const MALFORMED = ["v0.1", "0.1x", "1.2.3.4", "new"];

    it("refuses a malformed version and calls a well-formed one stale, on the code request", async () => {
      for (const version of MALFORMED) {
        expect((await askCode({ terms: version, privacy: "0.1" })).statusCode).toBe(400);
      }
      for (const version of WELL_FORMED) {
        expect((await askCode({ terms: version, privacy: "0.1" })).statusCode).toBe(422);
      }
    });

    it("refuses a malformed version and calls a well-formed one stale, on re-acceptance", async () => {
      const player = await newPlayer();
      for (const version of MALFORMED) {
        expect((await accept(player.token, { terms: version })).statusCode).toBe(400);
      }
      for (const version of WELL_FORMED) {
        expect((await accept(player.token, { terms: version })).statusCode).toBe(422);
      }
    });
  });
});
