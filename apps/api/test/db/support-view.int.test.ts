import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * The view kind of a support grant in the database (T-712, migration 0135, ADR-520, ADR-521, ADR-523): honoured only in
 * read-only transactions, so a lost read-only mark runs as nobody; every allowed read logged once a minute per route.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("support view grants (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let admin: string;
  let otherAdmin: string;
  let eventA2: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    const made = await db.owner.query<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role)
       VALUES ('viewer@questify.test', 'h', 'admin'), ('other@questify.test', 'h', 'admin') RETURNING id`,
    );
    admin = made.rows[0]?.id ?? "";
    otherAdmin = made.rows[1]?.id ?? "";
    const second = await db.owner.query<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, 'VIEW2', 'Second Fest', 'live', 'private', now() - interval '1 hour', now() + interval '3 days')
       RETURNING id`,
      [ids.orgA],
    );
    eventA2 = second.rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) => withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);
  const adminSeat = (who = admin): RequestContext => ({ isAdmin: true, staffUserId: who });
  const seat = (readOnly: boolean, who = admin): RequestContext => ({
    organizerId: ids.orgA,
    staffUserId: who,
    ...(readOnly ? { readOnly: true } : {}),
  });
  const reason = "Organizer asked why the board looks wrong";
  const open = async (kind: string, event = ids.eventA, who = admin) =>
    (
      await as<{ grant_id: string; kind: string }>(
        adminSeat(who),
        "SELECT * FROM support_open($1, $2, $3, $4)",
        [event, kind, reason, randomUUID()],
      )
    )[0]?.grant_id ?? "";
  const context = async (readOnly: boolean, who = admin) =>
    (
      await as<{ org: string | null; scope: string[] | null }>(
        seat(readOnly, who),
        "SELECT app_organizer_id() AS org, app_event_scope() AS scope",
      )
    )[0];
  const closeAll = () =>
    owner(
      "UPDATE support_grant SET closed_at = now(), close_kind = 'admin' WHERE closed_at IS NULL",
    );
  const log = (grant: string, route: string, pathIds: unknown, who = admin) =>
    as<{ logged: boolean }>(
      { staffUserId: who },
      "SELECT support_view_log($1, $2, $3::jsonb, $4) AS logged",
      [grant, route, JSON.stringify(pathIds), randomUUID()],
    );
  const viewed = (grant: string) =>
    owner<{ after: unknown; actor_type: string; event_id: string }>(
      "SELECT after, actor_type, event_id FROM audit_log WHERE action = 'support.viewed' AND target_id = $1 ORDER BY id",
      [grant],
    );

  it("names the kind on every grant: no default, only view or edit, recorded in the audit entry", async () => {
    const [column] = await owner<{ default: string | null }>(
      `SELECT column_default AS default FROM information_schema.columns
       WHERE table_name = 'support_grant' AND column_name = 'kind'`,
    );
    expect(column?.default).toBeNull();
    await expect(open("look")).rejects.toMatchObject({ code: "SU400" });
    const grant = await open("view");
    const [entry] = await owner(
      "SELECT after FROM audit_log WHERE action = 'support.opened' AND target_id = $1",
      [grant],
    );
    expect(entry).toMatchObject({ after: { kind: "view", reason } });
    await closeAll();
  });

  it("opens the organizer only in a read-only transaction under a view grant", async () => {
    await open("view");
    expect(await context(false)).toEqual({ org: null, scope: [] });
    expect(await context(true)).toEqual({ org: ids.orgA, scope: [ids.eventA] });
    const tickets = "SELECT * FROM event_tickets($1, 'open', NULL, NULL, 10)";
    await expect(as(seat(false), tickets, [ids.eventA])).rejects.toMatchObject({ code: "AN404" });
    expect(await as(seat(true), tickets, [ids.eventA])).toEqual([]);
    await expect(as(seat(true), tickets, [eventA2])).rejects.toMatchObject({ code: "AN404" });
    await expect(
      as(seat(true), "SELECT mark_ranking_repair($1)", [ids.eventA]),
    ).rejects.toMatchObject({ code: "25006" });
    await expect(
      as(
        seat(true),
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'VIEW9', 'New') RETURNING id",
        [ids.orgA],
      ),
    ).rejects.toMatchObject({ code: "25006" });
    await closeAll();
  });

  it("keeps an edit grant as before, in both kinds of transaction", async () => {
    await open("edit");
    expect(await context(false)).toEqual({ org: ids.orgA, scope: [ids.eventA] });
    expect(await context(true)).toEqual({ org: ids.orgA, scope: [ids.eventA] });
    await closeAll();
  });

  it("mixes kinds per event: the edit event read-write, both read-only", async () => {
    await open("view", ids.eventA);
    await open("edit", eventA2);
    expect(await context(false)).toEqual({ org: ids.orgA, scope: [eventA2] });
    expect((await context(true))?.scope?.toSorted()).toEqual([ids.eventA, eventA2].toSorted());
    await closeAll();
  });

  it("switching kind replaces the grant, and both kinds count toward the hourly 20", async () => {
    const view = await open("view");
    const edit = await open("edit");
    const live = await owner<{ id: string; kind: string }>(
      "SELECT id, kind FROM support_grant WHERE admin_id = $1 AND closed_at IS NULL",
      [admin],
    );
    expect(live).toEqual([{ id: edit, kind: "edit" }]);
    expect(view).not.toBe(edit);
    await owner(
      `INSERT INTO support_grant (admin_id, organizer_id, event_id, kind, reason, opened_at, expires_at, closed_at,
                                  close_kind)
       SELECT $1, $2, $3, CASE WHEN n % 2 = 0 THEN 'view' ELSE 'edit' END, 'An earlier support visit',
              now() - interval '5 minutes', now() + interval '10 minutes', now(), 'admin'
       FROM generate_series(1, 20) n`,
      [otherAdmin, ids.orgA, eventA2],
    );
    await expect(open("view", ids.eventA, otherAdmin)).rejects.toMatchObject({ code: "SG429" });
    await closeAll();
  });

  it("opens nothing once expired, closed, or for a disabled or demoted admin", async () => {
    const grant = await open("view");
    await owner(
      `UPDATE support_grant SET opened_at = opened_at - interval '20 minutes',
                                expires_at = expires_at - interval '20 minutes' WHERE id = $1`,
      [grant],
    );
    expect(await context(true)).toEqual({ org: null, scope: [] });
    await expect(log(grant, "GET /events/:eventId", {})).rejects.toMatchObject({ code: "SG404" });
    await open("view");
    await owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [admin]);
    expect(await context(true)).toEqual({ org: null, scope: [] });
    await owner("UPDATE staff_user SET status = 'active', platform_role = 'none' WHERE id = $1", [
      admin,
    ]);
    expect(await context(true)).toEqual({ org: null, scope: [] });
    await owner("UPDATE staff_user SET platform_role = 'admin' WHERE id = $1", [admin]);
    await closeAll();
    expect(await context(true)).toEqual({ org: null, scope: [] });
  });

  it("logs a read with the route pattern and ids only, as the admin on the grant's event", async () => {
    const grant = await open("view");
    const enrollment = randomUUID();
    expect(
      await log(grant, "GET /events/:eventId/players/:enrollmentId/entries", {
        enrollmentId: enrollment,
      }),
    ).toEqual([{ logged: true }]);
    const [row] = await viewed(grant);
    expect(row).toEqual({
      after: {
        route: "GET /events/:eventId/players/:enrollmentId/entries",
        ids: { enrollmentId: enrollment },
      },
      actor_type: "admin",
      event_id: ids.eventA,
    });
    expect(JSON.stringify(row)).not.toMatch(/@|questify\.test/);
    await closeAll();
  });

  it("refuses another admin's grant, an edit grant, a bad route, a query string and bad ids", async () => {
    const grant = await open("view");
    await expect(log(grant, "GET /events", {}, otherAdmin)).rejects.toMatchObject({
      code: "SG404",
    });
    for (const route of [
      "POST /events",
      "GET /events?q=0555",
      "GET events",
      "GET /events/../x",
      `GET /${"a".repeat(201)}`,
    ]) {
      await expect(log(grant, route, {}), route).rejects.toMatchObject({ code: "QA422" });
    }
    const id = randomUUID();
    for (const bad of [
      [],
      "x",
      { enrollmentId: "Sara" },
      { enrollmentId: 7 },
      { "a b": id },
      { a: id, b: id, c: id, d: id, e: id },
    ]) {
      await expect(log(grant, "GET /events", bad), JSON.stringify(bad)).rejects.toMatchObject({
        code: "QA422",
      });
    }
    await closeAll();
    const edit = await open("edit");
    await expect(log(edit, "GET /events", {})).rejects.toMatchObject({ code: "SG404" });
    await closeAll();
  });

  it("coalesces the same route and ids within 60 seconds, and logs again after", async () => {
    const grant = await open("view");
    const route = "GET /events/:eventId/quests";
    expect(await log(grant, route, {})).toEqual([{ logged: true }]);
    expect(await log(grant, route, {})).toEqual([{ logged: false }]);
    expect(await log(grant, "GET /events/:eventId/rewards", {})).toEqual([{ logged: true }]);
    expect(await viewed(grant)).toHaveLength(2);
    const other = await open("view", eventA2);
    await owner(
      `INSERT INTO audit_log (at, actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after)
       VALUES (now() - interval '61 seconds', 'admin', $1, $2, $3, 'support.viewed', 'support_grant', $4, $5)`,
      [admin, ids.orgA, eventA2, other, JSON.stringify({ route, ids: {} })],
    );
    expect(await log(other, route, {})).toEqual([{ logged: true }]);
    expect(await viewed(other)).toHaveLength(2);
    await closeAll();
  });

  it("writes one row when two identical reads race", async () => {
    const grant = await open("view");
    const second = new Client({ connectionString: db.appUrl });
    await second.connect();
    try {
      const route = "GET /events/:eventId/players";
      const call = (client: Client) =>
        as(
          { staffUserId: admin },
          "SELECT support_view_log($1, $2, '{}'::jsonb, NULL)",
          [grant, route],
          client,
        );
      await Promise.all([call(db.app), call(second)]);
      expect(await viewed(grant)).toHaveLength(1);
    } finally {
      await second.end();
      await closeAll();
    }
  });

  it("lists the kind to the admin and on the console's event page", async () => {
    const grant = await open("view");
    expect(
      await as({ staffUserId: admin }, "SELECT grant_id, kind FROM own_support_grants()"),
    ).toEqual([{ grant_id: grant, kind: "view" }]);
    expect(
      await as(adminSeat(), "SELECT id, kind FROM event_support_grants($1)", [ids.eventA]),
    ).toEqual([{ id: grant, kind: "view" }]);
    await closeAll();
  });
});
