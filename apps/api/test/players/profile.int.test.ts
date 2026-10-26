import { createHash, randomBytes } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettingsService } from "#src/settings/service";
import { startApp, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * The player's own profile over HTTP (T-109): what `GET /v1/me` shows, and changing the avatar and the username
 * through `PATCH /v1/me` (the rules themselves are in test/db/usernames).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("my profile", () => {
  let db: TestDatabase;
  let pool: Pool;
  let test: TestApp;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 2 });
    // No cache: switching username changes off takes effect at once in these tests.
    test = await startApp(db, false, {}, { settings: createSettingsService({ pool, ttlMs: 0 }) });
  });
  afterAll(async () => {
    await test.close();
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A player with a bearer session; returns the id and the token. */
  const newPlayer = async (username?: string): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [username ?? `profiler_${counter}`],
    );
    const id = made?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      `profiler${counter}@najd.sa`,
    ]);
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const me = (token: string | undefined): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  const patch = (token: string, payload: object): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it("shows the player's own name, avatar, whether they may change their name and masked identifiers, nothing else", async () => {
    const player = await newPlayer("shown_name");
    const answer = await me(player.token);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      id: player.id,
      username: "shown_name",
      avatar: "falcon",
      equipment: { character: null, frame: null, title: null },
      usernameChange: { allowed: true, nextChangeAt: null },
      legal: { toAccept: ["terms_of_use", "privacy_policy"], guidelinesAccepted: false },
      identifiers: { phone: null, email: "p•••@najd.sa" },
      questify: {
        nextReward: {
          id: "level-2",
          kind: "frame",
          name: { ar: "إطار الدرب", en: "Trail frame" },
          visualKey: "frame-01",
        },
        xp: 0,
        level: 1,
        levelFrom: 0,
        nextLevelAt: 200,
        title: { ar: "مستكشف", en: "Explorer" },
      },
      help: { unread: 0 },
      gems: 0,
    });
    expect((await me(undefined)).statusCode).toBe(401);
  });

  it("changes the avatar to any of the six, and refuses anything else", async () => {
    const player = await newPlayer();
    const changed = await patch(player.token, { avatar: "camel" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ avatar: "camel" });
    for (const body of [{ avatar: "dragon" }, {}, { nickname: "x" }]) {
      expect((await patch(player.token, body)).statusCode).toBe(400);
    }
  });

  it("renames once, then says when the next change is allowed", async () => {
    const player = await newPlayer();
    const renamed = await patch(player.token, { username: `new_name_${counter}` });
    expect(renamed.statusCode).toBe(200);
    const after = renamed.json<{
      username: string;
      usernameChange: { allowed: boolean; nextChangeAt: string };
    }>();
    expect(after.username).toBe(`new_name_${counter}`);
    expect(after.usernameChange.allowed).toBe(false);
    const next = Date.parse(after.usernameChange.nextChangeAt);
    expect(next - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    const again = await patch(player.token, { username: `newer_${counter}` });
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({
      code: "username_too_soon",
      details: { nextChangeAt: after.usernameChange.nextChangeAt },
    });
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(29 * 24 * 60 * 60);
  });

  it("answers each refusal with its own code and leaves the name as it was", async () => {
    await newPlayer("held_name");
    const player = await newPlayer("keeps_name");
    const cases = [
      [{ username: "bad name" }, 422, "invalid_username"],
      [{ username: "صقرfalcon" }, 422, "invalid_username"],
      [{ username: "shit_king" }, 422, "username_blocked"],
      [{ username: "HELD_NAME" }, 409, "username_taken"],
    ] as const;
    for (const [body, status, code] of cases) {
      const refused = await patch(player.token, body);
      expect(refused.statusCode).toBe(status);
      expect(refused.json()).toMatchObject({ code });
    }
    expect((await me(player.token)).json()).toMatchObject({ username: "keeps_name" });
    expect((await patch(player.token, { username: "ab" })).json()).toMatchObject({
      details: { reason: "length" },
    });
    expect((await patch(player.token, { username: "صقرfalcon" })).json()).toMatchObject({
      details: { reason: "mixed_scripts" },
    });
  });

  it("changes nothing for a refused name sent with an avatar, and nothing for the same name", async () => {
    const player = await newPlayer("steady_name");
    const refused = await patch(player.token, { username: "shit_king", avatar: "owl" });
    expect(refused.statusCode).toBe(422);
    expect((await me(player.token)).json()).toMatchObject({
      username: "steady_name",
      avatar: "falcon",
    });
    const same = await patch(player.token, { username: "steady_name" });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ usernameChange: { allowed: true, nextChangeAt: null } });
    expect(
      await owner("SELECT reason FROM username_history WHERE player_id = $1", [player.id]),
    ).toEqual([{ reason: "signup" }]);
  });

  it("refuses every rename while Questify has username changes off, and says so", async () => {
    const player = await newPlayer();
    await owner(
      `INSERT INTO platform_setting (key, value) VALUES ('features', '{"usernameChanges": {"enabled": false}}')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    try {
      const refused = await patch(player.token, { username: `blocked_${counter}` });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "username_changes_off" });
      expect((await me(player.token)).json()).toMatchObject({
        usernameChange: { allowed: false, nextChangeAt: null },
      });
      expect((await patch(player.token, { avatar: "owl" })).statusCode).toBe(200);
    } finally {
      await owner("DELETE FROM platform_setting WHERE key = 'features'");
    }
  });
});
