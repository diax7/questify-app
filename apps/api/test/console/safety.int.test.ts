import { randomUUID } from "node:crypto";
import {
  allowPageSchema,
  banAnswerSchema,
  retiredPageSchema,
  wordsPageSchema,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Method = "GET" | "POST" | "DELETE";

const BAN = { reasonCode: "spam", note: "Sent the same invite link to every player." };
const LIFT = { reasonCode: "mistake", note: "Wrong account, the spammer was another one." };
const TIERS = { tiers: [{ achievementId: "events-attended", tier: "bronze" }] };

/**
 * The console's safety tools over HTTP (T-705): ban and lift, the word lists and the retired names. 404 to everyone but
 * a platform admin; every change takes an Idempotency-Key and a reason; a retired name never reaches a URL or a log line;
 * the wall's PB423 answers one clear 423 on every path.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console safety tools over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie: string;
  let memberCookie: string;
  let playerId: string;
  let names = 0;
  const lines: string[] = [];

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newPlayer = async () => {
    names += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`safety_route_${names}`],
    );
    return made?.id ?? "";
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, {
      level: "info",
      stream: { write: (line: string) => void lines.push(line) },
    });
    await createStaff(db.owner, { email: "safety@questify.test", admin: true });
    await createStaff(db.owner, { email: "owner@najd.test" });
    adminCookie = await signInFully(test, "safety@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
    playerId = await newPlayer();
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });

  it("answers 404 to a member and refuses nobody signed in, on every route", async () => {
    const paths: [Method, string, object?][] = [
      ["POST", `/v1/admin/players/${playerId}/ban`, BAN],
      ["POST", `/v1/admin/players/${playerId}/lift-ban`, LIFT],
      ["GET", "/v1/admin/words"],
      ["POST", "/v1/admin/words", { word: "gnarl", match: "word", language: "en" }],
      ["DELETE", "/v1/admin/words/gnarl"],
      ["GET", "/v1/admin/name-allow"],
      ["POST", "/v1/admin/name-allow", { word: "gnarlan" }],
      ["DELETE", "/v1/admin/name-allow/nasser"],
      ["GET", "/v1/admin/retired-usernames"],
      ["POST", "/v1/admin/retired-usernames/release", { username: "anyone" }],
      ["POST", `/v1/admin/players/${playerId}/achievement-tiers/revoke`, { ...TIERS, ...BAN }],
      ["POST", `/v1/admin/players/${playerId}/achievement-tiers/restore`, { ...TIERS, ...LIFT }],
    ];
    for (const [method, url, payload] of paths) {
      expect((await call(method, url, memberCookie, payload)).statusCode, url).toBe(404);
      const anonymous = await test.app.inject({
        method,
        url,
        headers: { "idempotency-key": randomUUID() },
        ...(payload === undefined ? {} : { payload }),
      });
      expect([401, 403, 404], url).toContain(anonymous.statusCode);
    }
    expect(await owner("SELECT status FROM player WHERE id = $1", [playerId])).toEqual([
      { status: "active" },
    ]);
  });

  it("bans and lifts with a reason, answers 409 to a repeat and 400 to a bad reason", async () => {
    const target = await newPlayer();
    const bad = await call("POST", `/v1/admin/players/${target}/ban`, admin(), {
      reasonCode: "mistake",
      note: BAN.note,
    });
    expect(bad.json()).toMatchObject({ code: "invalid_player_action" });
    const banned = await call("POST", `/v1/admin/players/${target}/ban`, admin(), BAN);
    expect(banned.statusCode).toBe(200);
    expect(banAnswerSchema.parse(banned.json()).actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (await call("POST", `/v1/admin/players/${target}/ban`, admin(), BAN)).json(),
    ).toMatchObject({ code: "already_banned" });
    const lifted = await call("POST", `/v1/admin/players/${target}/lift-ban`, admin(), LIFT);
    expect(lifted.statusCode).toBe(200);
    expect(banAnswerSchema.parse(lifted.json()).actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (await call("POST", `/v1/admin/players/${target}/lift-ban`, admin(), LIFT)).json(),
    ).toMatchObject({ code: "not_banned" });
    expect(
      (await call("POST", `/v1/admin/players/${randomUUID()}/ban`, admin(), BAN)).statusCode,
    ).toBe(404);
    expect(lines.join("\n")).not.toContain(BAN.note);
  });

  it("revokes and restores a banned player's tiers with a reason, once each, and shows them on the record", async () => {
    const target = await newPlayer();
    await owner("INSERT INTO player_xp (player_id) VALUES ($1) ON CONFLICT DO NOTHING", [target]);
    await owner(
      "INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES ($1, 'events-attended', 'bronze')",
      [target],
    );
    const revoke = `/v1/admin/players/${target}/achievement-tiers/revoke`;
    const restore = `/v1/admin/players/${target}/achievement-tiers/restore`;
    const revokeBody = { ...TIERS, reasonCode: "cheating", note: BAN.note };
    expect((await call("POST", revoke, admin(), revokeBody)).json()).toMatchObject({
      code: "not_banned",
    });
    await call("POST", `/v1/admin/players/${target}/ban`, admin(), BAN);
    for (const bad of [
      { ...revokeBody, reasonCode: "terms" },
      { ...revokeBody, tiers: [] },
      { ...revokeBody, tiers: [...TIERS.tiers, ...TIERS.tiers] },
      { ...revokeBody, tiers: [{ achievementId: "events-attended", tier: "platinum" }] },
    ]) {
      expect((await call("POST", revoke, admin(), bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (
        await call("POST", revoke, admin(), {
          ...revokeBody,
          tiers: [{ achievementId: "quests-done", tier: "gold" }],
        })
      ).json(),
    ).toMatchObject({ code: "tier_not_earned" });
    const done = await call("POST", revoke, admin(), revokeBody);
    expect(done.statusCode).toBe(200);
    expect(banAnswerSchema.parse(done.json()).actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call("POST", revoke, admin(), revokeBody)).json()).toMatchObject({
      code: "tier_already_revoked",
    });
    const record = (await call("GET", `/v1/admin/players/${target}`, admin())).json();
    expect(record.achievements).toEqual([
      { id: "events-attended", name: expect.any(Object), tier: "bronze", revoked: true },
    ]);
    const restoreBody = { ...TIERS, ...LIFT };
    expect((await call("POST", restore, admin(), restoreBody)).statusCode).toBe(200);
    expect((await call("POST", restore, admin(), restoreBody)).json()).toMatchObject({
      code: "tier_not_revoked",
    });
    expect(
      (
        await call(
          "POST",
          `/v1/admin/players/${randomUUID()}/achievement-tiers/restore`,
          admin(),
          restoreBody,
        )
      ).statusCode,
    ).toBe(404);
    expect(lines.join("\n")).not.toContain(BAN.note);
  });

  it("answers an admin's word-list reads sent at the same moment, not 429 for the one that lost the race", async () => {
    const urls = [
      "/v1/admin/words",
      "/v1/admin/words?q=a",
      "/v1/admin/retired-usernames",
      "/v1/admin/words?q=b",
    ];
    const answers = await Promise.all(urls.map((url) => call("GET", url, admin())));
    expect(answers.map((answer) => answer.statusCode)).toEqual(urls.map(() => 200));
  });

  it("edits the word lists: add, a repeat, a bad word, the page, remove", async () => {
    const added = await call("POST", "/v1/admin/words", admin(), {
      word: "Snarkle",
      match: "part",
      language: "en",
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ word: "Snarkle" });
    expect(
      (
        await call("POST", "/v1/admin/words", admin(), {
          word: "snarkly",
          match: "word",
          language: "en",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call("POST", "/v1/admin/words", admin(), {
          word: "snarkle",
          match: "word",
          language: "en",
        })
      ).json(),
    ).toMatchObject({ code: "word_exists" });
    expect(
      (
        await call("POST", "/v1/admin/words", admin(), {
          word: "x1",
          match: "word",
          language: "en",
        })
      ).json(),
    ).toMatchObject({ code: "invalid_word" });
    const words = async (query: string) => {
      const page = wordsPageSchema.parse(
        (await call("GET", `/v1/admin/words?${query}`, admin())).json(),
      );
      return { words: page.words.map((row) => row.word), total: page.total };
    };
    expect(await words("q=snark&language=en")).toEqual({
      words: ["snarkle", "snarkly"],
      total: 2,
    });
    expect(await words("q=snark&language=ar")).toEqual({ words: [], total: 0 });
    expect(await words("q=snark&match=word")).toEqual({ words: ["snarkly"], total: 1 });
    expect(await words("q=snark&after=snarkle")).toEqual({ words: ["snarkly"], total: 2 });
    expect((await call("DELETE", "/v1/admin/words/snarkly", admin())).statusCode).toBe(204);
    expect((await call("DELETE", "/v1/admin/words/snarkle", admin())).statusCode).toBe(204);
    expect((await call("DELETE", "/v1/admin/words/snarkle", admin())).statusCode).toBe(404);
  });

  it("edits the full-name allow-list: add, a repeat, each refusal, the page, remove", async () => {
    const added = await call("POST", "/v1/admin/name-allow", admin(), { word: "Snarklan" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ word: "snarklan" });
    expect(
      (await call("POST", "/v1/admin/name-allow", admin(), { word: "سنركلان" })).statusCode,
    ).toBe(201);
    for (const [word, status, code] of [
      ["SNARKLAN", 409, "word_exists"],
      ["x1", 400, "invalid_allow_word"],
      ["fuck", 422, "allow_word_listed"],
      ["fucks", 422, "allow_word_listed"],
      ["fuckme", 422, "allow_word_unsafe"],
    ] as const) {
      const answer = await call("POST", "/v1/admin/name-allow", admin(), { word });
      expect([answer.statusCode, answer.json()], word).toMatchObject([status, { code }]);
    }
    const page = async (query: string) => {
      const body = allowPageSchema.parse(
        (await call("GET", `/v1/admin/name-allow?${query}`, admin())).json(),
      );
      return { words: body.words.map((row) => [row.word, row.language]), total: body.total };
    };
    expect(await page("q=narkla")).toEqual({ words: [["snarklan", "en"]], total: 1 });
    expect(await page("q=نركلان&language=ar")).toEqual({ words: [["سنركلان", "ar"]], total: 1 });
    expect(await page("q=narkla&language=ar")).toEqual({ words: [], total: 0 });
    expect((await call("GET", "/v1/admin/name-allow?match=word", admin())).statusCode).toBe(400);
    expect((await call("DELETE", "/v1/admin/name-allow/Snarklan", admin())).statusCode).toBe(204);
    expect(
      (await call("DELETE", `/v1/admin/name-allow/${encodeURIComponent("سنركلان")}`, admin()))
        .statusCode,
    ).toBe(204);
    expect((await call("DELETE", "/v1/admin/name-allow/snarklan", admin())).statusCode).toBe(404);
    expect(
      await owner(
        "SELECT action, target_id FROM audit_log WHERE action LIKE 'full_name_allow.%' ORDER BY id",
      ),
    ).toEqual([
      { action: "full_name_allow.add", target_id: "snarklan" },
      { action: "full_name_allow.add", target_id: "سنركلان" },
      { action: "full_name_allow.remove", target_id: "snarklan" },
      { action: "full_name_allow.remove", target_id: "سنركلان" },
    ]);
  });

  it("lists and releases a retired name, which stays out of every URL and log line", async () => {
    await owner(
      "INSERT INTO username_retired (fold) VALUES ('rude_old_handle'), ('calm_old_handle')",
    );
    const retired = async (query: string) =>
      retiredPageSchema
        .parse(
          (
            (await call("GET", `/v1/admin/retired-usernames?${query}`, admin())).json() as {
              names: unknown;
            }
          ).names,
        )
        .map((row) => row.fold);
    expect(await retired("q=rude")).toEqual(["rude_old_handle"]);
    expect(await retired("q=old_handle")).toEqual(["calm_old_handle", "rude_old_handle"]);
    expect(await retired("q=old_handle&after=calm_old_handle")).toEqual(["rude_old_handle"]);
    const released = await call("POST", "/v1/admin/retired-usernames/release", admin(), {
      username: "Rude_Old_Handle",
    });
    expect(released.statusCode).toBe(204);
    expect(
      (
        await call("POST", "/v1/admin/retired-usernames/release", admin(), {
          username: "rude_old_handle",
        })
      ).statusCode,
    ).toBe(404);
    expect(lines.filter((line) => /rude_old_handle/i.test(line) && !line.includes('"q"'))).toEqual(
      [],
    );
  });

  it("answers the wall's refusal as one clear 423 (PB423)", async () => {
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Wall Org', 'wall-org') RETURNING id",
    );
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'WALL1', 'Wall', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [org?.id],
    );
    const banned = await newPlayer();
    const [enrollment] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [org?.id, event?.id, banned],
    );
    const staffId = await createStaff(db.owner, { email: "wall@wall.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org?.id, staffId],
    );
    const cookie = await signInFully(test, "wall@wall.test");
    await owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
    const award = await call(
      "POST",
      `/v1/organizers/${org?.id}/events/${event?.id}/players/${enrollment?.id}/awards`,
      cookie,
      { points: 10, reason: "Helped at the gate" },
    );
    expect(award.statusCode).toBe(423);
    expect(award.json()).toMatchObject({ code: "player_inactive" });
  });

  function admin(): string {
    return adminCookie;
  }
});
