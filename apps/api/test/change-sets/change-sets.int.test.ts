import { randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * Change sets over HTTP (T-604b, FR-1034, FR-1035, ADR-388): a set lists add, edit and delete items for review and
 * applies nothing; opening it checks each item now (invalid, stale or ready); applying runs the selected items through
 * the builder's own services one by one (a refused item is failed, a changed target stale) and closing leaves the event
 * as it is.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("change sets over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let counter = 0;

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const call = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
    options: Readonly<{ cookie?: string; organizerId?: string }> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url: `/v1/organizers/${options.organizerId ?? organizer}${url}`,
      headers: withSession(
        options.cookie ?? ownerCookie,
        method === "GET" ? {} : { "idempotency-key": randomUUID() },
      ),
      ...(payload === undefined ? {} : { payload }),
    });

  /** A draft event with its General category, one quest of 100 points and one reward of 10. */
  const newEvent = async (status = "draft") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Set Fest', $3, now() + interval '1 day', now() + interval '2 days') RETURNING id`,
      [organizer, `SET${counter}`, status],
    );
    if (status === "live") {
      await owner("UPDATE event SET starts_at = now() - interval '1 hour' WHERE id = $1", [
        event?.id,
      ]);
    }
    const [category] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 ORDER BY position LIMIT 1",
      [event?.id],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Stage', 100, '{"code":"ABC"}') RETURNING id`,
      [event?.id, category?.id],
    );
    const [reward] = await owner<{ id: string }>(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total)
       VALUES ($1, 'experience', 'Hoodie', 10, 5) RETURNING id`,
      [event?.id],
    );
    return {
      event: event?.id ?? "",
      category: category?.id ?? "",
      quest: quest?.id ?? "",
      reward: reward?.id ?? "",
    };
  };

  const questTitles = async (event: string) =>
    (
      await owner<{ title_en: string }>(
        "SELECT title_en FROM quest WHERE event_id = $1 AND deleted_at IS NULL ORDER BY title_en",
        [event],
      )
    ).map((row) => row.title_en);

  const make = async (event: string, items: object[]) => {
    const made = await call("POST", `/events/${event}/change-sets`, { items });
    expect(made.statusCode, made.body).toBe(201);
    return made.json<{ changeSet: { id: string } }>().changeSet.id;
  };
  const open = async (event: string, set: string) =>
    (await call("GET", `/events/${event}/change-sets/${set}`)).json<{
      changeSet: {
        status: string;
        items: {
          id: string;
          state: string;
          diff: { before: Record<string, unknown>; after: Record<string, unknown> } | null;
          problem: { code: string; details: Record<string, unknown> } | null;
        }[];
      };
    }>().changeSet;
  const apply = (event: string, set: string, itemIds: string[]) =>
    call("POST", `/events/${event}/change-sets/${set}/apply`, { itemIds });

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await owner<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('change-sets', 'change-sets') RETURNING id",
        )
      )[0]?.id ?? "";
    const staff = await createStaff(db.owner, { email: "owner@change-sets.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, staff],
    );
    ownerCookie = await signInFully(test, "owner@change-sets.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("lists each change with its before and after values and applies none of them", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      {
        op: "add",
        target: "quest",
        body: { categoryId: f.category, type: "scan_qr", title: { en: "Hall" }, points: 40 },
      },
      { op: "edit", target: "quest", targetId: f.quest, body: { points: 150 } },
      { op: "edit", target: "reward", targetId: f.reward, body: { price: 25 } },
    ]);
    expect(await questTitles(f.event)).toEqual(["Stage"]);
    const [stored] = await owner<{ points: number }>("SELECT points FROM quest WHERE id = $1", [
      f.quest,
    ]);
    expect(stored?.points).toBe(100);
    const opened = await open(f.event, set);
    expect(opened.items.map((item) => item.state)).toEqual(["ready", "ready", "ready"]);
    expect(opened.items[1]?.diff).toEqual({ before: { points: 100 }, after: { points: 150 } });
    expect(opened.items[2]?.diff).toEqual({ before: { price: 10 }, after: { price: 25 } });
    expect(opened.items[0]?.diff?.after).toMatchObject({ titleEn: "Hall", points: 40 });
    const listed = await call("GET", `/events/${f.event}/change-sets`);
    expect(listed.json().changeSets).toMatchObject([
      { id: set, status: "open", items: 3, pending: 3 },
    ]);
    const audit = await owner(
      "SELECT 1 FROM audit_log WHERE action = 'change_set.create' AND event_id = $1",
      [f.event],
    );
    expect(audit).toHaveLength(1);
  });

  it("marks an item invalid with its reason when the set is opened", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      {
        op: "add",
        target: "quest",
        body: { categoryId: f.category, type: "scan_qr", title: { en: "Bad" }, points: -1 },
      },
      { op: "edit", target: "quest", targetId: randomUUID(), body: { points: 5 } },
      {
        op: "add",
        target: "quest",
        body: { categoryId: randomUUID(), type: "scan_qr", title: { en: "Lost" }, points: 5 },
      },
      { op: "edit", target: "reward", targetId: f.reward, body: { stock: 0, price: 0 } },
      { op: "add", target: "category", body: { name: {} } },
    ]);
    const opened = await open(f.event, set);
    expect(opened.items.map((item) => [item.state, item.problem?.code])).toEqual([
      ["invalid", "invalid_quest"],
      ["invalid", "not_found"],
      ["invalid", "invalid_quest"],
      ["invalid", "invalid_reward"],
      ["invalid", "invalid_category"],
    ]);
    expect(opened.items[0]?.problem?.details).toEqual({ field: "points" });
    expect(opened.items[2]?.problem?.details).toEqual({ field: "categoryId" });
  });

  it("applies only the selected items, each with its usual audit entry, and leaves the rest pending", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      {
        op: "add",
        target: "quest",
        body: { categoryId: f.category, type: "scan_qr", title: { en: "Hall" }, points: 40 },
      },
      { op: "edit", target: "quest", targetId: f.quest, body: { points: 150 } },
      { op: "edit", target: "reward", targetId: f.reward, body: { price: 25 } },
    ]);
    const ids = (await open(f.event, set)).items.map((item) => item.id);
    const applied = await apply(f.event, set, [ids[0] as string, ids[2] as string]);
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      changeSet: { status: "open" },
      results: [
        { itemId: ids[0], status: "applied" },
        { itemId: ids[2], status: "applied" },
      ],
    });
    expect(await questTitles(f.event)).toEqual(["Hall", "Stage"]);
    const [quest] = await owner<{ points: number }>("SELECT points FROM quest WHERE id = $1", [
      f.quest,
    ]);
    expect(quest?.points).toBe(100);
    const [reward] = await owner<{ price: number }>("SELECT price FROM reward WHERE id = $1", [
      f.reward,
    ]);
    expect(reward?.price).toBe(25);
    const actions = await owner<{ action: string }>(
      "SELECT action FROM audit_log WHERE event_id = $1 AND action IN ('quest.create', 'reward.update', 'quest.update') ORDER BY action",
      [f.event],
    );
    expect(actions.map((row) => row.action)).toEqual(["quest.create", "reward.update"]);
    const middle = await open(f.event, set);
    expect(middle.items.map((item) => item.state)).toEqual(["applied", "ready", "applied"]);
    const rest = await apply(f.event, set, [ids[1] as string]);
    expect(rest.json()).toMatchObject({ changeSet: { status: "applied" } });
    const again = await apply(f.event, set, [ids[1] as string]);
    expect([again.statusCode, again.json().code]).toEqual([409, "change_set_finished"]);
  });

  it("skips an item whose target changed since the set was made and applies the others", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      { op: "edit", target: "quest", targetId: f.quest, body: { points: 150 } },
      { op: "edit", target: "reward", targetId: f.reward, body: { price: 25 } },
    ]);
    const changed = await call("PATCH", `/events/${f.event}/quests/${f.quest}`, { points: 120 });
    expect(changed.statusCode).toBe(200);
    const opened = await open(f.event, set);
    expect(opened.items.map((item) => item.state)).toEqual(["stale", "ready"]);
    const ids = opened.items.map((item) => item.id);
    const applied = await apply(f.event, set, ids);
    expect(applied.json().results).toMatchObject([
      { itemId: ids[0], status: "stale" },
      { itemId: ids[1], status: "applied" },
    ]);
    const [quest] = await owner<{ points: number }>("SELECT points FROM quest WHERE id = $1", [
      f.quest,
    ]);
    expect(quest?.points).toBe(120);
  });

  it("keeps going after a refused item and records the builder's reason", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      { op: "delete", target: "category", targetId: f.category, body: {} },
      { op: "edit", target: "reward", targetId: f.reward, body: { stock: 1, price: 12 } },
    ]);
    const opened = await open(f.event, set);
    const ids = opened.items.map((item) => item.id);
    const applied = await apply(f.event, set, ids);
    expect(applied.json().results).toMatchObject([
      { itemId: ids[0], status: "failed", error: { code: "last_category" } },
      { itemId: ids[1], status: "applied" },
    ]);
    const after = await open(f.event, set);
    expect(after.items.map((item) => item.state)).toEqual(["failed", "applied"]);
    expect(after.items[0]?.problem?.code).toBe("last_category");
    expect(after.status).toBe("applied");
  });

  it("sends a points edit through the live-edit door, and refuses it without a choice", async () => {
    const f = await newEvent("live");
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ('set_player') RETURNING id",
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, f.event, player?.id],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'code', $5) RETURNING id`,
      [organizer, f.event, enrolled?.id, f.quest, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', 100, 100, $4, $5, 'player')`,
      [organizer, f.event, enrolled?.id, done?.id, f.quest],
    );
    const set = await make(f.event, [
      { op: "edit", target: "quest", targetId: f.quest, body: { points: 150 } },
    ]);
    const first = (await open(f.event, set)).items[0]?.id as string;
    const refused = await apply(f.event, set, [first]);
    expect(refused.json().results).toMatchObject([
      { status: "failed", error: { code: "apply_required" } },
    ]);
    const retried = await make(f.event, [
      { op: "edit", target: "quest", targetId: f.quest, body: { points: 150, apply: "past" } },
    ]);
    const item = (await open(f.event, retried)).items[0]?.id as string;
    const ran = await apply(f.event, retried, [item]);
    expect(ran.json().results).toMatchObject([{ status: "applied" }]);
    const adjusts = await owner<{ score_delta: number }>(
      "SELECT score_delta FROM ledger_entry WHERE event_id = $1 AND kind = 'adjust'",
      [f.event],
    );
    expect(adjusts.map((row) => Number(row.score_delta))).toEqual([50]);
    const [standing] = await owner<{ score: string }>(
      "SELECT score FROM enrollment WHERE id = $1",
      [enrolled?.id],
    );
    expect(standing?.score).toBe("150");
  });

  it("closes a set without applying anything, and refuses a second close or a late apply", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      { op: "delete", target: "quest", targetId: f.quest, body: {} },
    ]);
    const item = (await open(f.event, set)).items[0]?.id as string;
    const closed = await call("POST", `/events/${f.event}/change-sets/${set}/close`);
    expect(closed.json()).toEqual({ changeSet: { id: set, status: "closed" } });
    expect(await questTitles(f.event)).toEqual(["Stage"]);
    const again = await call("POST", `/events/${f.event}/change-sets/${set}/close`);
    expect([again.statusCode, again.json().code]).toEqual([409, "change_set_finished"]);
    const late = await apply(f.event, set, [item]);
    expect([late.statusCode, late.json().code]).toEqual([409, "change_set_finished"]);
  });

  it("applies an add once when two applies of the same set arrive together", async () => {
    const f = await newEvent();
    const set = await make(f.event, [
      {
        op: "add",
        target: "quest",
        body: { categoryId: f.category, type: "scan_qr", title: { en: "Once" }, points: 1 },
      },
    ]);
    const item = (await open(f.event, set)).items[0]?.id as string;
    const both = await Promise.all([apply(f.event, set, [item]), apply(f.event, set, [item])]);
    expect(both.map((one) => one.statusCode).toSorted()).toContain(200);
    expect((await questTitles(f.event)).filter((title) => title === "Once")).toHaveLength(1);
  });

  it("never reaches a target of another organizer, as a review or as an apply", async () => {
    const mine = await newEvent();
    const [rival] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('rival-targets', 'rival-targets') RETURNING id",
    );
    const [rivalEvent] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, 'RIVT1', 'Rival Fest', 'draft', now() + interval '1 day', now() + interval '2 days') RETURNING id`,
      [rival?.id],
    );
    const [rivalCategory] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 LIMIT 1",
      [rivalEvent?.id],
    );
    const [rivalQuest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Rival stage', 100, '{"code":"XYZ"}') RETURNING id`,
      [rivalEvent?.id, rivalCategory?.id],
    );
    const set = await make(mine.event, [
      { op: "edit", target: "quest", targetId: rivalQuest?.id, body: { points: 1 } },
      { op: "delete", target: "category", targetId: rivalCategory?.id, body: {} },
    ]);
    const opened = await open(mine.event, set);
    expect(opened.items.map((item) => [item.state, item.problem?.code])).toEqual([
      ["invalid", "not_found"],
      ["invalid", "not_found"],
    ]);
    const applied = await apply(
      mine.event,
      set,
      opened.items.map((item) => item.id),
    );
    expect(applied.json().results).toMatchObject([
      { status: "failed", error: { code: "not_found" } },
      { status: "failed", error: { code: "not_found" } },
    ]);
    const [stored] = await owner<{ points: number }>("SELECT points FROM quest WHERE id = $1", [
      rivalQuest?.id,
    ]);
    expect(stored?.points).toBe(100);
  });

  it("refuses a malformed set before anything is stored", async () => {
    const f = await newEvent();
    const tooMany = Array.from({ length: 101 }, () => ({
      op: "delete",
      target: "quest",
      targetId: randomUUID(),
      body: {},
    }));
    const bodies = [
      { items: [] },
      { items: tooMany },
      { items: [{ op: "edit", target: "quest", body: {} }] },
      { items: [{ op: "add", target: "quest", targetId: randomUUID(), body: {} }] },
      { items: [{ op: "add", target: "event", body: {} }] },
      { items: [{ op: "add", target: "quest", body: { note: "x".repeat(17_000) } }] },
    ];
    for (const body of bodies) {
      const refused = await call("POST", `/events/${f.event}/change-sets`, body);
      expect([refused.statusCode, refused.json().code]).toEqual([400, "invalid_request"]);
    }
    expect(await owner("SELECT 1 FROM change_set WHERE event_id = $1", [f.event])).toHaveLength(0);
  });

  it("refuses an ended event, an unknown item id, and a 21st open set", async () => {
    const ended = await newEvent();
    await owner("UPDATE event SET status = 'ended' WHERE id = $1", [ended.event]);
    const refused = await call("POST", `/events/${ended.event}/change-sets`, {
      items: [{ op: "delete", target: "quest", targetId: ended.quest, body: {} }],
    });
    expect([refused.statusCode, refused.json().code]).toEqual([409, "event_closed"]);
    const f = await newEvent();
    const item = { op: "delete", target: "quest", targetId: f.quest, body: {} };
    const set = await make(f.event, [item]);
    const wrong = await apply(f.event, set, [randomUUID()]);
    expect([wrong.statusCode, wrong.json().code]).toEqual([422, "invalid_change_set"]);
    for (let i = 1; i < 20; i += 1) {
      await make(f.event, [item]);
    }
    const over = await call("POST", `/events/${f.event}/change-sets`, { items: [item] });
    expect([over.statusCode, over.json().code]).toEqual([409, "limit_reached"]);
  });

  it("keeps sets to the caller's organizer, event limit and session", async () => {
    const f = await newEvent();
    const other = await newEvent();
    const set = await make(f.event, [
      { op: "edit", target: "quest", targetId: f.quest, body: { points: 5 } },
    ]);
    const editor = await createStaff(db.owner, { email: "editor@change-sets.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [other.event]],
    );
    const editorCookie = await signInFully(test, "editor@change-sets.test");
    const rivalOrganizer = (
      await owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-sets', 'rival-sets') RETURNING id",
      )
    )[0]?.id as string;
    const rival = await createStaff(db.owner, { email: "rival@change-sets.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rivalOrganizer, rival],
    );
    const rivalCookie = await signInFully(test, "rival@change-sets.test");
    const item = (await open(f.event, set)).items[0]?.id as string;
    const paths: [string, "GET" | "POST", object?][] = [
      [`/events/${f.event}/change-sets`, "GET"],
      [
        `/events/${f.event}/change-sets`,
        "POST",
        { items: [{ op: "delete", target: "quest", targetId: f.quest, body: {} }] },
      ],
      [`/events/${f.event}/change-sets/${set}`, "GET"],
      [`/events/${f.event}/change-sets/${set}/apply`, "POST", { itemIds: [item] }],
      [`/events/${f.event}/change-sets/${set}/close`, "POST"],
    ];
    for (const [url, method, payload] of paths) {
      const outside = await call(method, url, payload, { cookie: editorCookie });
      expect([outside.statusCode, outside.json().code], url).toEqual([404, "not_found"]);
      const foreign = await call(method, url, payload, {
        cookie: rivalCookie,
        organizerId: rivalOrganizer,
      });
      expect([foreign.statusCode, foreign.json().code], url).toEqual([404, "not_found"]);
      const asked = await test.app.inject({
        method,
        url: `/v1/organizers/${organizer}${url}`,
        headers: withSession("", method === "GET" ? {} : { "idempotency-key": randomUUID() }),
      });
      expect(asked.statusCode, url).toBe(401);
    }
    const crossed = await call("GET", `/events/${other.event}/change-sets/${set}`);
    expect(crossed.statusCode).toBe(404);
    const allowed = await call("GET", `/events/${other.event}/change-sets`, undefined, {
      cookie: editorCookie,
    });
    expect(allowed.statusCode).toBe(200);
    expect(await owner("SELECT 1 FROM quest WHERE id = $1 AND points = 5", [f.quest])).toHaveLength(
      0,
    );
  });
});
