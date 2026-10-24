import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loggerOptions } from "#src/app";
import { createMyCodeKey, myCode } from "#src/quests/qr";
import type { RankingStore } from "#src/ranking/store";
import { startApp, testConfig, type TestApp } from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/** The test config's QR secret (test/support/auth-app.ts), so a test can show a real My QR. */
const MY_KEY = createMyCodeKey("q".repeat(40));

/** A ranking store that only counts its calls: a practice scan must never reach it (the route wall). */
function spyStore() {
  const calls: string[] = [];
  const store: RankingStore = {
    upsert: async () => {
      calls.push("upsert");
    },
    remove: async () => {
      calls.push("remove");
    },
    read: async () => {
      calls.push("read");
      return undefined;
    },
    rebuild: async () => {
      calls.push("rebuild");
      return "rebuilt";
    },
    builtAt: async () => {
      calls.push("builtAt");
      return undefined;
    },
  };
  return { store, calls };
}

/**
 * Practice scans and My station today over HTTP (T-311): the practice route answers like the real one with
 * `practice: true`, takes no Idempotency-Key, moves no score and no place; the station's counts with their refusals
 * and their rate limit; the log line holds no player.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("operator tools over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let spy: ReturnType<typeof spyStore>;
  let organizer: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    spy = spyStore();
    test = await startApp(db, false, {}, { rankingStore: spy.store });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('tools-org', 'tools-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
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
       VALUES ($1, $2, 'Tools Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `TLS${counter}`],
    );
    return event?.id ?? "";
  };

  const newQuest = async (event: string) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, verification)
         SELECT $1, id, 'scan_qr', 'Gate', 25, '{my_qr}' FROM category WHERE event_id = $1 RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";

  /** A signed-in player; enrolled in the event when one is given. */
  const newPlayer = async (event?: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`tools_${counter}`],
    );
    const id = player?.id ?? "";
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [id, createHash("sha256").update(token).digest()],
    );
    if (event !== undefined) {
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [organizer, event, id],
      );
    }
    return { id, token };
  };

  const newOperator = async (event: string, quests: string[] = []) => {
    const person = await newPlayer();
    const [assignment] = await owner<{ id: string }>(
      `INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities)
       VALUES ($1, $2, $3, '{scan_quests}') RETURNING id`,
      [organizer, event, person.id],
    );
    for (const quest of quests) {
      await owner(
        "INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES ($1, $2, $3)",
        [assignment?.id, event, quest],
      );
    }
    return person;
  };

  const call = (
    method: "GET" | "POST",
    url: string,
    token: string,
    fields: Readonly<{ payload?: object; key?: string; app?: TestApp }> = {},
  ) =>
    (fields.app ?? test).app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(fields.key === undefined ? {} : { "idempotency-key": fields.key }),
      },
      ...(fields.payload === undefined ? {} : { payload: fields.payload }),
    });

  const scoreOf = async (event: string, player: string) =>
    (
      await owner<{ score: string }>(
        "SELECT score FROM enrollment WHERE event_id = $1 AND player_id = $2",
        [event, player],
      )
    )[0]?.score;

  describe("POST /v1/operator/scan/practice", () => {
    it("answers green with practice: true and no key, pays nothing and moves no place; the real scan does", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const player = await newPlayer(event);
      const code = myCode(MY_KEY, player.id, 1);
      spy.calls.length = 0;
      const practised = await call("POST", "/v1/operator/scan/practice", operator.token, {
        payload: { questId: quest, code },
      });
      expect(practised.statusCode).toBe(200);
      expect(practised.json()).toEqual({
        result: "completed",
        player: { username: expect.stringMatching(/^tools_/), avatar: "falcon" },
        points: 25,
        occurrence: 1,
        practice: true,
      });
      expect(await scoreOf(event, player.id)).toBe("0");
      expect(spy.calls).toEqual([]);
      const realScan = await call("POST", "/v1/operator/scan", operator.token, {
        payload: { questId: quest, code },
        key: randomUUID(),
      });
      expect(realScan.json()).toMatchObject({ result: "completed", points: 25 });
      expect(await scoreOf(event, player.id)).toBe("25");
      expect(spy.calls).toContain("upsert");
      const orange = await call("POST", "/v1/operator/scan/practice", operator.token, {
        payload: { questId: quest, code },
      });
      expect(orange.json()).toEqual({
        result: "already_completed",
        player: expect.objectContaining({ avatar: "falcon" }),
        practice: true,
      });
    });

    it("answers red with the real reasons, 403 for a non-operator, 400 for a bad body", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const stranger = await newPlayer();
      const practise = (code: string, token = operator.token) =>
        call("POST", "/v1/operator/scan/practice", token, { payload: { questId: quest, code } });
      expect((await practise("not a code")).json()).toEqual({
        result: "refused",
        reason: "invalid_code",
        player: null,
        practice: true,
      });
      expect((await practise(myCode(MY_KEY, stranger.id, 1))).json()).toEqual({
        result: "refused",
        reason: "not_in_event",
        player: null,
        practice: true,
      });
      const removed = await practise(myCode(MY_KEY, stranger.id, 1), stranger.token);
      expect(removed.statusCode).toBe(403);
      expect(removed.json()).toMatchObject({ code: "not_operator" });
      const bad = await call("POST", "/v1/operator/scan/practice", operator.token, {
        payload: { questId: quest, code: "x", practice: false },
      });
      expect(bad.statusCode).toBe(400);
    });

    it("logs the practice scan by quest and result, never the player or the code", async () => {
      const lines: string[] = [];
      const logged = await startApp(db, {
        ...loggerOptions(testConfig()),
        level: "debug",
        stream: { write: (line: string) => void lines.push(line) },
      });
      try {
        const event = await newEvent();
        const quest = await newQuest(event);
        const operator = await newOperator(event);
        const player = await newPlayer(event);
        const code = myCode(MY_KEY, player.id, 1);
        const answer = await call("POST", "/v1/operator/scan/practice", operator.token, {
          payload: { questId: quest, code },
          app: logged,
        });
        expect(answer.statusCode).toBe(200);
        const text = lines.join("\n");
        expect(text).toContain("operator.practice_scan");
        for (const secret of [player.id, code]) {
          expect(text).not.toContain(secret);
        }
      } finally {
        await logged.close();
      }
    });
  });

  describe("GET /v1/operator/events/:eventId/stations/:questId/today", () => {
    it("answers the counts, and 403 or 404 for what the operator may not read", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const other = await newQuest(event);
      const operator = await newOperator(event);
      const limited = await newOperator(event, [other]);
      const player = await newPlayer(event);
      await call("POST", "/v1/operator/scan", operator.token, {
        payload: { questId: quest, code: myCode(MY_KEY, player.id, 1) },
        key: randomUUID(),
      });
      const path = (q: string, e = event) => `/v1/operator/events/${e}/stations/${q}/today`;
      const counts = await call("GET", path(quest), operator.token);
      expect(counts.statusCode).toBe(200);
      expect(counts.json()).toEqual({ today: 1, lastHour: 1 });
      const stranger = await newPlayer();
      expect((await call("GET", path(quest), stranger.token)).json()).toMatchObject({
        code: "not_operator",
      });
      expect((await call("GET", path(randomUUID()), operator.token)).statusCode).toBe(404);
      const outside = await call("GET", path(quest), limited.token);
      expect(outside.statusCode).toBe(403);
      expect(outside.json()).toMatchObject({ code: "outside_quests" });
      expect((await call("GET", path("nope"), operator.token)).statusCode).toBe(400);
    });

    it("answers 429 with Retry-After past 60 reads a minute", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const operator = await newOperator(event);
      const path = `/v1/operator/events/${event}/stations/${quest}/today`;
      for (let read = 0; read < 60; read += 1) {
        expect((await call("GET", path, operator.token)).statusCode).toBe(200);
      }
      const limited = await call("GET", path, operator.token);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: "too_many_attempts" });
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    });
  });
});
