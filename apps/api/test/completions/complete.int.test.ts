import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQuestCodeKey, questCode } from "#src/quests/qr";
import {
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const KEY = createQuestCodeKey(testConfig().qrSecret);

const scan = (quest: string, version = 1) => ({
  type: "qr",
  code: questCode(KEY, quest, version),
});

describe.skipIf(TEST_DATABASE_URL === undefined)("completing a quest (T-105)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    ids = await seedTwoTenants(db.owner);
    // The platform's location switch, on for this test's database (it is off by default, ADR-208).
    await db.owner.query(
      `INSERT INTO platform_setting (key, value) VALUES ('features', '{"locationQuests": {"enabled": true}}')`,
    );
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** A player with a live session, enrolled in organizer A's live event; returns their bearer token. */
  const newPlayer = async (
    enrollment: string | null = "active",
    session: Readonly<{ expires?: string; revoked?: boolean }> = {},
  ): Promise<{ id: string; token: string }> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`runner_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      `INSERT INTO player_session (player_id, token_hash, expires_at, revoked_at)
       VALUES ($1, $2, now() + $3::interval, ${session.revoked === true ? "now()" : "NULL"})`,
      [id, createHash("sha256").update(token).digest(), session.expires ?? "1 hour"],
    );
    if (enrollment !== null) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, $4)",
        [ids.orgA, ids.eventA, id, enrollment],
      );
    }
    return { id, token };
  };

  const newQuest = async (fields: Readonly<Record<string, unknown>> = {}): Promise<string> => {
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      ids.eventA,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       VALUES ($1, $2, $3, 'A quest', $4, $5, $6, $7) RETURNING id`,
      [
        ids.eventA,
        general?.id,
        fields["type"] ?? "scan_qr",
        fields["points"] ?? 10,
        fields["repeat_cap"] ?? 1,
        fields["visible"] ?? true,
        JSON.stringify(fields["type_config"] ?? {}),
      ],
    );
    return quest?.id ?? "";
  };

  const complete = (
    token: string | undefined,
    quest: string,
    proof: object,
    headers: Record<string, string> = {},
    app = test,
  ): Promise<LightMyRequestResponse> =>
    app.app.inject({
      method: "POST",
      url: `/v1/quests/${quest}/complete`,
      headers: {
        "idempotency-key": randomUUID(),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      payload: { proof },
    });

  describe("who may call", () => {
    it.each([
      ["no token", undefined],
      ["an unknown token", randomBytes(32).toString("base64url")],
      ["a malformed token", "not a token"],
    ])("refuses %s with 401", async (_name, token) => {
      const quest = await newQuest();
      const response = await complete(token, quest, scan(quest));
      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it.each([
      ["an expired session", { expires: "-1 second" }],
      ["a revoked session", { revoked: true }],
    ])("refuses %s with 401", async (_name, session) => {
      const { token } = await newPlayer("active", session);
      const quest = await newQuest();
      expect((await complete(token, quest, scan(quest))).statusCode).toBe(401);
    });

    it("refuses a banned player with 401, whatever their session", async () => {
      const { id, token } = await newPlayer();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [id]);
      const quest = await newQuest();
      expect((await complete(token, quest, scan(quest))).statusCode).toBe(401);
    });
  });

  describe("a scan", () => {
    it("pays the quest's points and answers the new score and balance", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest({ points: 40 });
      const response = await complete(token, quest, scan(quest));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        points: 40,
        occurrence: 1,
        score: 40,
        balance: 40,
        replayed: false,
        levelUp: null,
        bonus: null,
      });
    });

    it("answers the category bonus the last quest paid, the same on a replay (T-304)", async () => {
      const { token } = await newPlayer();
      const [group] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en, completion_bonus) VALUES ($1, 'Stage', 25) RETURNING id",
        [ids.eventA],
      );
      const quest = await newQuest({ points: 5 });
      await owner("UPDATE quest SET category_id = $2 WHERE id = $1", [quest, group?.id]);
      const key = randomUUID();
      const first = await complete(token, quest, scan(quest), { "idempotency-key": key });
      const bonus = { categoryId: group?.id, points: 25, category: { ar: null, en: "Stage" } };
      expect(first.json()).toMatchObject({ points: 5, score: 30, bonus });
      expect(
        (await complete(token, quest, scan(quest), { "idempotency-key": key })).json(),
      ).toMatchObject({ bonus });
    });

    it("answers the Questify level a completion reached first, the same on a replay, and never the XP (T-401)", async () => {
      await owner("UPDATE platform_setting SET value = '{\"questXp\": 200}' WHERE key = 'xp'");
      try {
        const { token } = await newPlayer();
        const quest = await newQuest();
        const key = randomUUID();
        const first = await complete(token, quest, scan(quest), { "idempotency-key": key });
        const levelUp = { level: 2, title: { ar: "مستكشف", en: "Explorer" } };
        expect(first.json()).toMatchObject({ levelUp, replayed: false });
        expect(first.json()).not.toHaveProperty("xp");
        expect(
          (await complete(token, quest, scan(quest), { "idempotency-key": key })).json(),
        ).toMatchObject({
          levelUp,
        });
      } finally {
        await owner("UPDATE platform_setting SET value = '{\"questXp\": 100}' WHERE key = 'xp'");
      }
    });

    it.each([
      ["a forged code", () => ({ type: "qr", code: "A".repeat(50) })],
      ["another quest's code", () => ({ type: "qr", code: questCode(KEY, randomUUID(), 1) })],
      [
        "a code from before a regenerate",
        (quest: string) => ({ type: "qr", code: questCode(KEY, quest, 2) }),
      ],
      ["a typed code on a QR quest", () => ({ type: "code", code: "ABCD" })],
      [
        "a whole URL instead of the token",
        (quest: string) => ({ type: "qr", code: `https://x/q/${questCode(KEY, quest, 1)}` }),
      ],
    ])("answers %s with one 422 that tells nothing apart", async (_name, proofFor) => {
      const { token } = await newPlayer();
      const quest = await newQuest();
      const response = await complete(token, quest, proofFor(quest));
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_code", details: {} });
    });

    it("answers a quest that is hidden, already done, or of an event the player is not in", async () => {
      const { token } = await newPlayer();
      const hidden = await newQuest({ visible: false });
      expect((await complete(token, hidden, scan(hidden))).json()).toMatchObject({
        code: "quest_not_open",
        details: { reason: "hidden" },
      });
      const once = await newQuest();
      await complete(token, once, scan(once));
      expect((await complete(token, once, scan(once))).json()).toMatchObject({
        code: "already_completed",
        details: { cap: 1 },
      });
      const { token: outsider } = await newPlayer(null);
      expect((await complete(outsider, once, scan(once))).statusCode).toBe(404);
    });

    it("refuses a player whose enrollment is not active, saying why", async () => {
      const { token } = await newPlayer("banned");
      const quest = await newQuest();
      expect((await complete(token, quest, scan(quest))).json()).toMatchObject({
        code: "enrollment_inactive",
        details: { reason: "banned" },
      });
    });

    it("records a well-formed device id and ignores any other", async () => {
      const { token } = await newPlayer();
      const device = randomUUID();
      for (const [header, expected] of [
        [device, device],
        ["not-a-device", null],
      ] as const) {
        const quest = await newQuest();
        const response = await complete(token, quest, scan(quest), { "x-device-id": header });
        const [row] = await owner<{ device_id: string | null }>(
          "SELECT device_id FROM quest_completion WHERE id = $1",
          [response.json<{ completionId: string }>().completionId],
        );
        expect(row?.device_id).toBe(expected);
      }
    });
  });

  describe("a retry", () => {
    it("with the same key returns the first answer, from memory and from the database", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest({ points: 15 });
      const headers = { "idempotency-key": "tap-1" };
      const first = await complete(token, quest, scan(quest), headers);
      const again = await complete(token, quest, scan(quest), headers);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.json()).toEqual(first.json());
      // A second server has no memory of it: the database answers the same completion, marked replayed.
      const other = await startApp(db);
      try {
        const fromDatabase = await complete(token, quest, scan(quest), headers, other);
        expect(fromDatabase.json()).toEqual({ ...first.json<object>(), replayed: true });
        const reused = await complete(token, await newQuest(), scan(quest), headers, other);
        expect(reused.json()).toMatchObject({ code: "idempotency_key_reused" });
      } finally {
        await other.close();
      }
      // A third server has no memory of the key at all: the database itself refuses it on another quest.
      const third = await startApp(db);
      try {
        const another = await newQuest();
        const reused = await complete(token, another, scan(another), headers, third);
        expect([reused.statusCode, reused.json().code]).toEqual([422, "idempotency_key_reused"]);
      } finally {
        await third.close();
      }
      const [count] = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM quest_completion WHERE quest_id = $1",
        [quest],
      );
      expect(count?.n).toBe(1);
    });
  });

  describe("an entry code (FR-211, FR-322)", () => {
    it("takes the code typed with Arabic digits, spaces and small letters", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest({ type: "enter_code", type_config: { code: "NAJD2030" } });
      const response = await complete(token, quest, { type: "code", code: " najd٢٠٣٠ " });
      expect(response.statusCode).toBe(200);
    });

    it("stops a player after 5 wrong codes on a quest, saying when to try again, and right codes never count", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest({
        type: "enter_code",
        type_config: { code: "NAJD2030" },
        repeat_cap: 10,
      });
      for (let n = 0; n < 3; n += 1) {
        expect((await complete(token, quest, { type: "code", code: "NAJD2030" })).statusCode).toBe(
          200,
        );
      }
      for (let n = 0; n < 5; n += 1) {
        expect((await complete(token, quest, { type: "code", code: `WRONG${n}` })).statusCode).toBe(
          422,
        );
      }
      const stopped = await complete(token, quest, { type: "code", code: "NAJD2030" });
      expect(stopped.statusCode).toBe(429);
      expect(Number(stopped.headers["retry-after"])).toBeGreaterThan(0);
      expect(stopped.json()).toMatchObject({
        code: "too_many_attempts",
        details: { retryAfterSeconds: Number(stopped.headers["retry-after"]) },
      });
    });

    it("gives an attempt back when the database fails, so a right code is never locked out by retries", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest({ type: "enter_code", type_config: { code: "NAJD2030" } });
      // Five calls that fail inside the database (the engine function is renamed for a moment, in this test's own
      // database).
      await owner(
        "ALTER FUNCTION complete_quest(uuid, text, integer, text, text, uuid, jsonb) RENAME TO complete_quest_away",
      );
      try {
        for (let n = 0; n < 5; n += 1) {
          expect(
            (await complete(token, quest, { type: "code", code: "NAJD2030" })).statusCode,
          ).toBe(500);
        }
      } finally {
        await owner(
          "ALTER FUNCTION complete_quest_away(uuid, text, integer, text, text, uuid, jsonb) RENAME TO complete_quest",
        );
      }
      expect((await complete(token, quest, { type: "code", code: "NAJD2030" })).statusCode).toBe(
        200,
      );
    });

    it("counts a burst of parallel guesses exactly: never more than the limit gets through", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest({ type: "enter_code", type_config: { code: "NAJD2030" } });
      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          complete(token, quest, { type: "code", code: `GUESS${n}` }),
        ),
      );
      const checked = answers.filter((response) => response.statusCode === 422);
      expect(checked.length).toBeLessThanOrEqual(5);
      expect(answers.every((response) => [422, 429].includes(response.statusCode))).toBe(true);
    });
  });

  describe("the builder after completions", () => {
    it("keeps a completed quest and its category, saying to hide it instead", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest();
      await complete(token, quest, scan(quest));
      const email = `owner${counter}@complete.test`;
      const staff = await createStaff(db.owner, { email });
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [ids.orgA, staff],
      );
      const cookie = await signInFully(test, email);
      const base = `/v1/organizers/${ids.orgA}/events/${ids.eventA}`;
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        ids.eventA,
      ]);
      await test.app.inject({
        method: "POST",
        url: `${base}/categories`,
        headers: withSession(cookie, { "idempotency-key": randomUUID() }),
        payload: { name: { en: "Spare" }, confirm: true },
      });
      for (const [url, payload] of [
        [`${base}/quests/${quest}`, { confirm: true }],
        [`${base}/categories/${general?.id}`, { quests: "delete", confirm: true }],
      ] as const) {
        const response = await test.app.inject({
          method: "DELETE",
          url,
          headers: withSession(cookie),
          payload,
        });
        // A played quest's delete asks keep or remove (T-604); its category stays.
        expect(response.json(), url).toMatchObject({
          code: url.includes("/quests/") ? "points_choice_required" : "has_completions",
        });
      }
    });
  });

  const kept = (quest: string) =>
    owner(
      `SELECT p.accuracy_m FROM completion_position p JOIN quest_completion c ON c.id = p.completion_id
       WHERE c.quest_id = $1`,
      [quest],
    );

  describe("location check-ins and positions (T-303b)", () => {
    const SPOT = { lat: 24.7136, lng: 46.6753 };
    const at = (metres: number, extra: object = {}) => ({
      lat: SPOT.lat + metres / 111_195,
      lng: SPOT.lng,
      accuracyM: 10,
      ageS: 3,
      ...extra,
    });
    const newSpot = async () => {
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        ids.eventA,
      ]);
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, place_lat, place_lng,
                            place_radius_m)
         VALUES ($1, $2, 'location', 'Spot', 10, 5, $3, $4, 50) RETURNING id`,
        [ids.eventA, general?.id, SPOT.lat, SPOT.lng],
      );
      return quest?.id ?? "";
    };
    it("pays a check-in inside the area, and completes the same quest by its QR", async () => {
      const { token } = await newPlayer();
      const quest = await newSpot();
      const checked = await complete(token, quest, { type: "location", position: at(10) });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ points: 10, replayed: false });
      expect((await complete(token, quest, scan(quest))).statusCode).toBe(200);
      expect(await kept(quest)).toEqual([{ accuracy_m: 10 }]);
    });

    it("answers location_refused with the reason and the player's own rounded distance", async () => {
      const { token } = await newPlayer();
      const quest = await newSpot();
      const far = await complete(token, quest, { type: "location", position: at(143) });
      expect(far.statusCode).toBe(422);
      expect(far.json()).toMatchObject({
        code: "location_refused",
        details: { reason: "not_here", distanceM: 140 },
      });
      for (const [position, reason] of [
        [undefined, "no_position"],
        [null, "no_position"],
        [at(0, { ageS: 300 }), "stale"],
        [at(0, { accuracyM: 900 }), "imprecise"],
      ] as const) {
        const response = await complete(token, quest, { type: "location", position });
        expect(response.json(), reason).toMatchObject({
          code: "location_refused",
          details: { reason },
        });
        expect(response.json().details).not.toHaveProperty("distanceM");
      }
    });

    it("refuses a malformed check-in position without echoing it, and drops a scan's bad one", async () => {
      const { token } = await newPlayer();
      const quest = await newSpot();
      for (const position of [
        at(0, { lat: 95.123456 }),
        at(0, { extra: 31.987654 }),
        "24.713600,46.675300",
      ]) {
        const response = await complete(token, quest, { type: "location", position });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: "location_refused",
          details: { reason: "bad_position" },
        });
        expect(response.body).not.toMatch(/95\.12|31\.98|24\.71|46\.67|lat|lng/);
      }
      const paid = await complete(token, quest, { ...scan(quest), position: at(0, { lat: 95 }) });
      expect(paid.statusCode).toBe(200);
      const code = await newQuest({ type: "enter_code", type_config: { code: "OASIS7" } });
      const typed = await complete(token, code, {
        type: "code",
        code: "OASIS7",
        position: { lat: "x" },
      });
      expect(typed.statusCode).toBe(200);
      expect(await kept(quest)).toEqual([]);
    });

    it("answers feature_off for a check-in while the platform's location switch is off (ADR-208)", async () => {
      const { token } = await newPlayer();
      const quest = await newSpot();
      await owner(`UPDATE platform_setting SET value = '{}' WHERE key = 'features'`);
      const off = await startApp(db);
      try {
        const response = await complete(
          token,
          quest,
          { type: "location", position: at(0) },
          {},
          off,
        );
        expect([response.statusCode, response.json().code]).toEqual([403, "feature_off"]);
      } finally {
        await off.close();
        await owner(
          `UPDATE platform_setting SET value = '{"locationQuests": {"enabled": true}}' WHERE key = 'features'`,
        );
      }
    });

    it("refuses a check-in on a quest that is not a location quest as an invalid code", async () => {
      const { token } = await newPlayer();
      const quest = await newQuest();
      const response = await complete(token, quest, { type: "location", position: at(0) });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_code" });
    });
  });
});
