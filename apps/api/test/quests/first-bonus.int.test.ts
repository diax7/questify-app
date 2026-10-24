import { createHash, randomBytes, randomUUID } from "node:crypto";
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
type Bonus = { points: number; slots: number; given: number; left: number; locked: boolean };

const en = (text: string) => ({ en: text });
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];

/**
 * The first-N bonus over HTTP (T-313): the builder's `firstBonus` with its refusals and Stop, the builder read, the
 * player's quests read, the live read, every completion answer's `firstBonus` (won, all taken, the same on a replay),
 * and the `practice:` key never reaching a door.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the first-N bonus over HTTP", () => {
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
          "INSERT INTO organizer (name, slug) VALUES ('bonus-org', 'bonus-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@bonus.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@bonus.test");
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
       VALUES ($1, $2, 'Bonus Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `FNBH${counter}`],
    );
    return event?.id ?? "";
  };
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`bonus_http_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(token).digest()],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      organizer,
      event,
      player?.id,
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
  const categoryOf = async (event: string) =>
    (await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1 LIMIT 1", [event]))[0]
      ?.id ?? "";
  const newQuest = async (event: string, fields: object) =>
    dashboard("POST", `/events/${event}/quests`, {
      categoryId: await categoryOf(event),
      type: "enter_code",
      title: en("Find the falcon"),
      points: 10,
      config: { code: "FALCON" },
      ...fields,
    });
  const edit = (event: string, quest: string, firstBonus: object | null) =>
    dashboard("PATCH", `/events/${event}/quests/${quest}`, { firstBonus, confirm: true });
  const complete = (token: string, quest: string, key: string = randomUUID()) =>
    app(
      "POST",
      `/v1/quests/${quest}/complete`,
      token,
      { proof: { type: "code", code: "FALCON" } },
      key,
    );

  it("sets a bonus on create, refuses out-of-range values, edits, locks after a real claim, and stops", async () => {
    const event = await newEvent();
    const made = await newQuest(event, { firstBonus: { points: 25, slots: 3 } });
    expect(made.statusCode).toBe(201);
    const quest = made.json().quest as { id: string; firstBonus: Bonus };
    expect(quest.firstBonus).toEqual({ points: 25, slots: 3, given: 0, left: 3, locked: false });
    for (const [firstBonus, field] of [
      [{ points: 0, slots: 3 }, "points"],
      [{ points: 100_001, slots: 3 }, "points"],
      [{ points: 5, slots: 1001 }, "slots"],
    ] as const) {
      const refused = await edit(event, quest.id, firstBonus);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ code: "invalid_first_bonus", details: { field } });
    }
    expect((await edit(event, quest.id, { points: 30, slots: 4 })).json().quest.firstBonus).toEqual(
      {
        points: 30,
        slots: 4,
        given: 0,
        left: 4,
        locked: false,
      },
    );
    await complete(await newPlayer(event), quest.id);
    expect(codeOf(await edit(event, quest.id, { points: 31, slots: 4 }))).toEqual([
      409,
      "first_bonus_paid",
    ]);
    expect(codeOf(await edit(event, quest.id, null))).toEqual([409, "first_bonus_paid"]);
    await complete(await newPlayer(event), quest.id);
    const below = await edit(event, quest.id, { points: 30, slots: 1 });
    expect(below.statusCode).toBe(409);
    expect(below.json()).toMatchObject({ code: "below_given", details: { given: 2 } });
    expect(await owner("SELECT title_en FROM quest WHERE id = $1", [quest.id])).toEqual([
      { title_en: "Find the falcon" },
    ]);
    const stopped = await edit(event, quest.id, { stop: true });
    expect(stopped.json().quest.firstBonus).toEqual({
      points: 30,
      slots: 2,
      given: 2,
      left: 0,
      locked: true,
    });
    const read = await dashboard("GET", `/events/${event}/quests`);
    expect(read.json().categories[0].quests[0].firstBonus).toMatchObject({ slots: 2, left: 0 });
  });

  it("answers the player's completion with the bonus, the same on a replay, and 'all taken' after the last", async () => {
    const event = await newEvent();
    const quest = (await newQuest(event, { firstBonus: { points: 25, slots: 1 } })).json()
      .quest as {
      id: string;
    };
    const first = await newPlayer(event);
    const key = randomUUID();
    const won = await complete(first, quest.id, key);
    expect(won.json()).toMatchObject({
      points: 10,
      score: 35,
      firstBonus: { points: 25, place: 1, slots: 1 },
    });
    expect((await complete(first, quest.id, key)).json()).toMatchObject({
      firstBonus: { points: 25, place: 1, slots: 1 },
    });
    const late = await newPlayer(event);
    expect((await complete(late, quest.id)).json()).toMatchObject({
      score: 10,
      firstBonus: { points: 25, place: null, slots: 1 },
    });
    const plain = (await newQuest(event, {})).json().quest as { id: string };
    expect((await complete(late, plain.id)).json()).toMatchObject({ firstBonus: null });
  });

  it("lists the bonus on the player's quests and in the live read, with what is left", async () => {
    const event = await newEvent();
    const quest = (await newQuest(event, { firstBonus: { points: 25, slots: 2 } })).json()
      .quest as {
      id: string;
    };
    const player = await newPlayer(event);
    const listed = await app("GET", `/v1/events/${event}/quests`, player);
    expect(listed.json().categories[0].quests[0].firstBonus).toEqual({
      points: 25,
      slots: 2,
      left: 2,
      mine: null,
    });
    const live = await app("GET", `/v1/events/${event}/live`, player);
    expect(live.json().firstBonus).toEqual([{ questId: quest.id, left: 2, slots: 2 }]);
    await complete(player, quest.id);
    expect((await app("GET", `/v1/events/${event}/live`, player)).json().firstBonus).toEqual([]);
    const mine = await app("GET", `/v1/events/${event}/quests`, player);
    expect(mine.json().categories[0].quests[0].firstBonus).toMatchObject({ mine: { place: 1 } });
    const stranger = await newPlayer(await newEvent());
    expect((await app("GET", `/v1/events/${event}/live`, stranger)).json().firstBonus).toEqual([]);
  });

  it("never forwards a client key marked practice: to a door (keys are UUIDs)", async () => {
    const event = await newEvent();
    const quest = (await newQuest(event, { firstBonus: { points: 25, slots: 2 } })).json()
      .quest as {
      id: string;
    };
    const player = await newPlayer(event);
    const refused = await complete(player, quest.id, `practice:${randomUUID()}`);
    expect(refused.statusCode).toBe(400);
    expect(await owner("SELECT 1 FROM quest_completion WHERE quest_id = $1", [quest.id])).toEqual(
      [],
    );
  });
});
