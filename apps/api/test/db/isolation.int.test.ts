import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const TABLES = [
  "organizer",
  "staff_user",
  "organizer_member",
  "player",
  "event",
  "enrollment",
  "schema_migration",
];

describe.skipIf(TEST_DATABASE_URL === undefined)("database isolation", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await db.close();
  });

  const as = <T>(
    context: Parameters<typeof withRequestContext>[1],
    sql: string,
    values: unknown[] = [],
  ) =>
    withRequestContext(
      db.app,
      context,
      async () => (await db.app.query<T & Record<string, unknown>>(sql, values)).rows,
    );

  describe("outsider (holds no rights)", () => {
    it.each(TABLES)("cannot read %s", async (table) => {
      await expect(db.outsider.query(`SELECT * FROM public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    });
    it.each(TABLES)("cannot write %s", async (table) => {
      await expect(db.outsider.query(`DELETE FROM public.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    });
    it("cannot call the request-context functions", async () => {
      await expect(db.outsider.query("SELECT public.app_is_admin()")).rejects.toThrow(
        /permission denied/,
      );
    });
    it("cannot create anything", async () => {
      await expect(db.outsider.query("CREATE TABLE public.sneaky (id int)")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe("structure (deny by default)", () => {
    it("has row-level security forced on every table", async () => {
      const { rows } = await db.owner.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      );
      expect(rows).toEqual([]);
    });
    it("has no table privilege granted to PUBLIC", async () => {
      const { rows } = await db.owner.query(
        "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_schema = 'public'",
      );
      expect(rows).toEqual([]);
    });
    it("lets no function in the public schema be run by PUBLIC", async () => {
      const { rows } = await db.owner.query(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND has_function_privilege('questify_outsider', p.oid, 'EXECUTE')`,
      );
      expect(rows).toEqual([]);
    });
    it("gives the app role no dangerous table rights", async () => {
      const { rows } = await db.owner.query(
        `SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege('questify_app', c.oid, p.priv)`,
      );
      expect(rows).toEqual([]);
    });
    it("makes the app role neither a superuser nor able to skip row-level security", async () => {
      const { rows } = await db.owner.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'questify_app'",
      );
      expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
  });

  describe("tenant isolation (the API's role)", () => {
    it("shows an unidentified caller no private data, only public live events", async () => {
      expect(await as({}, "SELECT id FROM enrollment")).toEqual([]);
      expect(await as({}, "SELECT id FROM player")).toEqual([]);
      expect(await as({}, "SELECT id FROM staff_user")).toEqual([]);
      expect(await as({}, "SELECT staff_user_id FROM organizer_member")).toEqual([]);
      expect((await as<{ id: string }>({}, "SELECT id FROM event")).map((r) => r.id)).toEqual([
        ids.eventA,
      ]);
    });

    it("lets organizer A read only its own enrollments and players", async () => {
      const enrollments = await as<{ organizer_id: string }>(
        { organizerId: ids.orgA },
        "SELECT organizer_id FROM enrollment",
      );
      expect(enrollments.map((r) => r.organizer_id)).toEqual([ids.orgA]);
      const players = await as<{ username: string }>(
        { organizerId: ids.orgA },
        "SELECT username FROM player",
      );
      expect(players.map((r) => r.username)).toEqual(["sara_k"]);
    });

    it("hides organizer B's private event from organizer A", async () => {
      const events = await as<{ id: string }>({ organizerId: ids.orgA }, "SELECT id FROM event");
      expect(events.map((r) => r.id)).toEqual([ids.eventA]);
    });

    it("refuses organizer A creating an event under organizer B", async () => {
      await expect(
        as(
          { organizerId: ids.orgA },
          "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'EVIL1', 'x')",
          [ids.orgB],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("changes nothing when organizer A updates or deletes organizer B's event", async () => {
      await as({ organizerId: ids.orgA }, "UPDATE event SET name_en = 'hacked' WHERE id = $1", [
        ids.eventB,
      ]);
      await as({ organizerId: ids.orgA }, "DELETE FROM event WHERE id = $1", [ids.eventB]);
      const { rows } = await db.owner.query("SELECT name_en FROM event WHERE id = $1", [
        ids.eventB,
      ]);
      expect(rows).toEqual([{ name_en: "Winter Fest" }]);
    });

    it("refuses moving an own event to another organizer", async () => {
      await expect(
        as({ organizerId: ids.orgA }, "UPDATE event SET organizer_id = $1 WHERE id = $2", [
          ids.orgB,
          ids.eventA,
        ]),
      ).rejects.toThrow(/row-level security/);
    });

    it("lets a player see only their own enrollments and themselves", async () => {
      const enrollments = await as<{ player_id: string }>(
        { playerId: ids.playerA },
        "SELECT player_id FROM enrollment",
      );
      expect(enrollments.map((r) => r.player_id)).toEqual([ids.playerA]);
      const players = await as<{ id: string }>({ playerId: ids.playerA }, "SELECT id FROM player");
      expect(players.map((r) => r.id)).toEqual([ids.playerA]);
    });

    it("refuses a player enrolling someone else", async () => {
      await expect(
        as(
          { playerId: ids.playerA },
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          [ids.orgA, ids.eventA, ids.playerB],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("lets a Questify admin see everything", async () => {
      expect(await as({ isAdmin: true }, "SELECT id FROM organizer")).toHaveLength(2);
      expect(await as({ isAdmin: true }, "SELECT id FROM enrollment")).toHaveLength(2);
    });

    it("forgets the context when the transaction ends", async () => {
      await as({ organizerId: ids.orgA }, "SELECT 1");
      expect(await as({}, "SELECT id FROM enrollment")).toEqual([]);
    });

    it("rejects a context id that is not a UUID before talking to the database", async () => {
      await expect(as({ organizerId: "1' OR '1'='1" }, "SELECT 1")).rejects.toThrow(RangeError);
    });
  });

  describe("data rules", () => {
    it("keeps an enrollment's organizer equal to its event's organizer", async () => {
      await expect(
        db.owner.query(
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          [ids.orgB, ids.eventA, ids.playerB],
        ),
      ).rejects.toThrow(/foreign key/);
    });
    it("treats usernames as unique ignoring case", async () => {
      await expect(
        db.owner.query(
          "INSERT INTO player (username, email) VALUES ('SARA_K', 'other@example.com')",
        ),
      ).rejects.toThrow(/duplicate key/);
    });
    it("allows only Saudi (+966) phone numbers", async () => {
      await expect(
        db.owner.query("INSERT INTO player (username, phone_e164) VALUES ('abc', '+971501234567')"),
      ).rejects.toThrow(/check/);
    });
    it("allows only one owner per organizer", async () => {
      const { rows } = await db.owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash) VALUES ('a@x.sa', 'x'), ('b@x.sa', 'x') RETURNING id",
      );
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [ids.orgA, rows[0]?.id],
      );
      await expect(
        db.owner.query(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
          [ids.orgA, rows[1]?.id],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });
});
