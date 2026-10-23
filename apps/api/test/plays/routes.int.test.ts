import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RankingStore } from "#src/ranking/store";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Upsert = Readonly<{ event: string; score: bigint }>;

/** A ranking copy that only records what is written to it. */
const recordingStore = (upserts: Upsert[]): RankingStore => ({
  upsert: async (event, entry) => {
    upserts.push({ event, score: entry.score });
  },
  remove: async () => undefined,
  read: async () => ({ top: [], total: 1, place: 1 }),
  rebuild: async () => "rebuilt",
  builtAt: async () => undefined,
});

const en = (text: string) => ({ en: text });
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const VOTE = {
  options: [
    { id: "a", text: en("Robots") },
    { id: "b", text: en("Space") },
  ],
};
const QUIZ = {
  questions: ["q1", "q2"].map((id) => ({
    id,
    text: en(`Question ${id}`),
    choices: [
      { id: "r", text: en("Right") },
      { id: "w", text: en("Wrong") },
    ],
    right: "r",
  })),
  timerSeconds: 30,
};

/**
 * Votes and quizzes over HTTP (T-302): the vote and its counts, the quiz's steps and their answers, each refusal's
 * answer, the ranking after a payment, and the builder's types and lock.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("votes and quizzes over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;
  const upserts: Upsert[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, false, {}, { rankingStore: recordingStore(upserts) });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('play-org', 'play-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@play.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@play.test");
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
       VALUES ($1, $2, 'Play Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `PLAY${counter}`],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, type: "vote" | "quiz", config: object) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, $2, 'Play', 10, $3 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, type, JSON.stringify(config)],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`play_http_${counter}`],
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
  const app = (
    method: "GET" | "POST",
    path: string,
    token: string,
    payload?: object,
    key: string = randomUUID(),
  ) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST" | "PATCH", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  it("votes once, replays the key, counts for the team, and moves the ranking", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, "vote", VOTE);
    const token = await newPlayer(event);
    const options = await app("GET", `/v1/quests/${quest}/vote`, token);
    expect(options.json()).toEqual({
      options: [
        { id: "a", text: { ar: null, en: "Robots" } },
        { id: "b", text: { ar: null, en: "Space" } },
      ],
      mine: null,
    });
    const key = randomUUID();
    const voted = await app("POST", `/v1/quests/${quest}/vote`, token, { optionId: "b" }, key);
    expect(voted.statusCode).toBe(201);
    expect(voted.json()).toMatchObject({ points: 10, score: 10, replayed: false, rank: 1 });
    expect(
      (await app("POST", `/v1/quests/${quest}/vote`, token, { optionId: "b" }, key)).json(),
    ).toEqual(voted.json());
    expect(codeOf(await app("POST", `/v1/quests/${quest}/vote`, token, { optionId: "a" }))).toEqual(
      [409, "already_voted"],
    );
    expect((await app("GET", `/v1/quests/${quest}/vote`, token)).json().mine).toBe("b");
    expect(upserts.filter((write) => write.event === event)).toEqual([{ event, score: 10n }]);
    const counts = await dashboard("GET", `/events/${event}/quests/${quest}/votes`);
    expect(counts.json()).toEqual({
      options: [
        { id: "a", text: { ar: null, en: "Robots" }, votes: 0 },
        { id: "b", text: { ar: null, en: "Space" }, votes: 1 },
      ],
      total: 1,
    });
  });

  it("answers each refusal of a vote", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, "vote", VOTE);
    const quiz = await newQuest(event, "quiz", QUIZ);
    const token = await newPlayer(event);
    expect(codeOf(await app("POST", `/v1/quests/${quest}/vote`, token, { optionId: "z" }))).toEqual(
      [422, "unknown_option"],
    );
    expect(codeOf(await app("POST", `/v1/quests/${quiz}/vote`, token, { optionId: "a" }))).toEqual([
      422,
      "not_vote_quest",
    ]);
    expect(codeOf(await app("GET", `/v1/quests/${quiz}/vote`, token))).toEqual([404, "not_found"]);
    expect(codeOf(await dashboard("GET", `/events/${event}/quests/${quiz}/votes`))).toEqual([
      404,
      "not_found",
    ]);
    await owner("UPDATE quest SET closes_at = now() - interval '1 minute' WHERE id = $1", [quest]);
    const closed = await app("POST", `/v1/quests/${quest}/vote`, token, { optionId: "a" });
    expect([...codeOf(closed), closed.json().details]).toEqual([
      403,
      "quest_not_open",
      { reason: "ended" },
    ]);
  });

  it("plays a quiz step by step and pays at the end, once", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, "quiz", QUIZ);
    const token = await newPlayer(event);
    expect((await app("GET", `/v1/quests/${quest}/quiz`, token)).json()).toMatchObject({
      status: "none",
      total: 2,
      pointsEach: 10,
      timerSeconds: 30,
      current: null,
    });
    expect(codeOf(await app("POST", `/v1/quests/${quest}/quiz/next`, token, {}))).toEqual([
      404,
      "quiz_not_started",
    ]);
    expect((await app("POST", `/v1/quests/${quest}/quiz/start`, token, {})).json()).toMatchObject({
      quiz: { status: "open", current: null },
      levelUp: null,
      rank: null,
    });
    const served = await app("POST", `/v1/quests/${quest}/quiz/next`, token, {});
    expect(served.json().quiz.current).toMatchObject({
      position: 1,
      id: "q1",
      closesAt: expect.any(String),
    });
    expect(served.body).not.toMatch(/"right"|rightChoiceId/);
    expect(
      codeOf(
        await app("POST", `/v1/quests/${quest}/quiz/answer`, token, {
          questionId: "q2",
          choiceId: "r",
        }),
      ),
    ).toEqual([409, "question_not_served"]);
    const first = await app("POST", `/v1/quests/${quest}/quiz/answer`, token, {
      questionId: "q1",
      choiceId: "w",
    });
    expect(first.json().result).toEqual({ right: false, rightChoiceId: "r", replayed: false });
    expect(
      codeOf(
        await app("POST", `/v1/quests/${quest}/quiz/answer`, token, {
          questionId: "q1",
          choiceId: "r",
        }),
      ),
    ).toEqual([409, "already_answered"]);
    await app("POST", `/v1/quests/${quest}/quiz/next`, token, {});
    const last = { questionId: "q2", choiceId: "r" };
    const key = randomUUID();
    const finished = await app("POST", `/v1/quests/${quest}/quiz/answer`, token, last, key);
    expect(finished.json()).toMatchObject({
      quiz: { status: "finished", rightCount: 1, earned: 10, completionId: expect.any(String) },
      result: { right: true, rightChoiceId: "r" },
      rank: 1,
    });
    const again = await app("POST", `/v1/quests/${quest}/quiz/answer`, token, last);
    expect(again.json()).toMatchObject({
      quiz: { completionId: finished.json().quiz.completionId, earned: 10 },
      result: { replayed: true },
      rank: null,
    });
    expect((await app("POST", `/v1/quests/${quest}/quiz/next`, token, {})).json()).toMatchObject({
      quiz: { status: "finished" },
      rank: null,
    });
    expect(upserts.filter((write) => write.event === event)).toEqual([{ event, score: 10n }]);
  });

  it("answers a quiz step on another type, and a closed question", async () => {
    const event = await newEvent();
    const vote = await newQuest(event, "vote", VOTE);
    const quest = await newQuest(event, "quiz", { ...QUIZ, timerSeconds: 5 });
    const token = await newPlayer(event);
    expect(codeOf(await app("POST", `/v1/quests/${vote}/quiz/start`, token, {}))).toEqual([
      422,
      "not_quiz_quest",
    ]);
    for (const step of ["start", "next"]) {
      expect(
        codeOf(await app("POST", `/v1/quests/${quest}/quiz/${step}`, token, { extra: 1 })),
      ).toEqual([400, "invalid_request"]);
    }
    await app("POST", `/v1/quests/${quest}/quiz/start`, token, {});
    await app("POST", `/v1/quests/${quest}/quiz/next`, token, {});
    await owner("UPDATE quiz_answer SET served_at = now() - interval '1 minute'");
    expect(
      codeOf(
        await app("POST", `/v1/quests/${quest}/quiz/answer`, token, {
          questionId: "q1",
          choiceId: "r",
        }),
      ),
    ).toEqual([409, "question_closed"]);
    const seen = await app("GET", `/v1/quests/${quest}/quiz`, token);
    expect(seen.json().answered).toEqual([
      expect.objectContaining({ id: "q1", closed: true, rightChoiceId: "r", choiceId: null }),
    ]);
  });

  it("moves the ranking when the step that closes the last question pays, and only then", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, "quiz", { ...QUIZ, timerSeconds: 5 });
    const token = await newPlayer(event);
    await app("POST", `/v1/quests/${quest}/quiz/start`, token, {});
    await app("POST", `/v1/quests/${quest}/quiz/next`, token, {});
    await app("POST", `/v1/quests/${quest}/quiz/answer`, token, {
      questionId: "q1",
      choiceId: "r",
    });
    await app("POST", `/v1/quests/${quest}/quiz/next`, token, {});
    await owner(
      `UPDATE quiz_answer a SET served_at = now() - interval '1 minute'
       FROM quiz_attempt t WHERE t.id = a.attempt_id AND t.quest_id = $1 AND a.position = 2`,
      [quest],
    );
    const paid = await app("POST", `/v1/quests/${quest}/quiz/next`, token, {});
    expect(paid.json()).toMatchObject({ quiz: { status: "finished", earned: 10 }, rank: 1 });
    expect(paid.json()).not.toHaveProperty("paid");
    const later = await app("POST", `/v1/quests/${quest}/quiz/start`, token, {});
    expect(later.json()).toMatchObject({ quiz: { status: "finished" }, rank: null });
    expect(upserts.filter((write) => write.event === event)).toEqual([{ event, score: 10n }]);
  });

  it("locks an in-order quest, and pays and shows the bonus of a quiz finished with no right answers (T-304)", async () => {
    const event = await newEvent();
    const first = await newQuest(event, "vote", VOTE);
    const last = await newQuest(event, "quiz", { ...QUIZ, questions: QUIZ.questions.slice(0, 1) });
    await owner(
      "UPDATE category SET order_mode = 'in_order', completion_bonus = 30 WHERE event_id = $1",
      [event],
    );
    await owner("UPDATE quest SET position = 1 WHERE id = $1", [last]);
    const token = await newPlayer(event);
    const read = async () =>
      (await app("GET", `/v1/events/${event}/quests`, token)).json<{
        categories: Record<string, unknown>[];
      }>().categories[0];
    expect(await read()).toMatchObject({
      orderMode: "in_order",
      bonus: { points: 30, earned: 0, settled: false },
      quests: [
        { id: first, state: "open", lock: null },
        { id: last, state: "locked", lock: "order_locked" },
      ],
    });
    const locked = await app("POST", `/v1/quests/${last}/quiz/start`, token, {});
    expect([...codeOf(locked), locked.json().details]).toEqual([
      403,
      "quest_not_open",
      { reason: "order_locked" },
    ]);
    const voted = await app("POST", `/v1/quests/${first}/vote`, token, { optionId: "a" });
    expect(voted.json()).toMatchObject({ points: 10, bonus: null });
    await app("POST", `/v1/quests/${last}/quiz/start`, token, {});
    await app("POST", `/v1/quests/${last}/quiz/next`, token, {});
    const finished = await app("POST", `/v1/quests/${last}/quiz/answer`, token, {
      questionId: "q1",
      choiceId: "w",
    });
    expect(finished.json()).toMatchObject({
      quiz: { status: "finished", completionId: null },
      bonus: { points: 30, category: { ar: "عام", en: "General" } },
    });
    expect(await read()).toMatchObject({ bonus: { points: 30, earned: 30, settled: true } });
  });

  it("builds vote and quiz quests played once, and locks a played quest's answers", async () => {
    const event = await newEvent();
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [event],
    );
    const create = (type: string, config: object) =>
      dashboard("POST", `/events/${event}/quests`, {
        categoryId: category?.id,
        type,
        title: { en: "Play" },
        points: 10,
        repeatCap: 3,
        config,
      });
    expect((await create("vote", VOTE)).json().quest).toMatchObject({ type: "vote", repeatCap: 1 });
    expect(codeOf(await create("quiz", { questions: [] }))).toEqual([422, "invalid_quest"]);
    const made = await create("quiz", QUIZ);
    const id = String(made.json().quest.id);
    const token = await newPlayer(event);
    await app("POST", `/v1/quests/${id}/quiz/start`, token, {});
    const moved = { ...QUIZ, questions: QUIZ.questions.map((q) => ({ ...q, right: "w" })) };
    const locked = await dashboard("PATCH", `/events/${event}/quests/${id}`, {
      config: moved,
      confirm: true,
    });
    expect(codeOf(locked)).toEqual([409, "quest_locked"]);
    const reworded = {
      ...QUIZ,
      questions: QUIZ.questions.map((q) => ({ ...q, text: en("Better") })),
    };
    const saved = await dashboard("PATCH", `/events/${event}/quests/${id}`, {
      config: reworded,
      confirm: true,
    });
    expect(saved.statusCode).toBe(200);
  });
});
