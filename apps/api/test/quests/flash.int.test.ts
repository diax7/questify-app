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
type Quest = { id: string; visible: boolean; flash: boolean; flashLaunchedAt: string | null };

const en = (text: string) => ({ en: text });
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
/** The event's wall clock (Asia/Riyadh, UTC+3) `minutes` from now, as the builder takes times. */
const riyadhIn = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000 + 3 * 3_600_000).toISOString().slice(0, 16);

/**
 * Flash quests over HTTP (T-307): the builder's flash field and its refusals, Launch and End now with theirs, the
 * quests read's `flash`, the live read's `flash`, and the event's switch.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("flash quests over HTTP", () => {
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
          "INSERT INTO organizer (name, slug) VALUES ('flash-org', 'flash-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@flash.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@flash.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (status = "live"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Flash Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `FLSH${counter}`, status],
    );
    return event?.id ?? "";
  };
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`flash_http_${counter}`],
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
  const app = (method: "GET" | "POST", path: string, token: string, payload?: object) =>
    test.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    });
  const dashboard = (method: "GET" | "POST" | "PATCH" | "PUT", path: string, payload?: object) =>
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
  const launch = (event: string, quest: string, minutes = 10) =>
    dashboard("POST", `/events/${event}/quests/${quest}/launch`, { minutes });
  const end = (event: string, quest: string) =>
    dashboard("POST", `/events/${event}/quests/${quest}/end`, {});

  it("saves a draft flash quest hidden, launches it, keeps its window through an edit, and ends it", async () => {
    const event = await newEvent();
    const made = await newQuest(event, { flash: true });
    expect(made.statusCode).toBe(201);
    const draft = made.json().quest as Quest;
    expect(draft).toMatchObject({ flash: true, visible: false, flashLaunchedAt: null });
    const player = await newPlayer(event);
    const quests = async () =>
      (await app("GET", `/v1/events/${event}/quests`, player)).json().categories as {
        quests: { id: string; flash: { closesAt: string } | null }[];
      }[];
    expect((await quests()).flatMap((category) => category.quests)).toEqual([]);

    const launched = await launch(event, draft.id, 15);
    expect(launched.statusCode).toBe(200);
    const window = launched.json() as { opensAt: string; closesAt: string; replayed: boolean };
    expect(Date.parse(window.closesAt) - Date.parse(window.opensAt)).toBe(15 * 60_000);
    expect(window.replayed).toBe(false);
    expect((await launch(event, draft.id)).json()).toMatchObject({ replayed: true });
    const listed = (await quests())[0]?.quests[0];
    expect(listed).toMatchObject({ id: draft.id, flash: { closesAt: window.closesAt } });

    const edited = await dashboard("PATCH", `/events/${event}/quests/${draft.id}`, {
      title: en("Find the golden falcon"),
      visible: false,
      closesAt: riyadhIn(600),
      confirm: true,
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().quest).toMatchObject({ visible: true, closesAt: window.closesAt });
    expect(
      codeOf(
        await dashboard("PATCH", `/events/${event}/quests/${draft.id}`, {
          flash: false,
          confirm: true,
        }),
      ),
    ).toEqual([422, "invalid_quest"]);

    const live = await app("GET", `/v1/events/${event}/live`, player);
    expect(live.json()).toMatchObject({
      flash: [{ questId: draft.id, closesAt: window.closesAt }],
    });

    expect((await end(event, draft.id)).json()).toMatchObject({ replayed: false });
    expect((await end(event, draft.id)).json()).toMatchObject({ replayed: true });
    expect(codeOf(await launch(event, draft.id))).toEqual([409, "already_launched"]);
  });

  it("schedules one with both times, at most 1,440 minutes apart, and refuses a live poll", async () => {
    const event = await newEvent();
    const scheduled = await newQuest(event, {
      flash: true,
      visible: true,
      opensAt: riyadhIn(30),
      closesAt: riyadhIn(60),
    });
    expect(scheduled.statusCode).toBe(201);
    expect(scheduled.json().quest).toMatchObject({ flash: true, visible: true });
    const id = (scheduled.json().quest as Quest).id;
    expect(codeOf(await launch(event, id))).toEqual([409, "flash_scheduled"]);
    expect(codeOf(await end(event, id))).toEqual([409, "not_started"]);
    for (const window of [
      { opensAt: riyadhIn(30) },
      { opensAt: riyadhIn(30), closesAt: riyadhIn(30 + 1441) },
    ]) {
      const refused = await newQuest(event, { flash: true, visible: true, ...window });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "invalid_quest",
        details: { field: "flashWindow" },
      });
    }
    const poll = await newQuest(event, {
      type: "vote",
      flash: true,
      config: {
        options: [
          { id: "a", text: en("A") },
          { id: "b", text: en("B") },
        ],
        live: { choices: "one", results: "after_vote", minutes: 5 },
      },
    });
    expect(poll.json()).toMatchObject({ code: "invalid_quest", details: { field: "flash" } });
  });

  it("answers not_flash, not_found, too_late and feature_off; minutes outside 1 to 1,440 are a bad request", async () => {
    const event = await newEvent();
    const plain = (await newQuest(event, {})).json().quest as Quest;
    expect(codeOf(await launch(event, plain.id))).toEqual([422, "not_flash"]);
    expect(codeOf(await launch(event, randomUUID()))).toEqual([404, "not_found"]);
    const draft = (await newQuest(event, { flash: true })).json().quest as Quest;
    expect((await launch(event, draft.id, 0)).statusCode).toBe(400);
    expect((await launch(event, draft.id, 1441)).statusCode).toBe(400);
    const off = await dashboard("PUT", `/events/${event}/flash-quests`, { enabled: false });
    expect(off.json()).toEqual({ flashQuests: false });
    expect(codeOf(await launch(event, draft.id))).toEqual([403, "feature_off"]);
    await dashboard("PUT", `/events/${event}/flash-quests`, { enabled: true });
    await owner("UPDATE event SET ends_at = now() + interval '20 seconds' WHERE id = $1", [event]);
    expect(codeOf(await launch(event, draft.id))).toEqual([409, "too_late"]);
  });

  it("refuses the player a flash quest switched off (quest_not_open switched_off), and pays it inside its window", async () => {
    const event = await newEvent();
    const draft = (await newQuest(event, { flash: true })).json().quest as Quest;
    await launch(event, draft.id);
    const player = await newPlayer(event);
    const complete = () =>
      app("POST", `/v1/quests/${draft.id}/complete`, player, {
        proof: { type: "code", code: "FALCON" },
      });
    await dashboard("PUT", `/events/${event}/flash-quests`, { enabled: false });
    const refused = await complete();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({
      code: "quest_not_open",
      details: { reason: "switched_off" },
    });
    await dashboard("PUT", `/events/${event}/flash-quests`, { enabled: true });
    const paid = await complete();
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ points: 10, boost: null });
  });
});
