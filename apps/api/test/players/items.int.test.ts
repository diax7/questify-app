import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { startApp, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("profile HTTP privacy", () => {
  let db: TestDatabase;
  let test: TestApp;
  let serial = 0;
  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });
  const player = async () => {
    serial += 1;
    const username = `cosmetic_${serial}`;
    const id = (
      await db.owner.query("INSERT INTO player(username,birth_year) VALUES($1,1990) RETURNING id", [
        username,
      ])
    ).rows[0].id as string;
    await db.owner.query(
      "INSERT INTO player_contact(player_id,email,phone_e164) VALUES($1,$2,$3)",
      [id, `private${serial}@example.com`, `+9665000${String(serial).padStart(5, "0")}`],
    );
    const token = randomBytes(32).toString("base64url");
    await db.owner.query(
      "INSERT INTO player_session(player_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, username, token };
  };
  const request = (token: string, path: string, payload?: object) =>
    test.app.inject({
      method: payload === undefined ? "GET" : "PATCH",
      url: path,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  it("uses an exact public allowlist for an unrelated player and never own-profile fields", async () => {
    const a = await player(),
      b = await player();
    const answer = await request(a.token, `/v1/players/${b.username}`);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      username: b.username,
      character: { starter: "falcon" },
      frame: null,
      title: null,
      level: { number: 1, title: { ar: "مستكشف", en: "Explorer" } },
      achievements: [
        { id: "events-attended", tier: null },
        { id: "quests-done", tier: null },
        { id: "cities-played", tier: null },
        { id: "top-ten", tier: null },
        { id: "community-goals", tier: null },
      ],
      passport: [],
    });
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.body).not.toContain("private");
    expect(answer.body).not.toContain("1990");
    expect(answer.body).not.toContain(b.id);
    const mine = await request(a.token, "/v1/me");
    expect(mine.json()).toHaveProperty("identifiers");
    expect(mine.json()).toHaveProperty("equipment");
    expect(mine.headers["cache-control"]).toBe("private, no-store");
    expect(
      (await test.app.inject({ method: "GET", url: `/v1/players/${b.username}` })).statusCode,
    ).toBe(401);
  });
  it("returns the same unavailable response for absent and platform-banned profiles", async () => {
    const a = await player(),
      b = await player();
    await withRequestContext(db.owner, { isAdmin: true }, () =>
      db.owner.query("UPDATE player SET status='banned' WHERE id=$1", [b.id]),
    );
    const absent = await request(a.token, "/v1/players/nobody_here");
    const banned = await request(a.token, `/v1/players/${b.username}`);
    expect(absent.statusCode).toBe(404);
    expect(banned.statusCode).toBe(404);
    expect(absent.json()).toEqual(banned.json());
    expect((await request(b.token, "/v1/me/locker")).statusCode).toBe(401);
  });
  it("rolls back avatar on rename failure and refuses ambiguous/foreign equipment", async () => {
    const a = await player(),
      b = await player();
    expect(
      (await request(a.token, "/v1/me", { avatar: "fox", username: b.username })).statusCode,
    ).toBe(409);
    expect((await request(a.token, "/v1/me")).json()).toMatchObject({
      avatar: "falcon",
      username: a.username,
    });
    for (const patch of [
      { frameId: "level-2" },
      { titleId: "missing" },
      { characterId: "level-3" },
    ]) {
      const result = await request(a.token, "/v1/me", patch);
      expect(result.statusCode).toBe(422);
      expect(result.json().code).toBe("item_not_owned");
    }
    expect(
      (await request(a.token, "/v1/me", { avatar: "fox", characterId: null })).statusCode,
    ).toBe(400);
    expect(
      (await request(a.token, "/v1/me", { username: "fine_name", frameId: "level-2" })).statusCode,
    ).toBe(422);
    expect((await request(a.token, "/v1/me")).json().username).toBe(a.username);
  });
  it("bounds locker paging and acknowledgment input", async () => {
    const a = await player();
    expect((await request(a.token, "/v1/me/locker")).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    for (const suffix of ["limit=101", "limit=0", "cursor=bad", "unexpected=true"])
      expect((await request(a.token, `/v1/me/locker?${suffix}`)).statusCode).toBe(400);
    for (const itemIds of [[], ["a", "a"], Array.from({ length: 101 }, (_, i) => String(i))]) {
      const result = await test.app.inject({
        method: "POST",
        url: "/v1/me/locker/seen",
        headers: { authorization: `Bearer ${a.token}` },
        payload: { itemIds },
      });
      expect(result.statusCode).toBe(400);
    }
  });
  it("bounds public reads and supplies Retry-After", async () => {
    const a = await player();
    for (let i = 0; i < 60; i += 1)
      expect((await request(a.token, `/v1/players/${a.username}`)).statusCode).toBe(200);
    const last = await request(a.token, `/v1/players/${a.username}`);
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
  });
});
