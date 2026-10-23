import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { createRevealCodeKey, revealCode } from "#src/quests/qr";
import { revealCategory } from "#src/reveal/reveal";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Secret = { categoryId: string; version: number; url: string };

/** The key the test app signs secret codes with (auth-app's QR secret). */
const REVEAL_KEY = createRevealCodeKey("q".repeat(40));
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const refusedLog = (categoryId: string, refusal: string, reason: string) => [
  { event: "category.reveal_refused", fields: { categoryId, refusal, reason } },
];

/**
 * Category refresh and hidden categories over HTTP (T-304c): the builder's refresh and hidden fields and their refusals,
 * the codes page's secret codes and their regeneration, the reveal route and its order of answers, and the player's
 * quests read with each category's refresh.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("refresh and hidden categories over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, false);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('hide-org', 'hide-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@hide.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@hide.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Hide Fest', 'scheduled', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
      [organizer, `HIDH${counter}`],
    );
    return event?.id ?? "";
  };
  const goLive = (event: string) =>
    owner(
      "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour', ends_at = now() + interval '1 day' WHERE id = $1",
      [event],
    );
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`hide_http_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      organizer,
      event,
      id,
    ]);
    return token;
  };
  /** An enrolled player without a session, for calls below the route. */
  const enrolled = async (event: string, status = "active") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`hide_log_${counter}`],
    );
    await owner(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4)",
      [organizer, event, player?.id, status],
    );
    return player?.id ?? "";
  };
  const reveal = (token: string, categoryId: string, code: string) =>
    test.app.inject({
      method: "POST",
      url: `/v1/categories/${categoryId}/reveal`,
      headers: { authorization: `Bearer ${token}` },
      payload: { code },
    });
  const questsRead = (token: string, event: string) =>
    test.app.inject({
      method: "GET",
      url: `/v1/events/${event}/quests`,
      headers: { authorization: `Bearer ${token}` },
    });
  const dashboard = (method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const newCategory = async (event: string, rules: object = {}) => {
    const made = await dashboard("POST", `/events/${event}/categories`, {
      name: { en: `Chapter ${(counter += 1)}` },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ category: { id: string } }>().category.id;
    const patched = await dashboard("PATCH", `/events/${event}/categories/${id}`, rules);
    expect(patched.statusCode).toBe(200);
    return id;
  };
  const newQuest = async (event: string, categoryId: string, type = "enter_code") =>
    dashboard("POST", `/events/${event}/quests`, {
      categoryId,
      type,
      title: { en: "Play" },
      points: 10,
      config:
        type === "enter_code"
          ? { code: "NAJD2030" }
          : {
              options: [
                { id: "a", text: { en: "A" } },
                { id: "b", text: { en: "B" } },
              ],
            },
    });
  const secretsOf = async (event: string) =>
    (await dashboard("GET", `/events/${event}/codes`)).json<{ secrets: Secret[] }>().secrets;

  describe("the builder", () => {
    it("writes a category's refresh and hidden flag, and reads them back", async () => {
      const event = await newEvent();
      const id = await newCategory(event);
      const patched = await dashboard("PATCH", `/events/${event}/categories/${id}`, {
        refresh: "weekly",
        hidden: true,
      });
      expect(patched.json()).toMatchObject({ category: { refresh: "weekly", hidden: true } });
      const view = await dashboard("GET", `/events/${event}/quests`);
      expect(
        view
          .json<{ categories: { id: string; refresh: string; hidden: boolean }[] }>()
          .categories.find((category) => category.id === id),
      ).toMatchObject({ refresh: "weekly", hidden: true });
      const audit = await owner<{ after: object }>(
        "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'category.update' ORDER BY id DESC LIMIT 1",
        [id],
      );
      expect(audit[0]?.after).toMatchObject({ refresh: "weekly", hidden: true });
    });

    it("refuses a refresh over a played-once quest, and such a quest in a refreshing category", async () => {
      const event = await newEvent();
      const plain = await newCategory(event);
      expect((await newQuest(event, plain, "vote")).statusCode).toBe(201);
      const refused = await dashboard("PATCH", `/events/${event}/categories/${plain}`, {
        refresh: "daily",
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "invalid_category",
        details: { field: "refresh" },
      });
      const daily = await newCategory(event, { refresh: "daily" });
      const vote = await newQuest(event, daily, "vote");
      expect(vote.statusCode).toBe(422);
      expect(vote.json()).toMatchObject({
        code: "invalid_quest",
        details: { field: "refresh" },
      });
      expect((await newQuest(event, daily)).statusCode).toBe(201);
    });

    it("lists a secret code per hidden category and makes one new on its own", async () => {
      const event = await newEvent();
      const secret = await newCategory(event, { hidden: true });
      const open = await newCategory(event);
      const [listed] = await secretsOf(event);
      expect(await secretsOf(event)).toHaveLength(1);
      expect(listed).toMatchObject({ categoryId: secret, version: 1 });
      expect(tokenOf(listed?.url ?? "")).toBe(revealCode(REVEAL_KEY, secret, 1));
      const fresh = await dashboard(
        "POST",
        `/events/${event}/categories/${secret}/reveal/regenerate`,
      );
      expect(fresh.json()).toMatchObject({ version: 2 });
      expect(
        (await dashboard("POST", `/events/${event}/categories/${open}/reveal/regenerate`))
          .statusCode,
      ).toBe(404);
      await goLive(event);
      const token = await newPlayer(event);
      const old = await reveal(token, secret, tokenOf(listed?.url ?? ""));
      expect([old.statusCode, old.json().code]).toEqual([422, "invalid_code"]);
      const now = await reveal(token, secret, tokenOf(fresh.json<{ url: string }>().url));
      expect(now.statusCode).toBe(200);
    });
  });

  describe("the reveal route", () => {
    it("shows a hidden category to the finder, once", async () => {
      const event = await newEvent();
      const secret = await newCategory(event, { hidden: true });
      expect((await newQuest(event, secret)).statusCode).toBe(201);
      await goLive(event);
      const token = await newPlayer(event);
      const ids = async () =>
        (await questsRead(token, event))
          .json<{ categories: { id: string }[] }>()
          .categories.map((category) => category.id);
      expect(await ids()).not.toContain(secret);
      const code = revealCode(REVEAL_KEY, secret, 1);
      const found = await reveal(token, secret, code);
      expect(found.statusCode).toBe(200);
      expect(found.json()).toEqual({
        categoryId: secret,
        name: { ar: null, en: expect.stringMatching(/^Chapter/) },
        revealed: true,
      });
      expect(await ids()).toContain(secret);
      expect((await reveal(token, secret, code)).json()).toMatchObject({ revealed: false });
    });

    it("checks the code before anything else: a wrong category's code never answers 404", async () => {
      const event = await newEvent();
      const secret = await newCategory(event, { hidden: true });
      const open = await newCategory(event);
      await goLive(event);
      const token = await newPlayer(event);
      const answer = async (categoryId: string, code: string) => {
        const response = await reveal(token, categoryId, code);
        return [response.statusCode, response.json().code];
      };
      const nowhere = randomUUID();
      expect(await answer(nowhere, revealCode(REVEAL_KEY, secret, 1))).toEqual([
        422,
        "invalid_code",
      ]);
      expect(
        await answer(secret, revealCode(createRevealCodeKey("r".repeat(40)), secret, 1)),
      ).toEqual([422, "invalid_code"]);
      expect(await answer(secret, "not-a-code")).toEqual([422, "invalid_code"]);
      const wrong = await reveal(token, secret, "not-a-code");
      expect(wrong.json().message).toEqual({
        ar: "هذا الرمز لا يكشف هذه الفئة.",
        en: "This code does not open this category.",
      });
      expect(await answer(nowhere, revealCode(REVEAL_KEY, nowhere, 1))).toEqual([404, "not_found"]);
      expect(await answer(open, revealCode(REVEAL_KEY, open, 1))).toEqual([422, "not_hidden"]);
      const logged = await owner("SELECT 1 FROM category_reveal WHERE category_id = $1", [secret]);
      expect(logged).toEqual([]);
    });

    it("refuses an event not live, a bad body and no session", async () => {
      const event = await newEvent();
      const secret = await newCategory(event, { hidden: true });
      const token = await newPlayer(event);
      const early = await reveal(token, secret, revealCode(REVEAL_KEY, secret, 1));
      expect([early.statusCode, early.json()]).toEqual([
        403,
        expect.objectContaining({ code: "quest_not_open", details: { reason: "event_not_live" } }),
      ]);
      const empty = await test.app.inject({
        method: "POST",
        url: `/v1/categories/${secret}/reveal`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(empty.statusCode).toBe(400);
      const stranger = await test.app.inject({
        method: "POST",
        url: `/v1/categories/${secret}/reveal`,
        payload: { code: revealCode(REVEAL_KEY, secret, 1) },
      });
      expect(stranger.statusCode).toBe(401);
    });
  });

  describe("what it logs (never the token)", () => {
    let pool: Pool;
    beforeAll(() => {
      pool = new Pool({ connectionString: db.appUrl, max: 2 });
    });
    afterAll(() => pool.end());

    const logsOf = async (playerId: string, categoryId: string, code: string) => {
      const logged: { event: string; fields: Record<string, unknown> }[] = [];
      const caller: Caller = {
        address: "127.0.0.1",
        userAgent: null,
        log: (event, fields) => logged.push({ event, fields: { ...fields } }),
      };
      const result = await revealCategory(
        { pool, revealKey: REVEAL_KEY },
        { playerId, categoryId, code },
        caller,
      );
      return { kind: result.kind, logged };
    };
    const refusal = async (player: string, categoryId: string, token: string) => {
      const { logged } = await logsOf(player, categoryId, token);
      expect(JSON.stringify(logged)).not.toContain(token);
      return logged;
    };

    it("logs a find, and whether it was the first", async () => {
      const event = await newEvent();
      const secret = await newCategory(event, { hidden: true });
      await goLive(event);
      const player = await enrolled(event);
      const code = revealCode(REVEAL_KEY, secret, 1);
      const first = await logsOf(player, secret, code);
      expect(first).toEqual({
        kind: "done",
        logged: [{ event: "category.revealed", fields: { categoryId: secret, revealed: "true" } }],
      });
      expect((await logsOf(player, secret, code)).logged).toEqual([
        { event: "category.revealed", fields: { categoryId: secret, revealed: "false" } },
      ]);
    });

    it("logs each refusal with its reason", async () => {
      const event = await newEvent();
      const secret = await newCategory(event, { hidden: true });
      const open = await newCategory(event);
      const active = await enrolled(event);
      const banned = await enrolled(event, "banned");
      const code = revealCode(REVEAL_KEY, secret, 1);
      expect(await refusal(active, open, code)).toEqual(
        refusedLog(open, "invalid_code", "wrong_category"),
      );
      expect(await refusal(active, secret, code)).toEqual(
        refusedLog(secret, "quest_not_open", "event_not_live"),
      );
      expect(await refusal(banned, secret, code)).toEqual(
        refusedLog(secret, "enrollment_inactive", "banned"),
      );
      await goLive(event);
      expect(await refusal(active, secret, revealCode(REVEAL_KEY, secret, 2))).toEqual(
        refusedLog(secret, "invalid_code", "old"),
      );
      expect(await refusal(active, open, revealCode(REVEAL_KEY, open, 1))).toEqual(
        refusedLog(open, "not_hidden", "not_hidden"),
      );
      const nowhere = randomUUID();
      expect(await refusal(active, nowhere, revealCode(REVEAL_KEY, nowhere, 1))).toEqual(
        refusedLog(nowhere, "not_found", "not_found"),
      );
    });
  });

  describe("the quests read", () => {
    it("answers each category's refresh and next reset", async () => {
      const event = await newEvent();
      const daily = await newCategory(event, { refresh: "daily" });
      expect((await newQuest(event, daily)).statusCode).toBe(201);
      expect((await newQuest(event, await newCategory(event))).statusCode).toBe(201);
      await goLive(event);
      const token = await newPlayer(event);
      const categories = (await questsRead(token, event)).json<{
        categories: { id: string; refresh: string; resetsAt: string | null }[];
      }>().categories;
      const [expected] = await owner<{ at: Date }>(
        "SELECT event_day_start(e, event_day(now(), e) + 1) AS at FROM event e WHERE e.id = $1",
        [event],
      );
      expect(categories.find((category) => category.id === daily)).toMatchObject({
        refresh: "daily",
        resetsAt: expected?.at.toISOString(),
      });
      expect(categories.find((category) => category.id !== daily)).toMatchObject({
        refresh: "none",
        resetsAt: null,
      });
    });
  });
});
