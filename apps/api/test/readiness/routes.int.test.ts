import { randomUUID } from "node:crypto";
import { readinessSchema, readinessSoonSchema } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInConsole,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * The go-live checklist over HTTP (T-618, FR-1845): the owner's read of one event and the console's list of events that
 * start soon. Read only, the same items on both sides, and blocks nothing.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("readiness over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let ownerCookie = "";
  let adminCookie = "";
  let counter = 0;

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (startsInDays = 1): Promise<string> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, name_ar, status, starts_at, ends_at)
       VALUES ($1, $2, 'Ready Fest', 'مهرجان', 'scheduled', now() + make_interval(days => $3),
               now() + make_interval(days => $3 + 1)) RETURNING id`,
      [organizer, `RDY${counter}`, startsInDays],
    );
    const id = row?.id ?? "";
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [id]);
    return id;
  };
  const read = (ev: string, cookie: string | null = ownerCookie, org = organizer) =>
    test.app.inject({
      method: "GET",
      url: `/v1/organizers/${org}/events/${ev}/readiness`,
      ...(cookie === null
        ? {}
        : { headers: withSession(cookie, {}, `/v1/organizers/${org}/events/${ev}/readiness`) }),
    });
  const list = (cookie: string | null = adminCookie) =>
    test.app.inject({
      method: "GET",
      url: "/v1/admin/readiness",
      ...(cookie === null ? {} : { headers: withSession(cookie, {}, "/v1/admin/readiness") }),
    });

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    organizer =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('ready-org', 'ready-org') RETURNING id",
        )
      ).rows[0]?.id ?? "";
    const ownerId = await createStaff(db.owner, { email: "owner@ready.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [organizer, ownerId],
    );
    ownerCookie = await signInFully(test, "owner@ready.test");
    await createStaff(db.owner, { email: "root@ready.test", admin: true });
    adminCookie = await signInConsole(test, "root@ready.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  it("answers the checklist of a bare event, never cached, with the rehearsal missing and nothing blocking it", async () => {
    const answer = await read(await newEvent());
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    const body = readinessSchema.parse(answer.json());
    expect(body.status).toBe("scheduled");
    const lines = Object.fromEntries(body.items.map((item) => [item.key, item.line]));
    expect(lines).toMatchObject({
      dates: "dates.set",
      activation: "activation.none",
      quests: "quests.none",
      rewards: "rewards.none",
      join: "join.open",
      rules: "rules.missing",
      rehearsal: "rehearsal.missing",
      branding: "branding.default",
      setup: "setup.notStarted",
    });
    expect(body.counts).toEqual({ done: 2, warning: 5, blocking: 2 });
  });

  it("reads what the pages wrote: a playable quest, an item reward and a desk place", async () => {
    const ev = await newEvent();
    await owner(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, verification)
       SELECT $1, id, 'scan_qr', 'Station', 10, 1, true, ARRAY['quest_qr'] FROM category WHERE event_id = $1 LIMIT 1`,
      [ev],
    );
    await owner(
      `INSERT INTO reward (organizer_id, event_id, kind, name_en, price, stock_total)
       VALUES ($1, $2, 'item', 'Cap', 10, 5)`,
      [organizer, ev],
    );
    const before = readinessSchema.parse((await read(ev)).json());
    expect(before.items.find((item) => item.key === "desk")).toMatchObject({
      line: "desk.missing",
      status: "blocking",
    });
    expect(before.items.find((item) => item.key === "quests")).toMatchObject({
      line: "quests.ready",
      count: 1,
    });
    await owner("UPDATE event SET desk_location_en = 'Hall B' WHERE id = $1", [ev]);
    const after = readinessSchema.parse((await read(ev)).json());
    expect(after.items.find((item) => item.key === "desk")?.line).toBe("desk.set");
  });

  it("writes nothing", async () => {
    const ev = await newEvent();
    const before = await owner("SELECT * FROM event WHERE id = $1", [ev]);
    await read(ev);
    await read(ev);
    expect(await owner("SELECT * FROM event WHERE id = $1", [ev])).toEqual(before);
    const [audits] = await owner<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE event_id = $1",
      [ev],
    );
    expect(Number(audits?.n)).toBe(0);
  });

  it("refuses a stranger, another organizer's team, a bad id and an unknown event", async () => {
    const ev = await newEvent();
    const rival = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('rival-ready', 'rival-ready') RETURNING id",
      )
    ).rows[0]?.id as string;
    const rivalStaff = await createStaff(db.owner, { email: "owner@rival-ready.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [rival, rivalStaff],
    );
    const rivalCookie = await signInFully(test, "owner@rival-ready.test");
    expect((await read(ev, null)).statusCode).toBe(401);
    for (const [cookie, org, target] of [
      [rivalCookie, rival, ev],
      [rivalCookie, organizer, ev],
      [ownerCookie, rival, ev],
      [ownerCookie, organizer, randomUUID()],
    ] as const) {
      const refused = await read(target, cookie, org);
      expect([refused.statusCode, refused.json().code]).toEqual([404, "not_found"]);
    }
    expect((await read("not-a-uuid")).statusCode).toBe(400);
  });

  it("keeps an editor to the events in their limit", async () => {
    const inside = await newEvent();
    const outside = await newEvent();
    const editor = await createStaff(db.owner, { email: "editor@ready.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, editor, [inside]],
    );
    const cookie = await signInFully(test, "editor@ready.test");
    expect((await read(inside, cookie)).statusCode).toBe(200);
    expect((await read(outside, cookie)).statusCode).toBe(404);
  });

  it("lists the events starting soon to a platform admin with the same checklist the owner reads", async () => {
    const soon = await newEvent(2);
    const far = await newEvent(40);
    const answer = await list();
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("no-store");
    const body = readinessSoonSchema.parse(answer.json());
    const found = body.events.find((entry) => entry.id === soon);
    expect(found?.organizer).toEqual({ id: organizer, name: "ready-org" });
    expect(found?.name).toEqual({ ar: "مهرجان", en: "Ready Fest" });
    expect(found?.readiness).toEqual(readinessSchema.parse((await read(soon)).json()));
    expect(body.events.map((entry) => entry.id)).not.toContain(far);
  });

  it("gives the console list to nobody but an active platform admin", async () => {
    expect((await list(null)).statusCode).toBe(401);
    expect((await list(ownerCookie)).statusCode).toBe(404);
  });
});
