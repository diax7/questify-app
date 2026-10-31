import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStepCodeKey, stepCode } from "#src/quests/qr";
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
type QuestBody = {
  quest: { id: string; steps: { id: string; name: { en: string | null }; position: number }[] };
};

const recordingStore = (upserts: Upsert[]): RankingStore => ({
  upsert: async (event, entry) => {
    upserts.push({ event, score: entry.score });
  },
  remove: async () => undefined,
  read: async () => ({ top: [], total: 1, place: 1 }),
  rebuild: async () => "rebuilt",
  builtAt: async () => undefined,
});

/** The key the test app signs step codes with (auth-app's QR secret). */
const STEP_KEY = createStepCodeKey("q".repeat(40));
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const steps = (...names: string[]) => names.map((name) => ({ name: { en: name } }));

/**
 * Passport quests over HTTP (T-304b): the builder makes one with its steps and prints a code per step, a player stamps
 * steps and is paid once on the last needed one, the reads show the progress, and each refusal's answer.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("passport quests over HTTP", () => {
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
          "INSERT INTO organizer (name, slug) VALUES ('pass-org', 'pass-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@pass.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@pass.test");
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
       VALUES ($1, $2, 'Pass Fest', 'scheduled', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
      [organizer, `PASH${counter}`],
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
      [`pass_http_${counter}`],
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
  const dashboard = (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, payload?: object) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const categoryOf = async (event: string) =>
    (await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [event]))[0]?.id;
  /** A passport made through the builder, on a scheduled event (no confirmation needed). */
  const newPassport = async (event: string, needed: number, names: string[], points = 30) => {
    const made = await dashboard("POST", `/events/${event}/quests`, {
      categoryId: await categoryOf(event),
      type: "passport",
      title: { en: "Booths" },
      points,
      config: { needed },
      steps: steps(...names),
    });
    expect(made.statusCode).toBe(201);
    return made.json<QuestBody>().quest;
  };
  const stamp = (token: string, stepId: string, version = 1, key?: string) =>
    app(
      "POST",
      `/v1/steps/${stepId}/stamp`,
      token,
      { code: stepCode(STEP_KEY, stepId, version) },
      key,
    );

  describe("the builder", () => {
    it("makes a passport with its steps, refuses a bad shape, and prints a code per step", async () => {
      const event = await newEvent();
      const quest = await newPassport(event, 2, ["One", "Two", "Three"]);
      expect(quest.steps.map((step) => [step.name.en, step.position])).toEqual([
        ["One", 0],
        ["Two", 1],
        ["Three", 2],
      ]);
      const category = await categoryOf(event);
      const base = { categoryId: category, type: "passport", title: { en: "P" }, points: 5 };
      for (const [body, field] of [
        [{ ...base, config: { needed: 3 }, steps: steps("A", "B") }, "needed"],
        [{ ...base, config: { needed: 1 } }, "steps"],
        [{ ...base, config: { needed: 1 }, steps: [{ name: { en: " " } }] }, "steps"],
        [
          { ...base, config: { needed: 1 }, steps: [{ id: randomUUID(), name: { en: "X" } }] },
          "steps",
        ],
        [{ ...base, type: "scan_qr", steps: steps("A") }, "steps"],
      ] as const) {
        const refused = await dashboard("POST", `/events/${event}/quests`, body);
        expect([refused.statusCode, refused.json().details], field).toEqual([422, { field }]);
      }
      const codes = await dashboard("GET", `/events/${event}/codes`);
      expect(
        codes.json<{ codes: { questId: string; stepId: string; step: { en: string } }[] }>().codes,
      ).toEqual(
        quest.steps.map((step) =>
          expect.objectContaining({
            questId: quest.id,
            stepId: step.id,
            step: { ar: null, en: step.name.en },
          }),
        ),
      );
      const first = quest.steps[0]?.id ?? "";
      const regenerated = await dashboard("POST", `/events/${event}/steps/${first}/qr/regenerate`);
      expect(regenerated.json()).toMatchObject({ version: 2 });
      expect(
        (await dashboard("POST", `/events/${event}/steps/${randomUUID()}/qr/regenerate`))
          .statusCode,
      ).toBe(404);
    });

    it("renames, adds and removes steps, keeps stamped ones, and never lowers needed once stamped", async () => {
      const event = await newEvent();
      const quest = await newPassport(event, 2, ["One", "Two", "Three"]);
      const [one, two, three] = quest.steps;
      const edited = await dashboard("PATCH", `/events/${event}/quests/${quest.id}`, {
        steps: [
          { id: three?.id, name: { en: "Third" } },
          { id: one?.id, name: { en: "One" } },
          { name: { en: "New" } },
        ],
      });
      expect(edited.json<QuestBody>().quest.steps.map((step) => step.name.en)).toEqual([
        "Third",
        "One",
        "New",
      ]);
      await goLive(event);
      const token = await newPlayer(event);
      await stamp(token, three?.id ?? "");
      const removeStamped = await dashboard("PATCH", `/events/${event}/quests/${quest.id}`, {
        steps: [{ id: one?.id, name: { en: "One" } }, { name: { en: "Other" } }],
        confirm: true,
      });
      expect(codeOf(removeStamped)).toEqual([409, "step_in_use"]);
      const lower = await dashboard("PATCH", `/events/${event}/quests/${quest.id}`, {
        config: { needed: 1 },
        confirm: true,
      });
      expect([lower.statusCode, lower.json().details]).toEqual([422, { field: "needed" }]);
      const raise = await dashboard("PATCH", `/events/${event}/quests/${quest.id}`, {
        config: { needed: 3 },
        confirm: true,
      });
      expect(raise.statusCode).toBe(200);
      expect(two).toBeDefined();
      expect(
        codeOf(await dashboard("DELETE", `/events/${event}/quests/${quest.id}`, { confirm: true })),
      ).toEqual([409, "points_choice_required"]);
    });

    it("deletes a visible passport with steps and no stamps cleanly", async () => {
      const event = await newEvent();
      const quest = await newPassport(event, 1, ["One", "Two"]);
      expect(
        (await dashboard("DELETE", `/events/${event}/quests/${quest.id}`, {})).statusCode,
      ).toBe(204);
      expect(await owner("SELECT 1 FROM passport_step WHERE quest_id = $1", [quest.id])).toEqual(
        [],
      );
    });
  });

  describe("the player", () => {
    it("reads 1 of 2, is paid once on the second step, replays it, and moves the ranking", async () => {
      const event = await newEvent();
      const quest = await newPassport(event, 2, ["One", "Two", "Three"], 30);
      await goLive(event);
      const token = await newPlayer(event);
      const [one, two, three] = quest.steps.map((step) => step.id);
      const first = await stamp(token, one ?? "");
      expect(first.json()).toEqual({
        questId: quest.id,
        stamped: true,
        done: 1,
        needed: 2,
        completed: null,
        rank: null,
      });
      expect((await stamp(token, one ?? "")).json()).toMatchObject({ stamped: false, done: 1 });
      const list = await app("GET", `/v1/events/${event}/quests`, token);
      expect(list.json().categories[0].quests[0]).toMatchObject({
        id: quest.id,
        steps: { done: 1, needed: 2 },
        done: 0,
      });
      const read = await app("GET", `/v1/quests/${quest.id}/passport`, token);
      expect(read.json()).toEqual({
        needed: 2,
        steps: [
          { id: one, name: { ar: null, en: "One" }, done: true },
          { id: two, name: { ar: null, en: "Two" }, done: false },
          { id: three, name: { ar: null, en: "Three" }, done: false },
        ],
      });
      const key = randomUUID();
      const paid = await stamp(token, three ?? "", 1, key);
      expect(paid.json()).toMatchObject({
        stamped: true,
        done: 2,
        completed: { points: 30, score: 30, replayed: false, levelUp: null, bonus: null },
        rank: 1,
      });
      const again = await stamp(token, three ?? "", 1, key);
      expect(again.json()).toEqual(paid.json());
      expect(codeOf(await stamp(token, two ?? ""))).toEqual([409, "already_completed"]);
      expect(upserts.filter((write) => write.event === event)).toContainEqual({
        event,
        score: 30n,
      });
    });

    it("records a well-formed X-Device-Id in lower case and ignores anything else", async () => {
      const event = await newEvent();
      const quest = await newPassport(event, 3, ["One", "Two", "Three"]);
      await goLive(event);
      const token = await newPlayer(event);
      const device = randomUUID();
      const sent = [device.toUpperCase(), "not-a-device", undefined];
      for (const [index, header] of sent.entries()) {
        const stepId = quest.steps[index]?.id ?? "";
        const stamped = await test.app.inject({
          method: "POST",
          url: `/v1/steps/${stepId}/stamp`,
          headers: {
            authorization: `Bearer ${token}`,
            "idempotency-key": randomUUID(),
            ...(header === undefined ? {} : { "x-device-id": header }),
          },
          payload: { code: stepCode(STEP_KEY, stepId, 1) },
        });
        expect(stamped.statusCode, String(header)).toBe(200);
      }
      const stored = await owner<{ device_id: string | null }>(
        `SELECT p.device_id FROM passport_stamp p JOIN passport_step s ON s.id = p.step_id
         WHERE p.quest_id = $1 ORDER BY s.position`,
        [quest.id],
      );
      expect(stored.map((row) => row.device_id)).toEqual([device, null, null]);
    });

    it("answers each refusal: another step's code, a forged or old code, a stranger, not live", async () => {
      const event = await newEvent();
      const quest = await newPassport(event, 2, ["One", "Two"]);
      const [one, two] = quest.steps.map((step) => step.id);
      const token = await newPlayer(event);
      expect(codeOf(await stamp(token, one ?? ""))).toEqual([403, "quest_not_open"]);
      await goLive(event);
      const otherStep = await app("POST", `/v1/steps/${one}/stamp`, token, {
        code: stepCode(STEP_KEY, two ?? "", 1),
      });
      expect(codeOf(otherStep)).toEqual([422, "invalid_code"]);
      const forged = await app("POST", `/v1/steps/${one}/stamp`, token, {
        code: stepCode(createStepCodeKey("x".repeat(40)), one ?? "", 1),
      });
      expect(codeOf(forged)).toEqual([422, "invalid_code"]);
      await dashboard("POST", `/events/${event}/steps/${one}/qr/regenerate`);
      expect(codeOf(await stamp(token, one ?? ""))).toEqual([422, "invalid_code"]);
      expect((await stamp(token, one ?? "", 2)).statusCode).toBe(200);
      const stranger = await newPlayer(await newEvent());
      expect(codeOf(await stamp(stranger, two ?? ""))).toEqual([404, "not_found"]);
      expect(codeOf(await app("GET", `/v1/quests/${quest.id}/passport`, stranger))).toEqual([
        404,
        "not_found",
      ]);
      expect(codeOf(await stamp(token, randomUUID()))).toEqual([404, "not_found"]);
    });
  });
});
