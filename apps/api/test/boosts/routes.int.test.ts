import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;
type Boost = {
  id: string;
  categoryId: string;
  startsAt: string;
  endsAt: string;
  editable: boolean;
};

const en = (text: string) => ({ en: text });
const codeOf = (response: { statusCode: number; json: () => { code?: string } }) => [
  response.statusCode,
  response.json().code,
];
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * Boosts over HTTP (T-307): the Boosts page's list, save, edit, delete and Stop with their refusals, the platform and
 * event switches, the category kept while boosted, the doubled completion answer, the quests read's `boost`, the live
 * read's `boosts` and the activity's `multiplier`.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("boosts over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let settingsPool: Pool;
  let settings: SettingsService;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    settingsPool = new Pool({ connectionString: db.appUrl, max: 2 });
    settings = createSettingsService({ pool: settingsPool });
    test = await startApp(db, false, {}, { settings });
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('boost-org', 'boost-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const id = await createStaff(db.owner, { email: "owner@boost.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, id],
    );
    ownerCookie = await signInFully(test, "owner@boost.test");
  });
  afterAll(async () => {
    await test.close();
    await settingsPool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Boost Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `BST${counter}`],
    );
    return event?.id ?? "";
  };
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`boost_http_${counter}`],
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
  const dashboard = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    payload?: object,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(ownerCookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const categoryOf = async (event: string) =>
    (await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1 LIMIT 1", [event]))[0]
      ?.id ?? "";

  it("lists, saves, edits, stops and deletes, with each refusal", async () => {
    const event = await newEvent();
    const category = await categoryOf(event);
    const made = await dashboard("POST", `/events/${event}/boosts`, {
      categoryId: category,
      startsAt: minutesFromNow(30),
      minutes: 20,
    });
    expect(made.statusCode).toBe(201);
    const boost = made.json().boost as Boost;
    expect(boost).toMatchObject({ categoryId: category, multiplier: 2, editable: true, paid: 0 });
    expect(Date.parse(boost.endsAt) - Date.parse(boost.startsAt)).toBe(20 * 60_000);
    expect((await dashboard("GET", `/events/${event}/boosts`)).json()).toEqual({ boosts: [boost] });

    const moved = await dashboard("PATCH", `/events/${event}/boosts/${boost.id}`, {
      categoryId: category,
      startsAt: minutesFromNow(60),
      minutes: 30,
    });
    expect(moved.statusCode).toBe(200);
    const edited = moved.json().boost as Boost;
    expect(edited).toMatchObject({ id: boost.id, categoryId: category, editable: true });
    expect(Date.parse(edited.endsAt) - Date.parse(edited.startsAt)).toBe(30 * 60_000);
    expect(
      codeOf(await dashboard("POST", `/events/${event}/boosts/${boost.id}/end`, { extra: 1 })),
    ).toEqual([400, "invalid_request"]);
    expect(
      codeOf(
        await dashboard("POST", `/events/${event}/boosts`, {
          categoryId: category,
          startsAt: minutesFromNow(70),
          minutes: 10,
        }),
      ),
    ).toEqual([409, "boost_overlap"]);
    expect(codeOf(await dashboard("POST", `/events/${event}/boosts/${boost.id}/end`, {}))).toEqual([
      409,
      "not_started",
    ]);
    expect((await dashboard("DELETE", `/events/${event}/boosts/${boost.id}`)).statusCode).toBe(204);

    const now = (
      await dashboard("POST", `/events/${event}/boosts`, { categoryId: category, minutes: 10 })
    ).json().boost as Boost;
    expect(codeOf(await dashboard("DELETE", `/events/${event}/boosts/${now.id}`))).toEqual([
      409,
      "boost_started",
    ]);
    expect(
      codeOf(
        await dashboard("PATCH", `/events/${event}/boosts/${now.id}`, {
          categoryId: category,
          minutes: 20,
        }),
      ),
    ).toEqual([409, "boost_started"]);
    const stopped = await dashboard("POST", `/events/${event}/boosts/${now.id}/end`, {});
    expect(stopped.json()).toMatchObject({ replayed: false });
    expect(
      (await dashboard("POST", `/events/${event}/boosts/${now.id}/end`, {})).json(),
    ).toMatchObject({ replayed: true });
    expect(codeOf(await dashboard("DELETE", `/events/${event}/boosts/${randomUUID()}`))).toEqual([
      404,
      "not_found",
    ]);
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'Second')", [event]);
    expect(
      codeOf(
        await dashboard("DELETE", `/events/${event}/categories/${category}`, { confirm: true }),
      ),
    ).toEqual([409, "boost_in_use"]);
  });

  it("names the fields at fault (invalid_boost {issues}) and the event's window", async () => {
    const event = await newEvent();
    const category = await categoryOf(event);
    const refused = await dashboard("POST", `/events/${event}/boosts`, {
      categoryId: "x",
      minutes: 0,
    });
    expect(refused.json()).toMatchObject({
      code: "invalid_boost",
      details: { issues: ["categoryId", "minutes"] },
    });
    const unknownField = await dashboard("POST", `/events/${event}/boosts`, {
      categoryId: category,
      minutes: 5,
      colour: "gold",
    });
    expect(unknownField.json()).toMatchObject({
      code: "invalid_boost",
      details: { issues: ["boost"] },
    });
    const outside = await dashboard("POST", `/events/${event}/boosts`, {
      categoryId: category,
      startsAt: minutesFromNow(60 * 24),
      minutes: 60,
    });
    expect(outside.json()).toMatchObject({
      code: "invalid_boost",
      details: { issues: ["outside_event"] },
    });
    expect(
      codeOf(
        await dashboard("POST", `/events/${randomUUID()}/boosts`, {
          categoryId: category,
          minutes: 5,
        }),
      ),
    ).toEqual([404, "not_found"]);
  });

  it("refuses the 101st boost of an event, and any boost once the event has ended", async () => {
    const event = await newEvent();
    const category = await categoryOf(event);
    await owner(
      `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
       SELECT $1, $2, $3, now() - make_interval(mins => 2 * n + 10), now() - make_interval(mins => 2 * n + 9)
       FROM generate_series(1, 100) n`,
      [organizer, event, category],
    );
    const full = await dashboard("POST", `/events/${event}/boosts`, {
      categoryId: category,
      minutes: 5,
    });
    expect(full.json()).toMatchObject({ code: "limit_reached", details: { limit: 100 } });
    expect(full.statusCode).toBe(409);

    const ended = await newEvent();
    await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [ended]);
    expect(
      codeOf(
        await dashboard("POST", `/events/${ended}/boosts`, {
          categoryId: await categoryOf(ended),
          minutes: 5,
        }),
      ),
    ).toEqual([409, "event_ended"]);
  });

  it("refuses a new boost while the platform switch is off; running ones still pay", async () => {
    const event = await newEvent();
    const category = await categoryOf(event);
    const running = await dashboard("POST", `/events/${event}/boosts`, {
      categoryId: category,
      minutes: 30,
    });
    expect(running.statusCode).toBe(201);
    await owner(
      `INSERT INTO platform_setting (key, value) VALUES ('features', '{"boosts": {"enabled": false}}')
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || EXCLUDED.value`,
    );
    settings.forget();
    try {
      const refused = await dashboard("POST", `/events/${event}/boosts`, {
        categoryId: category,
        startsAt: minutesFromNow(120),
        minutes: 10,
      });
      expect(codeOf(refused)).toEqual([403, "feature_off"]);
    } finally {
      await owner("UPDATE platform_setting SET value = value - 'boosts' WHERE key = 'features'");
      settings.forget();
    }
  });

  it("doubles the completion, says so in the answer, the quests read, live and the activity; the event switch stops it", async () => {
    const event = await newEvent();
    const category = await categoryOf(event);
    const quest = (
      await dashboard("POST", `/events/${event}/quests`, {
        categoryId: category,
        type: "enter_code",
        title: en("Find the falcon"),
        points: 10,
        repeatCap: 5,
        config: { code: "FALCON" },
      })
    ).json().quest as { id: string };
    const boost = (
      await dashboard("POST", `/events/${event}/boosts`, { categoryId: category, minutes: 30 })
    ).json().boost as Boost;
    const player = await newPlayer(event);
    const complete = () =>
      app("POST", `/v1/quests/${quest.id}/complete`, player, {
        proof: { type: "code", code: "FALCON" },
      });
    expect((await complete()).json()).toMatchObject({ points: 20, boost: { multiplier: 2 } });

    const read = (await app("GET", `/v1/events/${event}/quests`, player)).json() as {
      categories: { boost: Row | null; quests: { id: string; boost: Row | null }[] }[];
    };
    expect(read.categories[0]?.boost).toEqual({ multiplier: 2, endsAt: boost.endsAt });
    expect(read.categories[0]?.quests[0]?.boost).toEqual({ multiplier: 2, endsAt: boost.endsAt });
    const live = (await app("GET", `/v1/events/${event}/live`, player)).json();
    expect(live).toMatchObject({
      boosts: [{ boostId: boost.id, categoryId: category, multiplier: 2, endsAt: boost.endsAt }],
    });
    const activity = (await app("GET", `/v1/events/${event}/activity`, player)).json() as {
      entries: { kind: string; multiplier: number | null }[];
    };
    expect(activity.entries[0]).toMatchObject({ kind: "quest", multiplier: 2 });

    const off = await dashboard("PUT", `/events/${event}/double-points`, { enabled: false });
    expect(off.json()).toEqual({ boosts: false });
    expect((await complete()).json()).toMatchObject({ points: 10, boost: null });
    const view = (await dashboard("GET", `/events/${event}`)).json() as { event: Row };
    expect(view.event).toMatchObject({ boosts: false, flashQuests: true });
  });
});
