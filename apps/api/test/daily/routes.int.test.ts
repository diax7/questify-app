import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  adminDailyQuestionSchema,
  dailyAnswerReplySchema,
  dailyConsoleSchema,
  dailyGuessReplySchema,
  ownDailySchema,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { dailyFixture, questionFields, type DailyFixture } from "#test/support/daily";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Method = "GET" | "POST" | "PUT" | "DELETE";
const WORDS = ["plumb", "quilt", "vexed", "wharf", "joker", "nymph", "gawky", "mirth"];

/**
 * The daily games over HTTP (T-406): the player's read and move doors with every refusal mapped by SQLSTATE and
 * DETAIL, the rate limits, the platform switches flipped through the settings service, staff kept out of player doors,
 * and the console's routes with their Idempotency-Key, refusals and admin-only access.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the daily games over HTTP", () => {
  let f: DailyFixture;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let admin: PublicAccount;
  let cookie = "";
  let staffCookie = "";

  beforeAll(async () => {
    f = await dailyFixture();
    settingsPool = new Pool({ connectionString: f.db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool, ttlMs: 0 });
    test = await startApp(f.db, false, {}, { settings });
    const adminId = await createStaff(f.db.owner, { email: "root@daily.test", admin: true });
    admin = { id: adminId, email: "root@daily.test", status: "active", platformRole: "admin" };
    cookie = await signInFully(test, "root@daily.test");
    await createStaff(f.db.owner, { email: "staff@daily.test" });
    staffCookie = await signInFully(test, "staff@daily.test");
    await f.listWords("en", ["adieu", "stomp", "light"]);
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
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
  const asPlayer = (token: string, method: Method, url: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  const consoleCall = (method: Method, url: string, payload?: object, key: string = randomUUID()) =>
    test.app.inject({
      method,
      url: `/v1/admin/daily${url}`,
      headers: withSession(cookie, { "idempotency-key": key }),
      ...(payload === undefined ? {} : { payload }),
    });
  let words = 0;
  const ready = async () => {
    const day = await f.freshSunday();
    const picked = await f.questions();
    const challenge = await f.setChallenge(day, picked, { ar: "شركة", en: "Acme" });
    words += 1;
    const word = await f.setWord("en", day, WORDS[words - 1] ?? "");
    await f.goTo(day);
    const player = await f.newPlayer();
    return { day, picked, challenge, word, player, token: await tokenOf(player) };
  };

  it("reads the caller's games, never cached, and refuses a caller with no player session", async () => {
    const { token, challenge } = await ready();
    const read = await asPlayer(token, "GET", "/v1/me/daily");
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("private, no-store");
    const daily = ownDailySchema.parse(read.json());
    expect(daily.challenge).toMatchObject({
      id: challenge.id,
      sponsor: { ar: "شركة", en: "Acme" },
    });
    expect(daily.word?.languages).toEqual(["en"]);
    expect((await test.app.inject({ method: "GET", url: "/v1/me/daily" })).statusCode).toBe(401);
    const staff = await test.app.inject({
      method: "GET",
      url: "/v1/me/daily",
      headers: withSession(staffCookie),
    });
    expect(staff.statusCode).toBe(401);
  });

  it("answers the challenge in order and maps every refusal", async () => {
    const { token, challenge, picked } = await ready();
    const send = (questionId: string | undefined, position: number, choice: number) =>
      asPlayer(token, "POST", "/v1/me/daily/challenge/answers", {
        challengeId: challenge.id,
        questionId,
        position,
        choice,
      });
    const early = await send(picked[1], 2, 2);
    expect([early.statusCode, early.json().code, early.json().details]).toEqual([
      409,
      "daily_conflict",
      { reason: "out_of_order" },
    ]);
    const stale = await send(picked[1], 1, 2);
    expect(stale.json().details).toEqual({ reason: "changed" });
    const choice = await send(picked[0], 1, 4);
    expect([choice.statusCode, choice.json().code, choice.json().details]).toEqual([
      422,
      "invalid_answer",
      { field: "choice" },
    ]);
    expect((await send(picked[0], 1, 9)).statusCode).toBe(400);
    const first = await send(picked[0], 1, 2);
    expect(first.statusCode).toBe(200);
    expect(dailyAnswerReplySchema.parse(first.json())).toMatchObject({
      answer: { position: 1, correct: true, right: 2 },
      finished: null,
      replayed: false,
    });
    expect((await send(picked[0], 1, 2)).json().replayed).toBe(true);
    expect((await send(picked[0], 1, 1)).json().details).toEqual({ reason: "answered" });
    await send(picked[1], 2, 2);
    const last = dailyAnswerReplySchema.parse((await send(picked[2], 3, 2)).json());
    expect(last.finished).toEqual({ correct: 3, xp: 50 });
    expect(last.dailyStreak).toMatchObject({ days: 1, today: true });
  });

  it("plays the word, refusing a guess that is not a word without using an attempt", async () => {
    const { token, word } = await ready();
    const send = (attempt: number, guess: string, wordId = word.id) =>
      asPlayer(token, "POST", "/v1/me/daily/word/guesses", { wordId, attempt, guess });
    const refused = await send(1, "zzzzz");
    expect([refused.statusCode, refused.json().code, refused.json().details]).toEqual([
      422,
      "invalid_guess",
      { reason: "not_a_word" },
    ]);
    expect((await send(1, "abc")).json().details).toEqual({ reason: "length" });
    const miss = dailyGuessReplySchema.parse((await send(1, "adieu")).json());
    expect(miss).toMatchObject({ guess: { attempt: 1, guess: "adieu" }, finished: null });
    expect(JSON.stringify(miss)).not.toContain(word.word);
    expect((await send(1, "stomp")).json().details).toEqual({ reason: "attempt_taken" });
    expect((await send(2, "light", word.id + 100000)).json().details).toEqual({
      reason: "changed",
    });
    const solved = dailyGuessReplySchema.parse((await send(2, word.word.toUpperCase())).json());
    expect(solved.finished).toEqual({ solved: true, attempts: 2, xp: 50, word: word.word });
    expect((await send(3, "light")).json().details).toEqual({ reason: "finished" });
  });

  it("holds each door to 30 moves a minute per player", async () => {
    const { token, challenge, picked } = await ready();
    const body = { challengeId: challenge.id, questionId: picked[0], position: 1, choice: 2 };
    for (let i = 0; i < 30; i += 1) {
      expect(
        (await asPlayer(token, "POST", "/v1/me/daily/challenge/answers", body)).statusCode,
      ).toBe(200);
    }
    const held = await asPlayer(token, "POST", "/v1/me/daily/challenge/answers", body);
    expect([held.statusCode, held.json().code]).toEqual([429, "too_many_attempts"]);
    expect(held.headers["retry-after"]).toBeDefined();
  });

  it("switches each game off for the platform through the settings, at once", async () => {
    const { token, challenge, picked, word } = await ready();
    const saved = await settings.savePlatformSettings(admin, {
      features: { dailyChallenge: { enabled: false }, dailyWord: { enabled: false } },
    });
    expect(saved).toMatchObject({ ok: true });
    try {
      const config = (await test.app.inject({ method: "GET", url: "/v1/config" })).json() as {
        features: Record<string, { enabled: boolean }>;
      };
      expect(config.features["dailyChallenge"]?.enabled).toBe(false);
      expect(config.features["dailyWord"]?.enabled).toBe(false);
      expect((await asPlayer(token, "GET", "/v1/me/daily")).json()).toEqual({
        challenge: null,
        word: null,
      });
      const answer = await asPlayer(token, "POST", "/v1/me/daily/challenge/answers", {
        challengeId: challenge.id,
        questionId: picked[0],
        position: 1,
        choice: 2,
      });
      expect([answer.statusCode, answer.json().code]).toEqual([404, "daily_unavailable"]);
      const guess = await asPlayer(token, "POST", "/v1/me/daily/word/guesses", {
        wordId: word.id,
        attempt: 1,
        guess: "adieu",
      });
      expect([guess.statusCode, guess.json().code]).toEqual([404, "daily_unavailable"]);
    } finally {
      await settings.savePlatformSettings(admin, {
        features: { dailyChallenge: { enabled: true }, dailyWord: { enabled: true } },
      });
    }
    const config = (await test.app.inject({ method: "GET", url: "/v1/config" })).json() as {
      features: Record<string, { enabled: boolean }>;
    };
    expect(config.features["dailyChallenge"]?.enabled).toBe(true);
  });

  it("runs the console: the bank, a period's challenge and word, the guess list, the cadence and the read", async () => {
    const sunday = await f.freshSunday();
    const made: string[] = [];
    for (let n = 1; n <= 4; n += 1) {
      const created = await consoleCall("POST", "/questions", questionFields(n));
      expect(created.statusCode).toBe(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      made.push(adminDailyQuestionSchema.parse(created.json().question).id);
    }
    const edited = await consoleCall("PUT", `/questions/${made[0]}`, {
      ...questionFields(1),
      answer: 3,
    });
    expect(edited.json().question).toMatchObject({ answer: 3, status: "ready" });
    const set = await consoleCall("PUT", `/challenges/${sunday}`, {
      questionIds: made.slice(0, 3),
      sponsor: { name: { ar: "شركة", en: "Acme" } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().challenge).toMatchObject({ startsOn: sunday, questions: made.slice(0, 3) });
    const used = await consoleCall("PUT", `/challenges/${await f.plus(sunday, 7)}`, {
      questionIds: [made[3], made[0], (await f.questions(1))[0]],
      sponsor: null,
    });
    expect([used.statusCode, used.json().code, used.json().details]).toEqual([
      409,
      "daily_content_conflict",
      { reason: "used", position: 2 },
    ]);
    const tuesday = await consoleCall("PUT", `/challenges/${await f.plus(sunday, 2)}`, {
      questionIds: [made[3], ...(await f.questions(2))],
      sponsor: null,
    });
    expect([tuesday.statusCode, tuesday.json().details]).toEqual([
      422,
      { field: "not_period_start" },
    ]);
    expect((await consoleCall("POST", `/questions/${made[3]}/retire`)).json().question.status).toBe(
      "retired",
    );
    const word = await consoleCall("PUT", `/words/en/${sunday}`, { word: " Crane " });
    expect(word.json().word).toMatchObject({ language: "en", startsOn: sunday, word: "crane" });
    const list = await consoleCall("POST", "/word-list/en", { add: ["zesty", "bad1"], remove: [] });
    expect(list.json()).toMatchObject({ added: 1, refused: ["bad1"] });
    const page = await consoleCall("GET", "/word-list/en?prefix=ze&page=1");
    expect(page.json()).toEqual({ words: ["zesty"], total: 1 });
    const read = dailyConsoleSchema.parse(
      (await consoleCall("GET", `?from=${sunday}&to=${sunday}`)).json(),
    );
    expect(read.periods.find((p) => p.kind === "challenge")?.challenge).toMatchObject({
      finishes: 0,
    });
    expect(read.periods.find((p) => p.kind === "word")?.words?.en).toMatchObject({ word: "crane" });
    expect((await consoleCall("GET", "?from=2026-01-01&to=2026-12-31")).json().details).toEqual({
      field: "range",
    });
    const bank = await consoleCall("GET", "/questions?status=retired&limit=5");
    expect(bank.json().questions.map((q: { id: string }) => q.id)).toEqual([made[3]]);
    expect((await consoleCall("DELETE", `/words/en/${sunday}`)).json()).toEqual({
      language: "en",
      startsOn: sunday,
      cleared: true,
    });
    expect((await consoleCall("DELETE", `/challenges/${sunday}`)).json()).toEqual({
      startsOn: sunday,
      cleared: true,
    });
    expect((await consoleCall("DELETE", `/challenges/${sunday}`)).statusCode).toBe(404);
    const cadence = await consoleCall("PUT", "/cadence", { kind: "word", cadence: "weekly" });
    expect(cadence.json()).toMatchObject({ kind: "word", cadence: "weekly", unchanged: true });
  });

  it("replays a console write by its Idempotency-Key and refuses one without", async () => {
    const key = randomUUID();
    const first = await consoleCall("POST", "/questions", questionFields(7), key);
    const again = await consoleCall("POST", "/questions", questionFields(7), key);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    const bare = await test.app.inject({
      method: "POST",
      url: "/v1/admin/daily/questions",
      headers: withSession(cookie),
      payload: questionFields(8),
    });
    expect([bare.statusCode, bare.json().code]).toEqual([400, "idempotency_key_required"]);
  });

  it("answers 404 to anyone but an active platform admin on the console routes", async () => {
    const player = await f.newPlayer();
    const token = await tokenOf(player);
    for (const [method, url] of [
      ["GET", "/v1/admin/daily?from=2026-11-01&to=2026-11-02"],
      ["POST", "/v1/admin/daily/questions"],
      ["PUT", "/v1/admin/daily/cadence"],
    ] as const) {
      const staff = await test.app.inject({
        method,
        url,
        headers: withSession(staffCookie, { "idempotency-key": randomUUID() }),
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(staff.statusCode, `${method} ${url}`).toBe(404);
      const asPlayerCall = await test.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect([401, 403, 404]).toContain(asPlayerCall.statusCode);
    }
  });
});
