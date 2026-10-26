import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  achievementsSchema,
  ownEventsSchema,
  publicProfileSchema,
  questifySyncSchema,
} from "@questify/shared";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/** The T-403 player doors over HTTP: shapes, paging, refusals, the sync limit and staff kept out. */
describe.skipIf(TEST_DATABASE_URL === undefined)("questify routes (T-403)", () => {
  let f: QuestifyFixture;
  let test: TestApp;
  beforeAll(async () => {
    f = await questifyFixture();
    test = await startApp(f.db);
  });
  afterAll(async () => {
    await test.close();
    await f.close();
  });

  const tokenOf = async (player: string) => {
    const token = randomBytes(32).toString("base64url");
    await f.owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player, createHash("sha256").update(token).digest()],
    );
    return token;
  };
  const call = (token: string, method: "GET" | "POST", url: string) =>
    test.app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

  it("syncs, reads achievements and pages the passport and history", async () => {
    const player = await f.newPlayer();
    const token = await tokenOf(player);
    const first = await f.newEvent({ startedDaysAgo: 4, cityId: "sa-yanbu" });
    await f.play(first, player);
    const second = await f.newEvent({ startedDaysAgo: 3 });
    await f.join(second, player);

    const synced = await call(token, "POST", "/v1/me/questify/sync");
    expect(synced.statusCode).toBe(200);
    expect(synced.headers["cache-control"]).toBe("private, no-store");
    expect(questifySyncSchema.parse(synced.json())).toEqual({
      achievements: [{ id: "events-attended", tier: "bronze" }],
    });
    expect((await call(token, "POST", "/v1/me/questify/sync")).json()).toEqual({
      achievements: [],
    });

    const achievements = achievementsSchema.parse(
      (await call(token, "GET", "/v1/me/achievements")).json(),
    );
    expect(achievements.achievements.map((row) => [row.id, row.tier, row.progress])).toEqual([
      ["events-attended", "bronze", 1],
      ["quests-done", null, 1],
      ["cities-played", null, 1],
      ["top-ten", null, 0],
      ["community-goals", null, 0],
    ]);

    const passport = ownEventsSchema.parse(
      (await call(token, "GET", "/v1/me/event-history?played=true")).json(),
    );
    expect(passport.events.map((row) => row.eventId)).toEqual([first]);
    expect(passport.events[0]).toMatchObject({
      city: { ar: "ينبع", en: "Yanbu" },
      rankState: "pending",
      isPublic: true,
      played: true,
    });
    const page = ownEventsSchema.parse(
      (await call(token, "GET", "/v1/me/event-history?limit=1")).json(),
    );
    expect(page.events.map((row) => [row.eventId, row.played])).toEqual([[second, false]]);
    const rest = ownEventsSchema.parse(
      (
        await call(
          token,
          "GET",
          `/v1/me/event-history?limit=1&cursor=${encodeURIComponent(page.nextCursor ?? "")}`,
        )
      ).json(),
    );
    expect(rest).toEqual({
      events: [expect.objectContaining({ eventId: first })],
      nextCursor: null,
    });
    for (const query of ["limit=51", "limit=0", "cursor=bad", "played=yes", "other=1"]) {
      expect((await call(token, "GET", `/v1/me/event-history?${query}`)).statusCode, query).toBe(
        400,
      );
    }
  });

  it("shows another player the allowlisted profile with tiers and ended public stamps only", async () => {
    const player = await f.newPlayer();
    const viewer = await tokenOf(await f.newPlayer());
    await f.play(await f.newEvent({ cityId: "sa-alula" }), player);
    await f.play(await f.newEvent({ access: "private" }), player);
    await f.play(await f.newEvent({ phase: "live" }), player);
    await call(await tokenOf(player), "POST", "/v1/me/questify/sync");
    const answer = await call(viewer, "GET", `/v1/players/${await f.usernameOf(player)}`);
    expect(answer.statusCode).toBe(200);
    const body = answer.json();
    expect(publicProfileSchema.parse(body)).toEqual(body);
    expect(body.achievements[0]).toEqual({ id: "events-attended", tier: "bronze" });
    expect(body.passport).toEqual([
      {
        name: { ar: "فعالية", en: expect.any(String) },
        date: expect.any(String),
        city: { ar: "العلا", en: "AlUla" },
        rank: null,
      },
    ]);
  });

  it("refuses a missing token and a staff session on every player door", async () => {
    const email = "questify-staff@team.test";
    await createStaff(f.db.owner, { email });
    const cookie = await signInFully(test, email);
    for (const [method, url] of [
      ["POST", "/v1/me/questify/sync"],
      ["GET", "/v1/me/achievements"],
      ["GET", "/v1/me/event-history"],
    ] as const) {
      expect((await test.app.inject({ method, url })).statusCode, url).toBe(401);
      expect(
        (await test.app.inject({ method, url, headers: withSession(cookie) })).statusCode,
        url,
      ).toBe(401);
    }
  });

  it("limits a player to 20 syncs a minute and says when to retry", async () => {
    const token = await tokenOf(await f.newPlayer());
    for (let i = 0; i < 20; i += 1) {
      expect((await call(token, "POST", "/v1/me/questify/sync")).statusCode).toBe(200);
    }
    const limited = await call(token, "POST", "/v1/me/questify/sync");
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await call(token, "GET", "/v1/me/achievements")).statusCode).toBe(200);
  });
});
