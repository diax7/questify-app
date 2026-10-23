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

type Category = {
  id: string;
  orderMode: string;
  opensAt: string | null;
  unlockAfter: string | null;
  completionBonus: number;
};

const EVENT = {
  name: { en: "Rules Meetup" },
  timezone: "Asia/Riyadh",
  startsAt: "2030-11-01T09:00",
  endsAt: "2030-11-01T17:00",
};
const key = () => ({ "idempotency-key": `k-${Math.random()}` });

const codeOf = (response: LightMyRequestResponse) => [
  response.statusCode,
  response.json<{ code?: string }>().code,
  response.json<{ details?: unknown }>().details,
];
const field = (name: string) => [422, "invalid_category", { field: name }];

/** A category's rules in the builder (T-304): set, read back, audited, and each refusal's answer. */
describe.skipIf(TEST_DATABASE_URL === undefined)("category rules in the builder (T-304)", () => {
  let db: TestDatabase;
  let test: TestApp;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    cookie: string,
    payload?: object,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, headers),
      ...(payload === undefined ? {} : { payload }),
    });

  const newEvent = async () => {
    counter += 1;
    const [org] = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Rules', $1) RETURNING id",
      [`rules-${counter}`],
    );
    const orgId = org?.id ?? "";
    const email = `owner${counter}@rules.test`;
    const staff = await createStaff(db.owner, { email });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [orgId, staff],
    );
    const cookie = await signInFully(test, email);
    const made = await call("POST", `/v1/organizers/${orgId}/events`, cookie, EVENT, key());
    const eventId = made.json<{ event: { id: string } }>().event.id;
    const base = `/v1/organizers/${orgId}/events/${eventId}`;
    const add = async (en: string) =>
      (await call("POST", `${base}/categories`, cookie, { name: { en } }, key())).json<{
        category: Category;
      }>().category;
    const patch = (id: string, body: object) =>
      call("PATCH", `${base}/categories/${id}`, cookie, body);
    return { eventId, base, cookie, add, patch };
  };

  it("sets the order, the opening time in the event's zone, the unlock and the bonus, and audits them", async () => {
    const s = await newEvent();
    const one = await s.add("Chapter 1");
    const two = await s.add("Chapter 2");
    expect(one).toMatchObject({
      orderMode: "any",
      opensAt: null,
      unlockAfter: null,
      completionBonus: 0,
    });
    const saved = await s.patch(two.id, {
      orderMode: "in_order",
      opensAt: "2030-11-01T16:00",
      unlockAfter: one.id,
      completionBonus: 250,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ category: Category }>().category).toMatchObject({
      orderMode: "in_order",
      opensAt: "2030-11-01T13:00:00.000Z",
      unlockAfter: one.id,
      completionBonus: 250,
    });
    const [audit] = await owner<{ after: Record<string, unknown> }>(
      "SELECT after FROM audit_log WHERE target_id = $1 AND action = 'category.update'",
      [two.id],
    );
    expect(audit?.after).toEqual({
      orderMode: "in_order",
      opensAt: "2030-11-01T13:00:00.000Z",
      unlockAfter: one.id,
      completionBonus: 250,
    });
    const kept = await s.patch(two.id, { name: { en: "Chapter Two" } });
    expect(kept.json<{ category: Category }>().category).toMatchObject({
      orderMode: "in_order",
      unlockAfter: one.id,
      completionBonus: 250,
    });
    const cleared = await s.patch(two.id, { opensAt: null, unlockAfter: null, orderMode: "any" });
    expect(cleared.json<{ category: Category }>().category).toMatchObject({
      orderMode: "any",
      opensAt: null,
      unlockAfter: null,
    });
  });

  it("refuses an unlock on itself, in another event or in a circle, and bad values", async () => {
    const s = await newEvent();
    const one = await s.add("One");
    const two = await s.add("Two");
    const other = await newEvent();
    const elsewhere = await other.add("Elsewhere");
    await s.patch(two.id, { unlockAfter: one.id });
    expect(codeOf(await s.patch(one.id, { unlockAfter: one.id }))).toEqual(field("unlockAfter"));
    expect(codeOf(await s.patch(one.id, { unlockAfter: elsewhere.id }))).toEqual(
      field("unlockAfter"),
    );
    expect(codeOf(await s.patch(one.id, { unlockAfter: two.id }))).toEqual(field("unlockAfter"));
    expect(codeOf(await s.patch(one.id, { opensAt: "2030-02-30T10:00" }))).toEqual(
      field("opensAt"),
    );
    for (const body of [
      { completionBonus: -1 },
      { completionBonus: 100_001 },
      { completionBonus: 1.5 },
      { orderMode: "random" },
      { opensAt: "tomorrow" },
    ]) {
      expect((await s.patch(one.id, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("refuses deleting a category another unlocks after, naming it", async () => {
    const s = await newEvent();
    const one = await s.add("One");
    const two = await s.add("Two");
    await s.patch(two.id, { unlockAfter: one.id });
    expect(codeOf(await call("DELETE", `${s.base}/categories/${one.id}`, s.cookie))).toEqual([
      409,
      "category_in_use",
      { categories: [{ ar: null, en: "Two" }] },
    ]);
    await s.patch(two.id, { unlockAfter: null });
    expect((await call("DELETE", `${s.base}/categories/${one.id}`, s.cookie)).statusCode).toBe(204);
  });

  it("refuses deleting a category whose bonus was paid, as one with completions", async () => {
    const s = await newEvent();
    const one = await s.add("One");
    const [general] = await owner<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 AND id <> $2",
      [s.eventId, one.id],
    );
    await owner("UPDATE category SET completion_bonus = 20 WHERE id = $1", [one.id]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, 'enter_code', 'Code', 10, '{"code": "ABC"}') RETURNING id`,
      [s.eventId, one.id],
    );
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`rules_${counter}`],
    );
    await owner(
      "UPDATE event SET status = 'live', starts_at = now() - interval '1 hour' WHERE id = $1",
      [s.eventId],
    );
    await owner(
      `INSERT INTO enrollment (organizer_id, event_id, player_id)
       SELECT organizer_id, id, $2 FROM event WHERE id = $1`,
      [s.eventId, player?.id],
    );
    await db.owner.query("BEGIN");
    await db.owner.query("SELECT set_config('app.player_id', $1, true)", [player?.id]);
    await db.owner.query("SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', 'k1', NULL)", [
      quest?.id,
    ]);
    await db.owner.query("COMMIT");
    await owner("UPDATE quest SET category_id = $2 WHERE id = $1", [quest?.id, general?.id]);
    await owner(
      "UPDATE event SET status = 'draft', starts_at = now() + interval '1 day' WHERE id = $1",
      [s.eventId],
    );
    expect(codeOf(await call("DELETE", `${s.base}/categories/${one.id}`, s.cookie))).toEqual([
      409,
      "has_completions",
      {},
    ]);
  });
});
