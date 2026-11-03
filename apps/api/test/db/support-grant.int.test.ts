import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Support grants in the database (T-701, migration 0114, ADR-407, ADR-408): 15 minutes on one event, through the
 * organizer's own context as an editor of that event only, silent to the organizer, every staff entry stamped.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("support grants (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let admin: string;
  let otherAdmin: string;
  let eventA2: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    const made = await db.owner.query<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role)
       VALUES ('support@questify.test', 'h', 'admin'), ('second@questify.test', 'h', 'admin') RETURNING id`,
    );
    admin = made.rows[0]?.id ?? "";
    otherAdmin = made.rows[1]?.id ?? "";
    const second = await db.owner.query<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, 'NAJD2', 'Second Fest', 'live', 'private', now() - interval '1 hour', now() + interval '3 days')
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
  const supportSeat = (org = ids.orgA, who = admin): RequestContext => ({
    organizerId: org,
    staffUserId: who,
  });
  const reason = "Organizer asked for help with quests";
  type Opened = { grant_id: string; organizer_id: string; event_id: string; expires_at: Date };
  const open = async (event = ids.eventA, who = admin, client: Client = db.app) =>
    (
      await as<Opened>(
        adminSeat(who),
        "SELECT * FROM support_open($1, 'edit', $2, $3)",
        [event, reason, randomUUID()],
        client,
      )
    )[0];
  const close = (grant: string, who = admin) =>
    as(adminSeat(who), "SELECT support_close($1, $2)", [grant, randomUUID()]);
  const context = async (seat: RequestContext) =>
    (
      await as<{ org: string | null; scope: string[] | null }>(
        seat,
        "SELECT app_organizer_id() AS org, app_event_scope() AS scope",
      )
    )[0];
  const visibleEvents = async (seat: RequestContext) =>
    (await as<{ id: string }>(seat, "SELECT id FROM event ORDER BY id")).map((row) => row.id);
  const closeAll = () =>
    owner(
      "UPDATE support_grant SET closed_at = now(), close_kind = 'admin' WHERE closed_at IS NULL",
    );

  it("opens for 15 minutes on one event, audited as the admin with the reason", async () => {
    const grant = await open();
    expect(grant).toMatchObject({ organizer_id: ids.orgA, event_id: ids.eventA });
    const [row] = await owner<{ minutes: number }>(
      "SELECT extract(epoch FROM expires_at - opened_at) / 60 AS minutes FROM support_grant WHERE id = $1",
      [grant?.grant_id],
    );
    expect(Number(row?.minutes)).toBe(15);
    const [entry] = await owner(
      "SELECT actor_type, actor_id, organizer_id, event_id, after FROM audit_log WHERE action = 'support.opened' AND target_id = $1",
      [grant?.grant_id],
    );
    expect(entry).toMatchObject({
      actor_type: "admin",
      actor_id: admin,
      organizer_id: ids.orgA,
      event_id: ids.eventA,
      after: { reason },
    });
    await closeAll();
  });

  it("refuses non-admins, a member admin, a short reason and the hourly cap", async () => {
    for (const seat of [
      { isAdmin: true, staffUserId: ownerA },
      { staffUserId: admin },
      supportSeat(),
      { playerId: ids.playerA },
    ]) {
      await expect(
        as(seat, "SELECT * FROM support_open($1, 'edit', $2, $3)", [ids.eventA, reason, null]),
      ).rejects.toMatchObject({ code: "QE403" });
    }
    await expect(
      as(adminSeat(), "SELECT * FROM support_open($1, 'edit', $2, $3)", [ids.eventA, "short", null]),
    ).rejects.toMatchObject({ code: "SU400" });
    await owner(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [ids.orgB, otherAdmin],
    );
    await expect(open(ids.eventB, otherAdmin)).rejects.toMatchObject({ code: "SG409" });
    await owner(
      `INSERT INTO support_grant (admin_id, organizer_id, event_id, kind, reason, opened_at, expires_at, closed_at, close_kind)
       SELECT $1, $2, $3, 'view', 'An earlier support visit', now() - interval '5 minutes',
              now() + interval '10 minutes', now(), 'admin'
       FROM generate_series(1, 20)`,
      [otherAdmin, ids.orgA, eventA2],
    );
    await expect(open(ids.eventA, otherAdmin)).rejects.toMatchObject({ code: "SG429" });
  });

  it("opens exactly the granted event as an editor would, and nothing for anyone else", async () => {
    expect(await context(supportSeat())).toEqual({ org: null, scope: [] });
    expect(await context({ playerId: ids.playerA })).toEqual({ org: null, scope: null });
    const grant = await open();
    expect(await context(supportSeat())).toEqual({ org: ids.orgA, scope: [ids.eventA] });
    expect(await visibleEvents(supportSeat())).toEqual([ids.eventA]);
    expect(
      await as(supportSeat(), "SELECT * FROM event_tickets($1, 'open', NULL, NULL, 10)", [
        ids.eventA,
      ]),
    ).toEqual([]);
    expect(await context(supportSeat(ids.orgB))).toEqual({ org: null, scope: [] });
    expect(await visibleEvents(supportSeat(ids.orgB))).not.toContain(ids.eventB);
    await expect(
      as(supportSeat(), "SELECT * FROM event_tickets($1, 'open', NULL, NULL, 10)", [eventA2]),
    ).rejects.toMatchObject({ code: "AN404" });
    await expect(
      as(
        supportSeat(),
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'SUP1', 'New') RETURNING id",
        [ids.orgA],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await context({ ...supportSeat(), isAdmin: true })).toMatchObject({ org: ids.orgA });
    await close(grant?.grant_id ?? "");
    expect(await context(supportSeat())).toEqual({ org: null, scope: [] });
    await expect(close(grant?.grant_id ?? "")).rejects.toMatchObject({ code: "SG404" });
  });

  it("opens nothing once expired, or when the admin is disabled or no longer an admin", async () => {
    const grant = await open();
    await owner(
      `UPDATE support_grant SET opened_at = opened_at - interval '20 minutes',
                                expires_at = expires_at - interval '20 minutes' WHERE id = $1`,
      [grant?.grant_id],
    );
    expect(await context(supportSeat())).toEqual({ org: null, scope: [] });
    await open();
    await owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [admin]);
    expect(await context(supportSeat())).toEqual({ org: null, scope: [] });
    await owner("UPDATE staff_user SET status = 'active', platform_role = 'none' WHERE id = $1", [
      admin,
    ]);
    expect(await context(supportSeat())).toEqual({ org: null, scope: [] });
    await owner("UPDATE staff_user SET platform_role = 'admin' WHERE id = $1", [admin]);
    expect(await context(supportSeat())).toMatchObject({ org: ids.orgA });
    await closeAll();
  });

  it("keeps one live grant per admin and event when two opens race", async () => {
    const second = new Client({ connectionString: db.appUrl });
    await second.connect();
    try {
      const results = await Promise.allSettled([open(), open(ids.eventA, admin, second)]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(true);
      const [live] = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM support_grant WHERE admin_id = $1 AND event_id = $2 AND closed_at IS NULL",
        [admin, ids.eventA],
      );
      expect(live?.n).toBe(1);
    } finally {
      await second.end();
      await closeAll();
    }
  });

  it("lists only the caller's own live grants", async () => {
    const grant = await open();
    const mine = await as({ staffUserId: admin }, "SELECT * FROM own_support_grants()");
    expect(mine).toEqual([
      expect.objectContaining({
        grant_id: grant?.grant_id,
        organizer_id: ids.orgA,
        organizer_name: "Najd Events",
        event_id: ids.eventA,
      }),
    ]);
    expect(await as({ staffUserId: ownerA }, "SELECT * FROM own_support_grants()")).toEqual([]);
    await closeAll();
  });

  it("stamps every staff entry made under a grant, never a member's, whatever the writer passes", async () => {
    const grant = await open();
    const write = (seat: RequestContext, actor: string) =>
      as(
        seat,
        `INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type)
         VALUES ('staff', $1, $2, $3, 'quest.update', 'quest')`,
        [actor, ids.orgA, ids.eventA],
      );
    await write(supportSeat(), admin);
    await write({ organizerId: ids.orgA, staffUserId: ownerA }, ownerA);
    const rows = await owner<{ actor_id: string; support_grant_id: string | null }>(
      "SELECT actor_id, support_grant_id FROM audit_log WHERE action = 'quest.update' ORDER BY id",
    );
    expect(rows).toEqual([
      { actor_id: admin, support_grant_id: grant?.grant_id },
      { actor_id: ownerA, support_grant_id: null },
    ]);
    await expect(
      as(
        supportSeat(),
        `INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, support_grant_id)
         VALUES ('staff', $1, $2, 'quest.update', 'quest', $3)`,
        [admin, ids.orgA, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await owner(
      `INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, support_grant_id)
       VALUES ('staff', $1, $2, 'quest.update', 'quest', $3)`,
      [ownerA, ids.orgA, grant?.grant_id],
    );
    const [forged] = await owner<{ support_grant_id: string | null }>(
      "SELECT support_grant_id FROM audit_log WHERE action = 'quest.update' ORDER BY id DESC LIMIT 1",
    );
    expect(forged?.support_grant_id).toBeNull();
    await closeAll();
  });

  it("shows support as the marker the dashboard translates, and members by email", async () => {
    const [shown] = await owner<{ support: string; member: string; other: string | null }>(
      `SELECT staff_shown($1, $3) AS support, staff_shown($2, $3) AS member, staff_shown($1, $4) AS other`,
      [admin, ownerA, ids.orgA, ids.orgB],
    );
    expect(shown?.support).toBe("questify-support");
    expect(shown?.member).toMatch(/@team\.test$/);
    expect(shown?.other).toBe("support@questify.test");
  });
});
