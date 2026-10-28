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
 * The hidden-category hint over HTTP (T-501g, migration 0080): the count behind the confirmation, Send once per
 * Idempotency-Key, and the refusals with their codes. The recipients and the reveal are the database suite's
 * (test/db/push-hint.int.test.ts); this one proves the routes and who may press.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the hidden-category hint over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let other = "";
  let ownerCookie = "";
  let limitedCookie = "";
  let foreignCookie = "";
  let counter = 0;
  let scoped = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db, false);
    const orgs = await owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('hint-org', 'hint-org'), ('hint-other', 'hint-other') RETURNING id",
    );
    organizer = orgs[0]?.id ?? "";
    other = orgs[1]?.id ?? "";
    scoped = await newEvent("live");
    const ownerId = await createStaff(db.owner, { email: "owner@hint.test" });
    const limitedId = await createStaff(db.owner, { email: "limited@hint.test" });
    const foreignId = await createStaff(db.owner, { email: "foreign@hint.test" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
      [organizer, ownerId, other, foreignId],
    );
    // An editor limited to one other event: this event's hint is not theirs to send.
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [organizer, limitedId, [scoped]],
    );
    ownerCookie = await signInFully(test, "owner@hint.test");
    limitedCookie = await signInFully(test, "limited@hint.test");
    foreignCookie = await signInFully(test, "foreign@hint.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const newEvent = async (phase: "live" | "scheduled"): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Hint Fest', $3, now() + $4::interval, now() + interval '2 days') RETURNING id`,
      [organizer, `HINT${counter}`, phase, phase === "live" ? "-1 hour" : "1 day"],
    );
    return event?.id ?? "";
  };
  const newCategory = async (event: string, hidden = true): Promise<string> => {
    const [made] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en, hidden) VALUES ($1, 'Secret garden', $2) RETURNING id",
      [event, hidden],
    );
    return made?.id ?? "";
  };
  const enrol = async (event: string): Promise<void> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`hint_http_${counter}`],
    );
    await owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
      organizer,
      event,
      player?.id,
    ]);
  };
  const hint = (
    method: "GET" | "POST",
    event: string,
    category: string,
    options: Readonly<{ cookie?: string; key?: string | null; org?: string }> = {},
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${options.org ?? organizer}/events/${event}/categories/${category}/hint`,
      headers: withSession(
        options.cookie ?? ownerCookie,
        options.key === null ? {} : { "idempotency-key": options.key ?? randomUUID() },
      ),
    });

  it("counts the members who would be told, and sends once per Idempotency-Key", async () => {
    const event = await newEvent("live");
    const category = await newCategory(event);
    await enrol(event);
    await enrol(event);
    const counted = await hint("GET", event, category);
    expect([counted.statusCode, counted.json()]).toEqual([200, { members: 2, pending: false }]);

    const key = randomUUID();
    const first = await hint("POST", event, category, { key });
    expect([first.statusCode, first.json()]).toEqual([200, { replayed: false }]);
    const again = await hint("POST", event, category, { key });
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual({ replayed: false });
    const notices = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM notice WHERE event_id = $1 AND kind = 'category_hint'",
      [event],
    );
    expect(notices[0]?.n).toBe(1);

    // A different press while the first is still being delivered waits.
    const second = await hint("POST", event, category);
    expect([second.statusCode, second.json().code]).toEqual([409, "hint_in_progress"]);
    expect((await hint("GET", event, category)).json()).toEqual({ members: 2, pending: true });
    const audited = await owner<{ n: number; actor_type: string }>(
      `SELECT count(*)::int AS n, min(actor_type) AS actor_type FROM audit_log
       WHERE event_id = $1 AND action = 'category.hint_send'`,
      [event],
    );
    expect(audited[0]).toEqual({ n: 1, actor_type: "staff" });
  });

  it("refuses a press without an Idempotency-Key, a shown category, another event's category and an event not live", async () => {
    const live = await newEvent("live");
    const hidden = await newCategory(live);
    const shown = await newCategory(live, false);
    const missing = await hint("POST", live, hidden, { key: null });
    expect([missing.statusCode, missing.json().code]).toEqual([400, "idempotency_key_required"]);
    const notHidden = await hint("POST", live, shown);
    expect([notHidden.statusCode, notHidden.json().code]).toEqual([422, "not_hidden"]);
    expect((await hint("GET", live, shown)).statusCode).toBe(422);
    const elsewhere = await newCategory(await newEvent("live"));
    expect((await hint("POST", live, elsewhere)).statusCode).toBe(404);
    expect((await hint("POST", live, randomUUID())).statusCode).toBe(404);

    const scheduled = await newEvent("scheduled");
    const early = await newCategory(scheduled);
    const notLive = await hint("POST", scheduled, early);
    expect([notLive.statusCode, notLive.json().code]).toEqual([409, "event_not_live"]);
    expect((await hint("GET", scheduled, early)).statusCode).toBe(409);
    const none = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM notice WHERE kind = 'category_hint' AND event_id = ANY ($1)",
      [[live, scheduled]],
    );
    expect(none[0]?.n).toBe(0);
  });

  it("answers 404 to an editor outside the event's limit, and to another organizer's owner", async () => {
    const event = await newEvent("live");
    const category = await newCategory(event);
    const outside = await hint("POST", event, category, { cookie: limitedCookie });
    expect(outside.statusCode).toBe(404);
    expect((await hint("GET", event, category, { cookie: limitedCookie })).statusCode).toBe(404);
    // The editor may press for the event their limit names.
    const inside = await newCategory(scoped);
    expect((await hint("POST", scoped, inside, { cookie: limitedCookie })).statusCode).toBe(200);
    // Another organizer's owner is no member of this organizer: refused before the database.
    for (const method of ["GET", "POST"] as const) {
      const foreign = await hint(method, event, category, { cookie: foreignCookie });
      expect([403, 404], method).toContain(foreign.statusCode);
    }
    // And through their own organizer's path, this event is not found.
    const through = await hint("POST", event, category, { cookie: foreignCookie, org: other });
    expect(through.statusCode).toBe(404);
    const sent = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM notice WHERE kind = 'category_hint' AND event_id = $1",
      [event],
    );
    expect(sent[0]?.n).toBe(0);
  });

  it("reports a missing kind as 503 and writes nothing", async () => {
    const event = await newEvent("live");
    const category = await newCategory(event);
    const [kind] = await owner<Row>("SELECT * FROM notice_kind WHERE kind = 'category_hint'");
    await owner("DELETE FROM notice WHERE kind = 'category_hint'");
    await owner("DELETE FROM notice_kind WHERE kind = 'category_hint'");
    try {
      const refused = await hint("POST", event, category);
      expect([refused.statusCode, refused.json().code]).toEqual([503, "hint_unavailable"]);
    } finally {
      await owner(
        `INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl)
         VALUES ($1, $2, $3, $4, $5, $6, interval '2 hours')`,
        [kind?.["kind"], kind?.["class"], kind?.["topic"], kind?.["membership"], false, 1],
      );
    }
    const audited = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE event_id = $1 AND action = 'category.hint_send'",
      [event],
    );
    expect(audited[0]?.n).toBe(0);
  });
});
