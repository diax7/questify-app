import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DONE_CACHE_MS, createControlReader } from "#src/control/control";
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
 * The control room's one read over HTTP (T-603, FR-1024, FR-1028): the newest completions with a username and no contact
 * detail, the counters, and each quest's completions, kept for 30 seconds and shared; only for the event's own team.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("control room over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let pool: Pool;
  let organizer = "";
  let event = "";
  let ownerCookie = "";
  let ownerId = "";
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Control Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [organizer, `CTL${counter}`],
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
  const scan = async (ev: string, questId: string): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`control_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `control${counter}@private.test`,
    ]);
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, ev, player?.id],
    );
    await owner(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5)`,
      [organizer, ev, enrolled?.id, questId, randomUUID()],
    );
    return `control_${counter}`;
  };
  const read = (ev: string, cookie: string | null = ownerCookie, org = organizer) =>
    test.app.inject({
      method: "GET",
      url: `/v1/organizers/${org}/events/${ev}/control`,
      ...(cookie === null ? {} : { headers: withSession(cookie) }),
    });

  const press = (
    ev: string,
    quest: string,
    action: string,
    cookie = ownerCookie,
    org = organizer,
  ) =>
    test.app.inject({
      method: "POST",
      url: `/v1/organizers/${org}/events/${ev}/quests/${quest}/${action}`,
      headers: { ...withSession(cookie), "idempotency-key": randomUUID() },
      payload: {},
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('control-org', 'control-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    ownerId = await createStaff(db.owner, { email: "owner@control.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@control.test");
    event = await newEvent();
  });
  afterAll(async () => {
    await test.close();
    await pool.end();
    await db.close();
  });

  it("answers the feed, the counters and the per-quest completions in one read, with no contact detail", async () => {
    const ev = await newEvent();
    const stage = await newQuest(ev);
    const username = await scan(ev, stage);
    const answer = await read(ev);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    const body = answer.json();
    expect(Object.keys(body).toSorted()).toEqual(["behind", "counts", "done", "feed"]);
    expect(body.counts).toEqual({ players: 1, online: 1, lowStock: 0, inbox: 0, flags: 0 });
    expect(body.done).toEqual({ [stage]: 1 });
    expect(body.feed).toHaveLength(1);
    expect(body.feed[0]).toMatchObject({
      questId: stage,
      title: { ar: null, en: "Find the stage" },
      method: "qr",
      username,
    });
    expect(Object.keys(body.feed[0]).toSorted()).toEqual([
      "at",
      "avatar",
      "id",
      "method",
      "questId",
      "title",
      "username",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/private\.test|@/);
  });

  it("answers an empty room for a quiet event", async () => {
    const ev = await newEvent();
    expect((await read(ev)).json()).toEqual({
      counts: { players: 0, online: 0, lowStock: 0, inbox: 0, flags: 0 },
      feed: [],
      done: {},
      behind: {},
    });
  });

  it("refuses a stranger, another organizer's team, a bad id and an unknown event", async () => {
    const rival = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-control', 'rival-control') RETURNING id",
      )
    ).rows[0]?.id as string;
    const rivalStaff = await createStaff(db.owner, { email: "owner@rival-control.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rival, rivalStaff],
    );
    const rivalCookie = await signInFully(test, "owner@rival-control.test");
    expect((await read(event, null)).statusCode).toBe(401);
    for (const [cookie, org, ev] of [
      [rivalCookie, rival, event],
      [rivalCookie, organizer, event],
      [ownerCookie, rival, event],
      [ownerCookie, organizer, randomUUID()],
    ] as const) {
      const refused = await read(ev, cookie, org);
      expect([refused.statusCode, refused.json().code]).toEqual([404, "not_found"]);
    }
    expect((await read("not-a-uuid")).statusCode).toBe(400);
  });

  it("keeps an editor to the events in their limit", async () => {
    const outside = await newEvent();
    const editor = await createStaff(db.owner, { email: "editor@control.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [event]],
    );
    const cookie = await signInFully(test, "editor@control.test");
    expect((await read(event, cookie)).statusCode).toBe(200);
    expect((await read(outside, cookie)).statusCode).toBe(404);
  });

  it("shares the per-quest completions for 30 seconds, and reads the feed and counters fresh each time", async () => {
    let clock = 1_000_000;
    const reader = createControlReader({ pool }, () => clock);
    const team = { organizerId: organizer, staffUserId: ownerId };
    const ev = await newEvent();
    const stage = await newQuest(ev);
    await scan(ev, stage);
    expect((await reader.read(team, ev))?.done).toEqual({ [stage]: 1 });
    await scan(ev, stage);
    clock += DONE_CACHE_MS - 1;
    const early = await reader.read(team, ev);
    expect(early?.done).toEqual({ [stage]: 1 });
    expect([early?.feed.length, early?.counts.players]).toEqual([2, 2]);
    clock += 1;
    expect((await reader.read(team, ev))?.done).toEqual({ [stage]: 2 });
  });

  it("never serves a cached answer to a caller the database refuses", async () => {
    const reader = createControlReader({ pool }, () => 1_000_000);
    const team = { organizerId: organizer, staffUserId: ownerId };
    const ev = await newEvent();
    expect(await reader.read(team, ev)).toBeDefined();
    const stranger = await createStaff(db.owner, { email: "stranger@control.test" });
    expect(
      await reader.read({ organizerId: organizer, staffUserId: stranger }, ev),
    ).toBeUndefined();
    expect(await reader.read({ ...team, organizerId: randomUUID() }, ev)).toBeUndefined();
  });
  describe("pause and skip (T-603b)", () => {
    it("pauses and resumes, answers changed:false for the same state, and audits each change", async () => {
      const ev = await newEvent();
      const stage = await newQuest(ev);
      const paused = await press(ev, stage, "pause");
      expect([paused.statusCode, paused.json()]).toEqual([200, { paused: true, changed: true }]);
      expect((await press(ev, stage, "pause")).json()).toEqual({ paused: true, changed: false });
      expect((await press(ev, stage, "resume")).json()).toEqual({ paused: false, changed: true });
      const actions = await owner<{ action: string }>(
        "SELECT action FROM audit_log WHERE target_id = $1 ORDER BY id",
        [stage],
      );
      expect(actions.map((row) => row.action)).toEqual(["quest.pause", "quest.resume"]);
    });

    it("skips a step of an in-order category, refuses an any-order one, and counts who is behind", async () => {
      const ev = await newEvent();
      const stage = await newQuest(ev);
      const refused = await press(ev, stage, "skip");
      expect([refused.statusCode, refused.json().code]).toEqual([422, "not_in_order"]);
      await owner("UPDATE category SET order_mode = 'in_order' WHERE event_id = $1", [ev]);
      expect((await press(ev, stage, "skip")).json()).toEqual({ skipped: true, changed: true });
      expect((await read(ev)).json().behind).toEqual({ [stage]: 0 });
      expect((await press(ev, stage, "unskip")).json()).toEqual({ skipped: false, changed: true });
    });

    it("answers 404 outside the team's reach and 409 once the event has ended", async () => {
      const ev = await newEvent();
      const stage = await newQuest(ev);
      const other = await newEvent();
      for (const [target, quest] of [
        [other, stage],
        [ev, randomUUID()],
      ] as const) {
        const refused = await press(target, quest, "pause");
        expect([refused.statusCode, refused.json().code]).toEqual([404, "not_found"]);
      }
      await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [ev]);
      const closed = await press(ev, stage, "pause");
      expect([closed.statusCode, closed.json().code]).toEqual([409, "event_closed"]);
    });
  });
});
