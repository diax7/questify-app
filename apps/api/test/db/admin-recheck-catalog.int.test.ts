import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The functions whose text may still read the bare admin flag (`app_is_admin()` or the `app.is_admin` setting), each
 * with its reason. Every other policy, function, view, trigger condition, check and default re-checks the admin
 * through `app_admin_id()` (migration 0191). This list only shrinks.
 */
const FLAG_READERS: Readonly<Record<string, string>> = {
  app_is_admin: "the flag itself: reads the `app.is_admin` setting (0001)",
  app_admin_id:
    "the re-check: the flag, then an active platform admin account behind it (0027, 0191)",
  ranking_system:
    "a refusal: the system context carries no flag; app_admin_id() would refuse fewer seats (0015, 0191)",
  souvenir_event:
    "a refusal: a flagged context is not the event's team; app_admin_id() would refuse fewer seats (0064)",
  invitation_team_event:
    "a refusal: a flagged context is not the event's team; app_admin_id() would refuse fewer seats (0073)",
};
/** The one form each refusal reads the flag in; the flag appears once in each. */
const REFUSAL_FORM: Readonly<Record<string, RegExp>> = {
  ranking_system: /AND NOT app_is_admin\(\);/,
  souvenir_event: /OR app_is_admin\(\) OR NOT EXISTS ?\(/,
  invitation_team_event: /OR app_is_admin\(\) OR NOT EXISTS ?\(/,
};
const FLAG = String.raw`app_is_admin\(\)|app\.is_admin`;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
};

/**
 * The admin re-check sweep (migration 0191, plan docs/plans/2026-11-11-admin-recheck-sweep.md): the request's admin
 * flag alone, with no active admin account behind it, opens no row-level policy and no definer or trigger gate; every
 * policy asks `(SELECT app_admin_id()) IS NOT NULL`, an InitPlan that runs once per query, not once per row.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the admin re-check (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let admin = "";
  let ownerA = "";
  let ownerB = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
    admin =
      (
        await db.owner.query<{ id: string }>(
          `INSERT INTO staff_user (email, password_hash, platform_role)
           VALUES ('recheck-admin@questify.test', 'h', 'admin') RETURNING id`,
        )
      ).rows[0]?.id ?? "";
    for (const [staff, organizer] of [
      [ownerA, ids.orgA],
      [ownerB, ids.orgB],
    ] as const) {
      await db.owner.query(
        "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)",
        [staff, randomBytes(32)],
      );
      await db.owner.query(
        `INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by)
         VALUES ($1, 'organizer_terms', '1.0', $2)`,
        [organizer, staff],
      );
    }
    await db.owner.query("INSERT INTO event_result (event_id, organizer_id) VALUES ($1, $2)", [
      ids.eventB,
      ids.orgB,
    ]);
  });
  afterAll(async () => {
    await db.close();
  });

  const as = async <T extends Record<string, unknown>>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => (await withRequestContext(db.app, context, () => db.app.query<T>(sql, values))).rows;
  /** Runs `sql` in `context` and rolls it back; the rows it returned. */
  const tried = async (context: RequestContext, sql: string, values: unknown[] = []) => {
    const rolledBack = new Error("rolled back");
    let rows: unknown[] = [];
    await withRequestContext(db.app, context, async () => {
      rows = (await db.app.query(sql, values)).rows;
      throw rolledBack;
    }).catch((error: unknown) => {
      if (error !== rolledBack) throw error;
    });
    return rows;
  };
  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const realAdmin = (): RequestContext => ({ isAdmin: true, staffUserId: admin });
  /** How often app_admin_id() ran in the owner connection's open transaction. */
  const adminIdCalls = async () =>
    (
      await owner<{ n: number }>(
        "SELECT coalesce(pg_stat_get_xact_function_calls('app_admin_id()'::regprocedure), 0)::int AS n",
      )
    )[0]?.n ?? -1;
  /**
   * Runs `sql` as the API role (`SET LOCAL ROLE` in the owner's transaction, so function calls are counted) with the
   * given settings; the count it read, and how often app_admin_id() ran for that one statement.
   */
  const measured = async (settings: Record<string, string>, sql: string, values: unknown[]) => {
    await owner("SET track_functions = 'all'");
    await owner("BEGIN");
    try {
      for (const [name, setting] of Object.entries(settings)) {
        await owner("SELECT set_config($1, $2, true)", [name, setting]);
      }
      const before = await adminIdCalls();
      await owner("SET LOCAL ROLE questify_app");
      const [read] = await owner<{ n: number }>(sql, values);
      await owner("RESET ROLE");
      return { rows: read?.n, calls: (await adminIdCalls()) - before };
    } finally {
      await owner("ROLLBACK");
    }
  };

  describe("the catalog", () => {
    it("has no row-level policy that reads the bare flag", async () => {
      const found = await owner<{ policy: string }>(
        `SELECT tablename || '.' || policyname AS policy FROM pg_policies
         WHERE schemaname = 'public' AND (coalesce(qual, '') ~ $1 OR coalesce(with_check, '') ~ $1)
         ORDER BY 1`,
        [FLAG],
      );
      expect(found).toEqual([]);
    });

    it("asks app_admin_id() in every policy only as an InitPlan, once per query", async () => {
      const found = await owner<{ policy: string; calls: number; initplans: number }>(
        `SELECT tablename || '.' || policyname AS policy,
                regexp_count(txt, 'app_admin_id\\(\\)')::int AS calls,
                regexp_count(txt, 'SELECT app_admin_id\\(\\)')::int AS initplans
         FROM (SELECT tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS txt
               FROM pg_policies WHERE schemaname = 'public') p
         WHERE regexp_count(txt, 'app_admin_id\\(\\)') <> regexp_count(txt, 'SELECT app_admin_id\\(\\)')
         ORDER BY 1`,
      );
      expect(found).toEqual([]);
      // The sweep's 53 policies (42 that read the flag, 11 that asked app_admin_id() once per row) all ask it now.
      const [asked] = await owner<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policies
         WHERE schemaname = 'public' AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'SELECT app_admin_id\\(\\)'`,
      );
      expect(asked?.n).toBeGreaterThanOrEqual(53);
    });

    it("lets only the listed functions read the flag, each for its reason", async () => {
      const found = (
        await owner<{ name: string }>(
          `SELECT p.proname AS name FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
             AND pg_get_functiondef(p.oid) ~ $1
           ORDER BY 1`,
          [FLAG],
        )
      ).map((row) => row.name);
      const listed = Object.keys(FLAG_READERS);
      expect(found.filter((name) => !listed.includes(name))).toEqual([]);
      expect(listed.filter((name) => !found.includes(name))).toEqual([]);
    });

    it("reads the flag once in each refusal, and only in its refusal form", async () => {
      for (const [name, form] of Object.entries(REFUSAL_FORM)) {
        const [row] = await owner<{ body: string; n: number }>(
          `SELECT pg_get_functiondef(p.oid) AS body, regexp_count(pg_get_functiondef(p.oid), $2)::int AS n
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`,
          [name, FLAG],
        );
        expect(row?.n, name).toBe(1);
        expect(row?.body, name).toMatch(form);
      }
    });

    it("keeps app_admin_id() in PL/pgSQL, not inlined SQL planned on every call", async () => {
      const [row] = await owner<{ language: string; definer: boolean }>(
        `SELECT l.lanname AS language, p.prosecdef AS definer FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
         WHERE p.oid = 'app_admin_id()'::regprocedure`,
      );
      expect(row).toEqual({ language: "plpgsql", definer: true });
    });

    it("has no view, trigger condition, check or default that reads the flag", async () => {
      const found = await owner<{ what: string }>(
        `SELECT 'view ' || viewname AS what FROM pg_views WHERE schemaname = 'public' AND definition ~ $1
         UNION ALL
         SELECT 'matview ' || matviewname FROM pg_matviews WHERE schemaname = 'public' AND definition ~ $1
         UNION ALL
         SELECT 'trigger ' || t.tgname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
           AND pg_get_triggerdef(t.oid) ~ $1
         UNION ALL
         SELECT 'constraint ' || conname FROM pg_constraint
         WHERE connamespace = 'public'::regnamespace AND pg_get_constraintdef(oid) ~ $1
         UNION ALL
         SELECT 'default ' || a.adrelid::regclass || '.' || a.adnum FROM pg_attrdef a
         WHERE pg_get_expr(a.adbin, a.adrelid) ~ $1`,
        [FLAG],
      );
      expect(found).toEqual([]);
    });
  });

  describe("the shared tables", () => {
    const forged: ReadonlyArray<readonly [string, () => RequestContext]> = [
      ["the flag alone", () => ({ isAdmin: true })],
      ["the flag on an organizer owner's account", () => ({ isAdmin: true, staffUserId: ownerA })],
    ];

    it.each(forged)(
      "%s reads no other staff account, session or acceptance",
      async (_name, context) => {
        const seat = context();
        const own = seat.staffUserId === undefined ? [] : [{ id: seat.staffUserId }];
        expect(await as(seat, "SELECT id FROM staff_user ORDER BY id")).toEqual(own);
        expect(
          await as(seat, "SELECT staff_user_id FROM staff_session WHERE staff_user_id <> $1", [
            seat.staffUserId ?? admin,
          ]),
        ).toEqual([]);
        expect(await as(seat, "SELECT organizer_id FROM organizer_acceptance")).toEqual([]);
      },
    );

    it.each(forged)(
      "%s grants no entitlement and reads no other organizer's result",
      async (_name, context) => {
        expect(
          await refusal(
            tried(
              context(),
              "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
              [ids.eventB, ids.orgB],
            ),
          ),
        ).toBe("42501");
        expect(await as(context(), "SELECT results_frozen($1) AS frozen", [ids.eventB])).toEqual([
          { frozen: false },
        ]);
      },
    );

    it("lets a real admin read and write each", async () => {
      const [staff] = await as<{ n: number }>(
        realAdmin(),
        "SELECT count(*)::int AS n FROM staff_user",
      );
      expect(staff?.n).toBe(3);
      const [sessions] = await as<{ n: number }>(
        realAdmin(),
        "SELECT count(*)::int AS n FROM staff_session",
      );
      expect(sessions?.n).toBe(2);
      const [accepted] = await as<{ n: number }>(
        realAdmin(),
        "SELECT count(*)::int AS n FROM organizer_acceptance",
      );
      expect(accepted?.n).toBe(2);
      expect(
        await tried(
          realAdmin(),
          `INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')
           RETURNING feature`,
          [ids.eventB, ids.orgB],
        ),
      ).toEqual([{ feature: "bigScreen" }]);
      expect(await as(realAdmin(), "SELECT results_frozen($1) AS frozen", [ids.eventB])).toEqual([
        { frozen: true },
      ]);
    });

    it("refuses an admin whose account is disabled, or no longer an admin", async () => {
      for (const change of ["status = 'disabled'", "platform_role = 'none'"]) {
        try {
          await owner(`UPDATE staff_user SET ${change} WHERE id = $1`, [admin]);
          expect(await as(realAdmin(), "SELECT id FROM staff_user")).toEqual([{ id: admin }]);
          expect(
            await as(realAdmin(), "SELECT results_frozen($1) AS frozen", [ids.eventB]),
          ).toEqual([{ frozen: false }]);
        } finally {
          await owner(
            "UPDATE staff_user SET status = 'active', platform_role = 'admin' WHERE id = $1",
            [admin],
          );
        }
      }
    });
  });

  describe("the cost of the re-check", () => {
    const ROWS = 20;
    let event = "";
    let reader = "";

    beforeAll(async () => {
      event = ids.eventA;
      // One reader with one entry, and ROWS entries of other players of the same event.
      const enrollmentOf = async (player: string) =>
        (
          await owner<{ id: string }>(
            "SELECT id FROM enrollment WHERE event_id = $1 AND player_id = $2",
            [event, player],
          )
        )[0]?.id ?? "";
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, c.id, 'scan_qr', 'Quest', 1, 100, true, '{}'
         FROM (SELECT id FROM category WHERE event_id = $1 LIMIT 1) c RETURNING id`,
        [event],
      );
      // As the ledger writes a first completion (test/support/questify.ts `earn`).
      const earn = async (enrollment: string) => {
        const [done] = await owner<{ id: string }>(
          `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                         idempotency_key)
           VALUES ($1, $2, $3, $4, 1, 'qr', gen_random_uuid()) RETURNING id`,
          [ids.orgA, event, enrollment, quest?.id],
        );
        await owner(
          `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                     completion_id, quest_id, actor)
           VALUES ($1, $2, $3, 'quest', 1, 1, $4, $5, 'player')`,
          [ids.orgA, event, enrollment, done?.id, quest?.id],
        );
      };
      reader = ids.playerA;
      await earn(await enrollmentOf(reader));
      for (let i = 0; i < ROWS; i += 1) {
        const [player] = await owner<{ id: string }>(
          "INSERT INTO player (username) VALUES ($1) RETURNING id",
          [`recheck_${i}`],
        );
        const [enrolled] = await owner<{ id: string }>(
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
          [ids.orgA, event, player?.id],
        );
        await earn(enrolled?.id ?? "");
      }
    });

    // An InitPlan runs at its first use and at most once per query. The player's rows fail the organizer branch, so
    // ledger_entry_read's InitPlan runs once; the enrollment sub-select's own is never reached (its rows pass
    // `player_id = app_player_id()` first). The admin's InitPlan answers before the sub-select runs at all. A bare
    // app_admin_id() would run once for each of the 21 rows. An InitPlan runs lazily, on first use, so a plan change may
    // move the count to 2; the bound is what tells one call per query from one per row.
    it("runs app_admin_id() once for a player who reads one row of many, not once per row", async () => {
      expect(
        await measured(
          { "app.player_id": reader },
          "SELECT count(*)::int AS n FROM ledger_entry WHERE event_id = $1",
          [event],
        ),
      ).toMatchObject({ rows: 1, calls: expect.toBeOneOf([1, 2]) });
    });

    it("runs app_admin_id() once for an admin who reads every row, not once per row", async () => {
      expect(
        await measured(
          { "app.is_admin": "on", "app.staff_user_id": admin },
          "SELECT count(*)::int AS n FROM ledger_entry WHERE event_id = $1",
          [event],
        ),
      ).toMatchObject({ rows: ROWS + 1, calls: expect.toBeOneOf([1, 2]) });
    });
  });
});
