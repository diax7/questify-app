import { randomUUID } from "node:crypto";
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
 * Suspension in the database (T-701, migration 0114, ADR-406): admin-only doors, an overlay that changes nothing else,
 * and the walls: the ledger by kind, joining, the public reads; batches skip a suspended event.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("suspension (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let admin: string;
  let disabledAdmin: string;
  let enrollmentA: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    const made = await db.owner.query<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role, status)
       VALUES ('admin@questify.test', 'h', 'admin', 'active'), ('gone@questify.test', 'h', 'admin', 'disabled')
       RETURNING id`,
    );
    admin = made.rows[0]?.id ?? "";
    disabledAdmin = made.rows[1]?.id ?? "";
    await db.owner.query(
      "UPDATE event SET access = 'public', join_methods = ARRAY['public_list', 'code'] WHERE id = $1",
      [ids.eventA],
    );
    const enrolled = await db.owner.query<{ id: string }>(
      "SELECT id FROM enrollment WHERE event_id = $1",
      [ids.eventA],
    );
    enrollmentA = enrolled.rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const adminSeat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  const memberSeat = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const reason = "Reported fraud on the prize desk";
  const suspendEvent = (event = ids.eventA, seat = adminSeat(), why = reason) =>
    as(seat, "SELECT admin_suspend_event($1, $2, $3)", [event, why, randomUUID()]);
  const reactivateEvent = (event = ids.eventA) =>
    as(adminSeat(), "SELECT admin_reactivate_event($1, $2)", [event, randomUUID()]);
  let players = 0;
  /** A new player in event A (joined while the event is open), so each welcome entry is the first of its enrollment. */
  const freshEnrollment = async () => {
    players += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`held_${players}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, ids.eventA, player?.id],
    );
    return made?.id ?? "";
  };
  const welcome = (enrollment: string) =>
    owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
       VALUES ($1, $2, $3, 'welcome', 10, 10, 'system') RETURNING id`,
      [ids.orgA, ids.eventA, enrollment],
    );
  const ledgerTotals = async () =>
    (
      await owner<{ n: string; score: string; balance: string }>(
        `SELECT count(*) AS n, coalesce(sum(score_delta), 0) AS score, coalesce(sum(balance_delta), 0) AS balance
         FROM ledger_entry WHERE event_id = $1`,
        [ids.eventA],
      )
    )[0];

  describe("the doors", () => {
    it("refuse anyone but an active platform admin with the request flag", async () => {
      const seats: RequestContext[] = [
        { isAdmin: true, staffUserId: ownerA },
        { isAdmin: true, staffUserId: disabledAdmin },
        { staffUserId: admin },
        memberSeat(),
        { playerId: ids.playerA },
        {},
      ];
      for (const seat of seats) {
        await expect(suspendEvent(ids.eventA, seat)).rejects.toMatchObject({ code: "QE403" });
        await expect(
          as(seat, "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, randomUUID()]),
        ).rejects.toMatchObject({ code: "QE403" });
      }
    });

    it("want a reason of 10 to 300 characters and refuse the same state twice", async () => {
      await expect(suspendEvent(ids.eventA, adminSeat(), "too short")).rejects.toMatchObject({
        code: "SU400",
      });
      await expect(suspendEvent(ids.eventA, adminSeat(), "x".repeat(301))).rejects.toMatchObject({
        code: "SU400",
      });
      await expect(reactivateEvent()).rejects.toMatchObject({ code: "SU409" });
      await suspendEvent();
      await expect(suspendEvent()).rejects.toMatchObject({ code: "SU409" });
      await reactivateEvent();
      await expect(
        as(adminSeat(), "SELECT admin_suspend_event($1, $2, $3)", [randomUUID(), reason, null]),
      ).rejects.toMatchObject({ code: "QA404" });
    });

    it("audit each change as the admin, with the reason, where the organizer's rows are", async () => {
      await suspendEvent();
      await reactivateEvent();
      const rows = await owner<{ action: string; actor_type: string; organizer_id: string }>(
        `SELECT action, actor_type, organizer_id, after, before FROM audit_log
         WHERE event_id = $1 AND action IN ('event.suspend', 'event.reactivate') ORDER BY id DESC LIMIT 2`,
        [ids.eventA],
      );
      expect(rows.map((row) => row.action)).toEqual(["event.reactivate", "event.suspend"]);
      expect(rows[1]).toMatchObject({
        actor_type: "admin",
        organizer_id: ids.orgA,
        after: { reason },
      });
      expect(rows[0]).toMatchObject({ before: { reason } });
    });
  });

  describe("the walls", () => {
    it("refuse ledger entries by kind and let removals through, while the totals stay put", async () => {
      const [held, later] = [await freshEnrollment(), await freshEnrollment()];
      const [entry] = await welcome(held);
      const before = await ledgerTotals();
      await suspendEvent();
      await expect(welcome(later)).rejects.toMatchObject({ code: "ES423" });
      await expect(
        as(memberSeat(), "SELECT * FROM staff_award($1, $2, NULL, 5, 'Helped', $3, $4)", [
          ids.eventA,
          enrollmentA,
          randomUUID(),
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: "ES423" });
      expect(await ledgerTotals()).toEqual(before);
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   reverses, staff_user_id)
         VALUES ($1, $2, $3, 'removal', -10, -10, 'staff', $4, $5)`,
        [ids.orgA, ids.eventA, held, entry?.id, ownerA],
      );
      await reactivateEvent();
      await welcome(later);
    });

    it("refuse every statement that starts after the suspension commits", async () => {
      const held = await freshEnrollment();
      await db.owner.query("BEGIN");
      try {
        await db.owner.query("SELECT 1 FROM event WHERE id = $1", [ids.eventA]);
        await suspendEvent();
        await expect(welcome(held)).rejects.toMatchObject({ code: "ES423" });
      } finally {
        await db.owner.query("ROLLBACK");
      }
      await reactivateEvent();
    });

    it("refuse joining and leave the event out of the public reads", async () => {
      const code = (
        await owner<{ code: string }>("SELECT join_code AS code FROM event WHERE id = $1", [
          ids.eventA,
        ])
      )[0]?.code;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('late_joiner') RETURNING id",
      );
      const reads = async () => ({
        list: (await as<{ id: string }>({}, "SELECT id FROM public_events(NULL, 100)")).map(
          (row) => row.id,
        ),
        card: (await as({}, "SELECT * FROM public_event($1)", [code])).length,
        quests: (await as({}, "SELECT * FROM public_event_quests($1)", [code])).length,
        rules: (await as({}, "SELECT * FROM public_event_join_rules($1)", [code])).length,
        terms: (await as<{ r: unknown }>({}, "SELECT public_event_rules($1) AS r", [code]))[0]?.r,
      });
      const open = await reads();
      expect(open.list).toContain(ids.eventA);
      expect(open.card).toBe(1);
      await suspendEvent();
      const closed = await reads();
      expect(closed).toMatchObject({ card: 0, quests: 0, rules: 0, terms: null });
      expect(closed.list).not.toContain(ids.eventA);
      await expect(
        owner("INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)", [
          ids.orgA,
          ids.eventA,
          player?.id,
        ]),
      ).rejects.toMatchObject({ code: "ES423" });
      await reactivateEvent();
      expect((await reads()).card).toBe(1);
    });

    it("cover every event of a suspended organizer, and nothing of another organizer", async () => {
      const held = await freshEnrollment();
      await as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [
        ids.orgA,
        reason,
        randomUUID(),
      ]);
      const [ids1] = await as<{ ids: string[] }>({}, "SELECT suspended_ids() AS ids");
      expect(ids1?.ids).toContain(ids.eventA);
      expect(ids1?.ids).not.toContain(ids.eventB);
      await expect(welcome(held)).rejects.toMatchObject({ code: "ES423" });
      const [org] = await owner<{ status: string; suspension_reason: string }>(
        "SELECT status, suspension_reason FROM organizer WHERE id = $1",
        [ids.orgA],
      );
      expect(org).toEqual({ status: "paused", suspension_reason: reason });
      await expect(
        as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, null]),
      ).rejects.toMatchObject({ code: "SU409" });
      await as(adminSeat(), "SELECT admin_reactivate_organizer($1, $2)", [ids.orgA, randomUUID()]);
      await welcome(held);
      const [ids2] = await as<{ ids: string[] }>({}, "SELECT suspended_ids() AS ids");
      expect(ids2?.ids).toEqual([]);
    });
  });

  describe("organizer rows (review BLOCKER 1)", () => {
    it("are read-only to the API role: no member can lift a suspension", async () => {
      const [grants] = await owner<{ select: boolean; insert: boolean; update: boolean }>(
        `SELECT has_table_privilege('questify_app', 'organizer', 'SELECT') AS select,
                has_table_privilege('questify_app', 'organizer', 'INSERT') AS insert,
                has_any_column_privilege('questify_app', 'organizer', 'UPDATE') AS update`,
      );
      expect(grants).toEqual({ select: true, insert: false, update: false });
      await as(adminSeat(), "SELECT admin_suspend_organizer($1, $2, $3)", [ids.orgA, reason, null]);
      await expect(
        as(memberSeat(), "UPDATE organizer SET status = 'active' WHERE id = $1", [ids.orgA]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        as(adminSeat(), "UPDATE organizer SET status = 'active' WHERE id = $1", [ids.orgA]),
      ).rejects.toMatchObject({ code: "42501" });
      await as(adminSeat(), "SELECT admin_reactivate_organizer($1, $2)", [ids.orgA, null]);
    });

    it("keep the suspension columns of an event out of the API's write grant", async () => {
      const [grant] = await owner<{ any: boolean }>(
        `SELECT bool_or(has_column_privilege('questify_app', 'event', c, 'UPDATE')) AS any
         FROM unnest(ARRAY['suspended_at', 'suspended_by', 'suspension_reason']) c`,
      );
      expect(grant?.any).toBe(false);
    });
  });

  describe("batches skip a suspended event", () => {
    it.each([
      "pay_community_batch(integer,uuid)",
      "settle_goal(uuid,boolean)",
      "invitation_claim_campaigns(uuid[])",
      "push_skip_reason(bigint)",
      "screen_event()",
    ])("%s checks the suspension", async (signature) => {
      const [row] = await owner<{ body: string }>(
        "SELECT pg_get_functiondef($1::regprocedure) AS body",
        [signature],
      );
      expect(row?.body).toContain("event_suspended(");
    });
  });
});
