import { randomUUID } from "node:crypto";
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

/**
 * The event's analytics over HTTP (T-607, FR-1201 to FR-1205, FR-1625): three panels of counts for the event's own team,
 * each checked against its schema, never a player, a name or a contact detail, and no time-spent or heatmap figure.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("analytics over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let event = "";
  let ownerCookie = "";
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Analytics Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `ANL${counter}`],
    );
    const id = row?.id ?? "";
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [id]);
    return id;
  };
  const newQuest = async (ev: string): Promise<string> =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible)
         SELECT $1, id, 'scan_qr', 'Find the stage', 10, 3, true FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [ev],
      )
    )[0]?.id ?? "";
  const join = async (ev: string, via: string, questId?: string): Promise<void> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`analytics_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `analytics${counter}@private.test`,
    ]);
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [organizer, ev, player?.id, via],
    );
    if (questId !== undefined) {
      await owner(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', $5)`,
        [organizer, ev, enrolled?.id, questId, randomUUID()],
      );
    }
  };
  const read = (ev: string, panel: string, cookie: string | null = ownerCookie, org = organizer) =>
    test.app.inject({
      method: "GET",
      url: `/v1/organizers/${org}/events/${ev}/analytics/${panel}`,
      ...(cookie === null ? {} : { headers: withSession(cookie) }),
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('analytics-org', 'analytics-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@analytics.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@analytics.test");
    event = await newEvent();
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("answers participation with the activation rate and the join sources, and nothing about a player", async () => {
    const ev = await newEvent();
    const stage = await newQuest(ev);
    for (let i = 0; i < 6; i += 1) await join(ev, i < 4 ? "code" : "qr", i < 3 ? stage : undefined);
    const answer = await read(ev, "participation");
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    const body = answer.json();
    expect(body).toMatchObject({ joined: 6, active: 3, activation: 50, returning: 0 });
    expect(body.sources).toMatchObject({ code: 4, qr: 2, link: 0, public_list: 0, invite: 0 });
    expect(Object.keys(body).toSorted()).toEqual([
      "activation",
      "active",
      "joined",
      "rehearsal",
      "returning",
      "series",
      "sources",
      "unit",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/private\.test|analytics_|@|time|heat/i);
  });

  it("shows zeros and no activation value for an event nobody joined", async () => {
    const body = (await read(await newEvent(), "participation")).json();
    expect(body).toMatchObject({
      joined: 0,
      active: 0,
      activation: null,
      returning: 0,
      series: [],
    });
  });

  it("answers the quests by category with each quest's players", async () => {
    const ev = await newEvent();
    const stage = await newQuest(ev);
    await join(ev, "code", stage);
    await join(ev, "code");
    const body = (await read(ev, "quests")).json();
    expect(body.joined).toBe(2);
    const [filled] = body.categories.filter(
      (category: { quests: unknown[] }) => category.quests.length > 0,
    );
    expect(filled).toMatchObject({ name: { en: "General" }, inOrder: false });
    expect(filled.quests).toEqual([
      { id: stage, title: { ar: null, en: "Find the stage" }, done: 1, step: true, skipped: false },
    ]);
  });

  it("answers the economy with points earned, spent and each reward's stock", async () => {
    const ev = await newEvent();
    await owner(
      "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 40, 8)",
      [ev],
    );
    const body = (await read(ev, "economy")).json();
    expect(body).toMatchObject({ earned: 0, spent: 0, unclaimed: 0 });
    expect(body.rewards).toEqual([
      expect.objectContaining({ name: { ar: null, en: "Tour" }, redeemed: 0, stockLeft: 8 }),
    ]);
  });

  it("refuses a stranger, another organizer's team, an unknown event and a panel that does not exist", async () => {
    const rival = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-analytics', 'rival-analytics') RETURNING id",
      )
    ).rows[0]?.id as string;
    const rivalStaff = await createStaff(db.owner, { email: "owner@rival-analytics.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rival, rivalStaff],
    );
    const rivalCookie = await signInFully(test, "owner@rival-analytics.test");
    for (const panel of ["participation", "quests", "economy"]) {
      expect((await read(event, panel, null)).statusCode, `${panel} anonymous`).toBe(401);
      for (const [cookie, org, ev] of [
        [rivalCookie, rival, event],
        [rivalCookie, organizer, event],
        [ownerCookie, rival, event],
        [ownerCookie, organizer, randomUUID()],
      ] as const) {
        const refused = await read(ev, panel, cookie, org);
        expect([refused.statusCode, refused.json().code], panel).toEqual([404, "not_found"]);
      }
    }
    expect((await read(event, "time-spent")).statusCode).toBe(400);
    expect((await read(event, "heatmap")).statusCode).toBe(400);
    expect((await read("not-a-uuid", "participation")).statusCode).toBe(400);
  });

  it("keeps an editor to the events in their limit", async () => {
    const outside = await newEvent();
    const editor = await createStaff(db.owner, { email: "editor@analytics.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [event]],
    );
    const cookie = await signInFully(test, "editor@analytics.test");
    for (const panel of ["participation", "quests", "economy"]) {
      expect((await read(event, panel, cookie)).statusCode, panel).toBe(200);
      expect((await read(outside, panel, cookie)).statusCode, panel).toBe(404);
    }
  });
});
