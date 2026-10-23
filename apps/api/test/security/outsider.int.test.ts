import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The outsider suite (T-012, NFR-017, NFR-018): `questify_outsider` holds only what PUBLIC holds, the same seat as
 * anyone who gets hold of a connection string without our role's rights. Every check reads the live catalog, so a
 * table, sequence, function or schema added later is covered without editing this file.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("outsider (public credential only)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await db.close();
  });

  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    (await db.owner.query<T>(sql)).rows;

  const tables = async (): Promise<string[]> =>
    (
      await rows<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
      )
    ).map((row) => row.name);

  describe("live attempts", () => {
    it("cannot read or delete from any table", async () => {
      const all = await tables();
      expect(all.length).toBeGreaterThan(10);
      for (const table of all) {
        await expect(
          db.outsider.query(`SELECT * FROM public.${table} LIMIT 1`),
          table,
        ).rejects.toThrow(/permission denied/);
        await expect(db.outsider.query(`DELETE FROM public.${table}`), table).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it("cannot call the request-context functions", async () => {
      await expect(db.outsider.query("SELECT public.app_is_admin()")).rejects.toThrow(
        /permission denied/,
      );
    });

    it("cannot read or move Questify XP (T-401)", async () => {
      for (const sql of [
        "SELECT * FROM public.own_level(NULL)",
        "SELECT public.xp_credit(NULL::public.ledger_entry)",
        "SELECT public.xp_reverse(NULL::public.ledger_entry)",
        "SELECT public.xp_backfill()",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot send, read or review submissions (T-301)", async () => {
      for (const sql of [
        "SELECT * FROM public.submit_quest(gen_random_uuid(), 'x', '1.0', 'k')",
        "SELECT * FROM public.own_submissions(gen_random_uuid())",
        "SELECT public.own_pending_points(gen_random_uuid())",
        "SELECT * FROM public.event_submissions(gen_random_uuid(), 'pending', NULL, 1)",
        "SELECT * FROM public.operator_submissions(gen_random_uuid(), NULL, 1)",
        "SELECT * FROM public.staff_review_submission(gen_random_uuid(), 1, 'approve', NULL, 'k', NULL)",
        "SELECT * FROM public.operator_review_submission(gen_random_uuid(), 1, 'approve', NULL, 'k')",
        "SELECT * FROM public.remove_submission(gen_random_uuid(), 1, 'x', 'k', NULL)",
        "SELECT public.mark_submissions_seen(gen_random_uuid(), '{}')",
        "SELECT * FROM public.submitters_of('{}')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot vote, play a quiz or read either (T-302)", async () => {
      for (const sql of [
        "SELECT * FROM public.vote_quest(gen_random_uuid(), 'a', 'k')",
        "SELECT * FROM public.member_vote(gen_random_uuid())",
        "SELECT * FROM public.quest_vote_counts(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.quiz_start(gen_random_uuid())",
        "SELECT public.quiz_next(gen_random_uuid())",
        "SELECT public.quiz_answer(gen_random_uuid(), 'q1', 'a')",
        "SELECT * FROM public.member_quiz(gen_random_uuid())",
        "SELECT public.finish_one_due_quiz()",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot answer a survey, share, read either or list stations (T-303)", async () => {
      for (const sql of [
        "SELECT * FROM public.submit_survey(gen_random_uuid(), '{}', 'k')",
        "SELECT public.member_survey(gen_random_uuid())",
        "SELECT public.survey_summary(gen_random_uuid(), gen_random_uuid())",
        "SELECT * FROM public.share_quest(gen_random_uuid(), 'k')",
        "SELECT * FROM public.member_share(gen_random_uuid())",
        "SELECT * FROM public.operator_stations(gen_random_uuid())",
        "SELECT public.play_quest(gen_random_uuid(), 'survey')",
        "SELECT public.survey_answers('{}', '{}')",
        "SELECT public.share_quests_on(gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a category bonus or reach the category rules (T-304)", async () => {
      for (const sql of [
        "SELECT * FROM public.category_bonus",
        "SELECT * FROM public.own_bonus(1)",
        "SELECT * FROM public.own_category_bonus(gen_random_uuid())",
        "SELECT public.pay_category_bonus(NULL::public.enrollment, gen_random_uuid(), NULL)",
        "SELECT public.category_lock(NULL::public.quest, gen_random_uuid())",
        "SELECT public.category_done(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.category_cleared(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.quest_done(gen_random_uuid(), gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot stamp a passport step or read either table (T-304b)", async () => {
      for (const sql of [
        "SELECT * FROM public.passport_step",
        "SELECT * FROM public.passport_stamp",
        "SELECT * FROM public.stamp_step(gen_random_uuid(), 1, 'k', NULL)",
        "SELECT * FROM public.member_passport(gen_random_uuid())",
        "SELECT * FROM public.stamped_steps(gen_random_uuid())",
        "SELECT public.passport_shape_check(gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot create anything", async () => {
      await expect(db.outsider.query("CREATE TABLE public.sneaky (id int)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.outsider.query("CREATE SCHEMA sneaky")).rejects.toThrow(/permission denied/);
    });
  });

  describe("catalog (every object, present and future)", () => {
    it("holds no right on any table, view or sequence", async () => {
      const held = await rows(
        `SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege('questify_outsider', c.oid, p.priv)
         UNION ALL
         SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind = 'S'
           AND has_sequence_privilege('questify_outsider', c.oid, p.priv)`,
      );
      expect(held).toEqual([]);
    });

    it("can run no function in the public schema", async () => {
      const held = await rows(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND has_function_privilege('questify_outsider', p.oid, 'EXECUTE')`,
      );
      expect(held).toEqual([]);
    });

    it("cannot create in any schema or in the database", async () => {
      const held = await rows(
        `SELECT nspname FROM pg_namespace
         WHERE has_schema_privilege('questify_outsider', oid, 'CREATE')
         UNION ALL
         SELECT 'database' WHERE has_database_privilege('questify_outsider', current_database(), 'CREATE')`,
      );
      expect(held).toEqual([]);
    });

    it("has only the public schema to look at (a new schema must join this suite)", async () => {
      const schemas = await rows<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_%'`,
      );
      expect(schemas.map((row) => row.nspname)).toEqual(["public"]);
    });
  });

  describe("structure (deny by default)", () => {
    it("has row-level security forced on every table", async () => {
      const open = await rows(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      );
      expect(open).toEqual([]);
    });

    it("has no view, which would read with its owner's rights and skip row-level security", async () => {
      const views = await rows(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`,
      );
      expect(views).toEqual([]);
    });

    it("grants nothing on a table to PUBLIC", async () => {
      expect(
        await rows(
          "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_schema = 'public'",
        ),
      ).toEqual([]);
    });

    it("gives the app role no dangerous rights", async () => {
      const held = await rows(
        `SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege('questify_app', c.oid, p.priv)
         UNION ALL
         SELECT 'schema public', 'CREATE' WHERE has_schema_privilege('questify_app', 'public', 'CREATE')`,
      );
      expect(held).toEqual([]);
    });

    it("makes the app role neither a superuser nor able to skip row-level security", async () => {
      expect(
        await rows("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'questify_app'"),
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
  });
});
