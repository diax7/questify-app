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
const SURVEY = {
  questions: [
    {
      id: "fav",
      text: en("Favourite talk?"),
      kind: "choice",
      required: true,
      choices: [
        { id: "ai", text: en("AI") },
        { id: "web", text: en("Web") },
      ],
    },
    { id: "stars", text: en("How was it?"), kind: "rating", required: true },
    { id: "note", text: en("Anything else?"), kind: "text", required: false },
  ],
};
/** The quest ids of a quest list, in order. */
const ids = (body: { categories: { quests: { id: string }[] }[] }) =>
  body.categories.flatMap((category) => category.quests.map((quest) => quest.id));
const SHARE = { message: en("I am at Share Fest!"), link: "https://example.com/fest" };

/**
 * Challenge, survey and share quests over HTTP (T-303): the survey and its results, the share and its switch hiding
 * share quests from every player read, each refusal's answer, the ranking after a payment, the builder's types and the
 * station's challenge label.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("surveys, shares and challenges over HTTP", () => {
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
          "INSERT INTO organizer (name, slug) VALUES ('share-org', 'share-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@share.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@share.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  /** A live event; `shareOff` switches its share quests off before anything reads its configuration. */
  const newEvent = async (shareOff = false): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `SHAR${counter}`;
    const config = shareOff ? { features: { shareQuests: false } } : {};
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, config)
       VALUES ($1, $2, 'Share Fest', 'live', now() - interval '1 hour', now() + interval '1 day', $3) RETURNING id`,
      [organizer, code, JSON.stringify(config)],
    );
    return { id: event?.id ?? "", code };
  };
  const newQuest = async (event: string, type: string, config: object, points = 10) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         SELECT $1, id, $2, 'Play', $4, $3 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [event, type, JSON.stringify(config), points],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`share_http_${counter}`],
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
    return { token, id };
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
  const dashboard = (method: "GET" | "POST", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });

  describe("surveys", () => {
    it("reads the questions, pays one response, replays the key, and moves the ranking", async () => {
      const event = await newEvent();
      const quest = await newQuest(event.id, "survey", SURVEY, 20);
      const { token } = await newPlayer(event.id);
      const read = await app("GET", `/v1/quests/${quest}/survey`, token);
      expect(read.json()).toEqual({
        questions: [
          {
            id: "fav",
            kind: "choice",
            text: { ar: null, en: "Favourite talk?" },
            required: true,
            choices: [
              { id: "ai", text: { ar: null, en: "AI" } },
              { id: "web", text: { ar: null, en: "Web" } },
            ],
          },
          {
            id: "stars",
            kind: "rating",
            text: { ar: null, en: "How was it?" },
            required: true,
            choices: null,
          },
          {
            id: "note",
            kind: "text",
            text: { ar: null, en: "Anything else?" },
            required: false,
            choices: null,
          },
        ],
        answered: false,
      });
      const key = randomUUID();
      const answers = { fav: "ai", stars: 5, note: null };
      const paid = await app("POST", `/v1/quests/${quest}/survey`, token, { answers }, key);
      expect(paid.statusCode).toBe(201);
      expect(paid.json()).toMatchObject({ points: 20, score: 20, replayed: false, rank: 1 });
      const again = await app("POST", `/v1/quests/${quest}/survey`, token, { answers }, key);
      expect(again.json()).toEqual(paid.json());
      expect(codeOf(await app("POST", `/v1/quests/${quest}/survey`, token, { answers }))).toEqual([
        409,
        "already_completed",
      ]);
      expect((await app("GET", `/v1/quests/${quest}/survey`, token)).json().answered).toBe(true);
      expect(upserts.filter((write) => write.event === event.id)).toEqual([
        { event: event.id, score: 20n },
      ]);
    });

    it("answers each refusal, naming the question but never the answer", async () => {
      const event = await newEvent();
      const quest = await newQuest(event.id, "survey", SURVEY);
      const share = await newQuest(event.id, "share", SHARE);
      const { token } = await newPlayer(event.id);
      const bad = await app("POST", `/v1/quests/${quest}/survey`, token, {
        answers: { fav: "ai", stars: 4, note: "private‮words" },
      });
      expect(codeOf(bad)).toEqual([422, "bad_answer"]);
      expect(bad.json().details).toEqual({ question: "note" });
      expect(bad.body).not.toContain("private");
      expect(
        codeOf(
          await app("POST", `/v1/quests/${share}/survey`, token, {
            answers: { fav: "ai", stars: 4 },
          }),
        ),
      ).toEqual([422, "not_survey_quest"]);
      expect(
        codeOf(await app("POST", `/v1/quests/${quest}/survey`, token, { answers: [] })),
      ).toEqual([400, "invalid_request"]);
      expect(codeOf(await app("GET", `/v1/quests/${randomUUID()}/survey`, token))).toEqual([
        404,
        "not_found",
      ]);
    });

    it("shows the team the results with names not shown", async () => {
      const event = await newEvent();
      const quest = await newQuest(event.id, "survey", SURVEY);
      for (const answers of [
        { fav: "ai", stars: 5, note: "Loved it" },
        { fav: "web", stars: 2 },
      ]) {
        await app("POST", `/v1/quests/${quest}/survey`, (await newPlayer(event.id)).token, {
          answers,
        });
      }
      const results = await dashboard("GET", `/events/${event.id}/quests/${quest}/survey`);
      expect(results.json()).toMatchObject({
        total: 2,
        questions: [
          { id: "fav", answered: 2, choices: [{ count: 1 }, { count: 1 }] },
          { id: "stars", average: 3.5 },
          { id: "note", texts: ["Loved it"] },
        ],
      });
      expect(results.body).not.toContain("share_http");
    });
  });

  describe("shares", () => {
    it("reads the message, pays once, replays the key, and moves the ranking", async () => {
      const event = await newEvent();
      const quest = await newQuest(event.id, "share", SHARE, 5);
      const { token } = await newPlayer(event.id);
      expect((await app("GET", `/v1/quests/${quest}/share`, token)).json()).toEqual({
        message: { ar: null, en: "I am at Share Fest!" },
        link: "https://example.com/fest",
        done: false,
      });
      const key = randomUUID();
      const paid = await app("POST", `/v1/quests/${quest}/share`, token, {}, key);
      expect(paid.statusCode).toBe(201);
      expect(paid.json()).toMatchObject({ points: 5, replayed: false, rank: 1 });
      const again = await app("POST", `/v1/quests/${quest}/share`, token, {}, key);
      expect(again.json()).toEqual(paid.json());
      expect(codeOf(await app("POST", `/v1/quests/${quest}/share`, token, {}))).toEqual([
        409,
        "already_completed",
      ]);
      expect((await app("GET", `/v1/quests/${quest}/share`, token)).json().done).toBe(true);
    });

    it("hides a switched-off share quest from every player read and refuses paying it", async () => {
      const event = await newEvent(true);
      const share = await newQuest(event.id, "share", SHARE, 50);
      const survey = await newQuest(event.id, "survey", SURVEY, 10);
      await owner("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [event.id, share]);
      const { token } = await newPlayer(event.id);

      const tab = await app("GET", `/v1/events/${event.id}/quests`, token);
      expect(ids(tab.json())).toEqual([survey]);
      const home = (await app("GET", `/v1/events/${event.id}/home`, token)).json();
      expect(home.standing).toMatchObject({ questsDone: 0, questsTotal: 1 });
      expect(home.upNext).toMatchObject({ questId: survey });
      const listed = await test.app.inject({
        method: "GET",
        url: `/v1/public/events/${event.code}/quests`,
      });
      expect(ids(listed.json())).toEqual([survey]);
      expect(codeOf(await app("GET", `/v1/quests/${share}/share`, token))).toEqual([
        404,
        "not_found",
      ]);
      expect(codeOf(await app("POST", `/v1/quests/${share}/share`, token, {}))).toEqual([
        403,
        "feature_off",
      ]);
    });

    it("shows a share quest in every player read while the switch is on", async () => {
      const event = await newEvent();
      const share = await newQuest(event.id, "share", SHARE);
      const { token } = await newPlayer(event.id);
      const tab = (await app("GET", `/v1/events/${event.id}/quests`, token)).json();
      expect(tab.categories[0].quests.map((quest: { id: string }) => quest.id)).toEqual([share]);
      const home = (await app("GET", `/v1/events/${event.id}/home`, token)).json();
      expect(home.standing).toMatchObject({ questsTotal: 1 });
      const listed = await test.app.inject({
        method: "GET",
        url: `/v1/public/events/${event.code}/quests`,
      });
      expect(listed.json().categories[0].quests).toHaveLength(1);
    });
  });

  describe("challenges and the builder", () => {
    it("builds the three types, fixes a challenge's method and plays a survey or share once", async () => {
      const event = await newEvent();
      const [category] = await owner<{ id: string }>(
        "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
        [event.id],
      );
      const create = (type: string, config: object, extra: object = {}) =>
        dashboard("POST", `/events/${event.id}/quests`, {
          categoryId: category?.id,
          type,
          title: { en: "Play" },
          points: 10,
          repeatCap: 3,
          config,
          ...extra,
        });
      expect((await create("challenge", {})).json().quest).toMatchObject({
        type: "challenge",
        repeatCap: 3,
        verification: ["my_qr"],
      });
      expect(codeOf(await create("challenge", {}, { verification: ["quest_qr"] }))).toEqual([
        422,
        "invalid_quest",
      ]);
      expect((await create("survey", SURVEY)).json().quest).toMatchObject({ repeatCap: 1 });
      expect((await create("share", SHARE)).json().quest).toMatchObject({ repeatCap: 1 });
      expect(codeOf(await create("share", { message: en("x"), link: "http://a.com" }))).toEqual([
        422,
        "invalid_quest",
      ]);
    });

    it("lists a challenge at the station with its type", async () => {
      const event = await newEvent();
      const quest = await newQuest(event.id, "challenge", {});
      const operator = await newPlayer(event.id);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [organizer, event.id, operator.id],
      );
      const stations = await app("GET", `/v1/operator/events/${event.id}/stations`, operator.token);
      expect(stations.json().stations).toEqual([
        expect.objectContaining({ questId: quest, type: "challenge" }),
      ]);
    });
  });
});
