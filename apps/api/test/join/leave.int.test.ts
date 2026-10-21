import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp, type TestApp } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** Leaving an event over HTTP (FR-1703, T-208): the player's own enrollment only; a ban is never dodged by leaving. */
describe.skipIf(TEST_DATABASE_URL === undefined)("leaving an event", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A player with a bearer session, enrolled in organizer A's event with this status. */
  const newMember = async (status: string): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`leaver_${counter}`],
    );
    const id = made?.id ?? "";
    await owner(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4)",
      [ids.orgA, ids.eventA, id, status],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    return { id, token };
  };

  const leave = (token: string, event = ids.eventA) =>
    test.app.inject({
      method: "POST",
      url: `/v1/events/${event}/leave`,
      headers: { authorization: `Bearer ${token}` },
    });
  const statusOf = async (player: string) =>
    (
      await owner<{ status: string }>("SELECT status FROM enrollment WHERE player_id = $1", [
        player,
      ])
    )[0]?.status;

  it("leaves an active or pending enrollment, and answers the same again", async () => {
    for (const status of ["active", "pending"]) {
      const member = await newMember(status);
      expect((await leave(member.token)).statusCode).toBe(204);
      expect(await statusOf(member.id)).toBe("left");
      expect((await leave(member.token)).statusCode).toBe(204);
    }
  });

  it("refuses a banned or removed player, and an event the player is not in", async () => {
    for (const status of ["banned", "removed"]) {
      const member = await newMember(status);
      const refused = await leave(member.token);
      expect([refused.statusCode, refused.json<{ code: string }>().code]).toEqual([
        409,
        "cannot_leave",
      ]);
      expect(await statusOf(member.id)).toBe(status);
    }
    const member = await newMember("active");
    expect((await leave(member.token, ids.eventB)).statusCode).toBe(404);
    expect((await leave(member.token, "not-a-uuid")).statusCode).toBe(400);
    const anonymous = await test.app.inject({
      method: "POST",
      url: `/v1/events/${ids.eventA}/leave`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(await statusOf(member.id)).toBe("active");
  });
});
