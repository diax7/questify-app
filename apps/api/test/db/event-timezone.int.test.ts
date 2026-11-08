import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  connectAsOwner,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** Names `pg_timezone_names` does not hold as written: case, abbreviations, offsets, POSIX strings, blanks. */
const INVALID: readonly string[] = [
  "",
  " ",
  "asia/riyadh",
  "ASIA/RIYADH",
  "Asia/riyadh",
  "Asia/Riyadh ",
  " Asia/Riyadh",
  "Asia//Riyadh",
  "Asia/Riyadh/",
  "/Asia/Riyadh",
  "Asia/../Asia/Riyadh",
  "utc",
  "Ast",
  "AST",
  "EDT",
  "PST",
  "CEST",
  "+03",
  "-03",
  "+03:00",
  "UTC+3",
  "UTC+03:00",
  "GMT+3:00",
  "<+03>-3",
  "EST5",
  "AST-3",
  "XXX3YYY,M3.2.0,M11.1.0",
  "Factory2",
  "Mars/Base",
  "localtime",
  "right/UTC",
];

/**
 * The event time zone guard (0009, restated by 0180): a zone is valid exactly when `pg_timezone_names` holds it as written,
 * answered from a copy in `timezone_name` taken by this server run, and from `pg_timezone_names` itself on a miss or
 * when the copy is older than the server's start (taken again then).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event time zone guard (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staff: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    staff = await addMember(db.owner, ids.orgA, "owner");
    // The guard's answer for one zone: an UPDATE of a draft's zone, refused or not.
    await db.owner.query(`
      CREATE FUNCTION zone_accepted(target uuid, zone text) RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE event SET timezone = zone WHERE id = target;
        RETURN true;
      EXCEPTION WHEN SQLSTATE 'QE422' THEN
        RETURN false;
      END $$`);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const draft = async (): Promise<string> => {
    counter += 1;
    const [made] = await owner<{ id: string }>(
      "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, $2, 'Zone') RETURNING id",
      [ids.orgA, `ZONE${counter}`],
    );
    return made?.id ?? "";
  };
  /** The names whose guard answer differs from `pg_timezone_names`. */
  const differing = async (names: readonly (string | null)[]) => {
    const event = await draft();
    return owner<{ name: string | null; guard: boolean; listed: boolean }>(
      `SELECT n AS name, zone_accepted($1, n) AS guard,
              EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = n) AS listed
       FROM unnest($2::text[]) n
       WHERE zone_accepted($1, n) IS DISTINCT FROM EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = n)`,
      [event, names],
    );
  };
  const listed = async () =>
    (await owner<{ name: string }>("SELECT name FROM pg_timezone_names ORDER BY name")).map(
      (row) => row.name,
    );

  it("answers as pg_timezone_names for every zone it holds and the invalid names", async () => {
    const zones = await listed();
    expect(zones.length).toBeGreaterThan(400);
    expect(await differing([...zones, ...INVALID, null])).toEqual([]);
    const [refused] = await owner<{ n: number }>(
      "SELECT count(*)::int AS n FROM unnest($1::text[]) n WHERE EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = n)",
      [INVALID],
    );
    expect(refused?.n).toBe(0);
    // A case, offset or abbreviation that PostgreSQL itself reads as a zone is still refused: the list is the rule.
    expect(
      await owner(
        "SELECT now() AT TIME ZONE 'asia/riyadh' IS NOT NULL AS lower, now() AT TIME ZONE 'EDT' IS NOT NULL AS abbreviation",
      ),
    ).toEqual([{ lower: true, abbreviation: true }]);
  });

  it("answers the same for every zone after the copy is stale, and takes the copy again", async () => {
    await owner("UPDATE timezone_name SET loaded_for = '2000-01-01'");
    expect(await differing(["Asia/Riyadh", "asia/riyadh", "EDT", ...(await listed())])).toEqual([]);
    const [copy] = await owner<{ rows: number; fresh: number; listed: number }>(
      `SELECT count(*)::int AS rows, count(*) FILTER (WHERE loaded_for = pg_postmaster_start_time())::int AS fresh,
              (SELECT count(DISTINCT name)::int FROM pg_timezone_names) AS listed
       FROM timezone_name`,
    );
    expect(copy?.fresh).toBe(copy?.listed);
    expect(copy?.rows).toBe(copy?.listed);
  });

  it("trusts a copy of this server run and nothing older: a zone gone from tzdata is refused once the server restarts", async () => {
    const event = await draft();
    // A zone tzdata dropped, still in a copy taken before the last restart: looked up again, refused, and dropped.
    await owner(
      "INSERT INTO timezone_name (name, loaded_for) VALUES ('Mars/Olympus', '2000-01-01')",
    );
    await owner("UPDATE timezone_name SET loaded_for = '2000-01-01'");
    expect(await owner("SELECT zone_accepted($1, 'Mars/Olympus') AS ok", [event])).toEqual([
      { ok: false },
    ]);
    // The refusal undid its own copy; the next write that goes through keeps the new one.
    expect(await owner("SELECT zone_accepted($1, 'Asia/Riyadh') AS ok", [event])).toEqual([
      { ok: true },
    ]);
    expect(
      await owner("SELECT count(*)::int AS n FROM timezone_name WHERE name = 'Mars/Olympus'"),
    ).toEqual([{ n: 0 }]);
    // The same row in a copy of this run is believed: the guard reads the copy, not pg_timezone_names.
    await owner(
      "INSERT INTO timezone_name (name, loaded_for) VALUES ('Mars/Olympus', pg_postmaster_start_time())",
    );
    try {
      expect(await owner("SELECT zone_accepted($1, 'Mars/Olympus') AS ok", [event])).toEqual([
        { ok: true },
      ]);
    } finally {
      await owner("UPDATE event SET timezone = 'Asia/Riyadh' WHERE id = $1", [event]);
      await owner("DELETE FROM timezone_name WHERE name = 'Mars/Olympus'");
    }
  });

  it("answers from pg_timezone_names without waiting while another session holds the copy's key", async () => {
    await owner("UPDATE timezone_name SET loaded_for = '2000-01-01'");
    const holder = await connectAsOwner(db);
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('timezone_name', 0))");
      // A guard that waited for the key would hit this limit; one that only tries it answers at once.
      await owner("SET statement_timeout = '3s'");
      const insert = (code: string, zone: string) =>
        owner(
          "INSERT INTO event (organizer_id, join_code, name_en, timezone) VALUES ($1, $2, 'x', $3) RETURNING id",
          [ids.orgA, code, zone],
        );
      await expect(insert("ZKEY01", "Asia/Riyadh")).resolves.toHaveLength(1);
      await expect(insert("ZKEY02", "asia/riyadh")).rejects.toThrow(/unknown time zone/);
      // The copy was not taken again: the key's holder decides that.
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM timezone_name WHERE loaded_for = pg_postmaster_start_time()",
        ),
      ).toEqual([{ n: 0 }]);
    } finally {
      await owner("RESET statement_timeout");
      await holder.query("ROLLBACK");
      await holder.end();
    }
    // Once the key is free, the next miss of a stale copy takes it again.
    await owner("UPDATE event SET timezone = 'Europe/London' WHERE join_code = 'ZKEY01'");
    expect(
      await owner(
        "SELECT count(*) FILTER (WHERE loaded_for <> pg_postmaster_start_time())::int AS stale FROM timezone_name",
      ),
    ).toEqual([{ stale: 0 }]);
  });

  it("guards the API's role with no right on the copy, and the copy is closed to everyone", async () => {
    const seat: RequestContext = { organizerId: ids.orgA, staffUserId: staff };
    const insert = (code: string, zone: string) =>
      withRequestContext(db.app, seat, () =>
        db.app.query(
          "INSERT INTO event (organizer_id, join_code, name_en, timezone) VALUES ($1, $2, 'x', $3)",
          [ids.orgA, code, zone],
        ),
      );
    await expect(insert("ZAPP01", "Asia/Riyadh")).resolves.toBeDefined();
    await expect(insert("ZAPP02", "asia/riyadh")).rejects.toThrow(/unknown time zone/);
    expect(
      await owner(
        `SELECT has_table_privilege('questify_app', 'timezone_name', 'SELECT') AS app_read,
                has_table_privilege('questify_app', 'timezone_name', 'INSERT,UPDATE,DELETE,TRUNCATE') AS app_write,
                has_table_privilege('questify_outsider', 'timezone_name', 'SELECT') AS outsider_read,
                has_function_privilege('questify_outsider', 'event_timezone_guard()', 'EXECUTE') AS outsider_call,
                p.prosecdef AS definer, p.proconfig AS settings
         FROM pg_proc p WHERE p.oid = 'event_timezone_guard()'::regprocedure`,
      ),
    ).toEqual([
      {
        app_read: false,
        app_write: false,
        outsider_read: false,
        outsider_call: false,
        definer: true,
        settings: ["search_path=public, pg_temp"],
      },
    ]);
  });
});
