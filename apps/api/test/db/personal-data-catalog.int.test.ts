import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import { CATALOG, NOT_PLAYER, type CatalogEntry } from "#test/db/personal-data-catalog";
import { seedFullPlayer, type FullPlayer } from "#test/support/full-player";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

const BY_NAME = ["audit_log", "player_login_challenge", "erased_mark", "staff_user"];

/** The tables reached from `player` through foreign keys, at any depth. */
const CLOSURE = `
  WITH RECURSIVE fk AS (
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace),
  reach(tbl) AS (SELECT 'player'::text UNION SELECT fk.child FROM fk JOIN reach r ON fk.parent = r.tbl)
  SELECT tbl FROM reach ORDER BY tbl`;

/** Each foreign key into a reached table, with its columns. */
const FK_LINKS = `
  WITH RECURSIVE fk AS (
    SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
           (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
    FROM pg_constraint c WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace),
  reach(tbl) AS (SELECT 'player'::text UNION SELECT fk.child FROM fk JOIN reach r ON fk.parent = r.tbl)
  SELECT child, parent, cols FROM fk WHERE parent IN (SELECT tbl FROM reach) AND child <> 'player'`;

/** Every uuid, uuid[] and jsonb column with no foreign key, single-column primary keys aside. */
const FK_LESS = `
  SELECT c.table_name AS t, c.column_name AS c
  FROM information_schema.columns c
  JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = 'public'
  WHERE c.table_schema = 'public' AND c.udt_name IN ('uuid', '_uuid', 'jsonb')
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                    WHERE k.conrelid = quote_ident(c.table_name)::regclass AND a.attname = c.column_name
                      AND (k.contype = 'f' OR (k.contype = 'p' AND cardinality(k.conkey) = 1)))
  ORDER BY 1, 2`;

/** Whether an FK-less column is a link, the player's own data, or listed as not a player. */
function known(row: Readonly<{ t: string; c: string }>): boolean {
  const entry: CatalogEntry | undefined = CATALOG[row.t];
  return (
    entry?.links.includes(row.c) === true ||
    entry?.personal?.includes(row.c) === true ||
    `${row.t}.${row.c}` in NOT_PLAYER
  );
}

const section = (path: string): readonly string[] => path.split(".");

/** Whether the export holds at least one item at the path (`events[].completions`: in any event). */
function hasItems(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) {
    if (Array.isArray(value)) return value.length > 0;
    return value !== null && value !== undefined && value !== false;
  }
  const [head = "", ...rest] = path;
  const many = head.endsWith("[]");
  const key = many ? head.slice(0, -2) : head;
  const next = (value as Row | null)?.[key];
  if (!many) return hasItems(next, rest);
  return Array.isArray(next) && next.some((item) => hasItems(item, rest));
}

/**
 * The personal-data catalog (T-708, ADR-482): a closed list of the tables and FK-less id and jsonb columns, the export
 * of a fully seeded player shows every section the catalog names, and the admin erasure leaves no personal data in a
 * deleted or cleared table, in a kept table's text, or in the audit log.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("personal-data catalog (database)", () => {
  let db: TestDatabase;
  let full: FullPlayer;
  let file: Row = {};
  let adminId = "";

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  beforeAll(async () => {
    db = await createTestDatabase();
    full = await seedFullPlayer(db.owner);
    const [admin] = await owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('catalog@questify.test', 'h', 'admin') RETURNING id",
    );
    adminId = admin?.id ?? "";
    const [built] = await owner<{ r: Row }>("SELECT player_data_export($1) AS r", [full.player]);
    file = built?.r ?? {};
  });
  afterAll(async () => {
    await db.close();
  });

  it("classifies exactly the tables that can hold a row about a player", async () => {
    const reached = (await owner<{ tbl: string }>(CLOSURE)).map((row) => row.tbl);
    const fkLess = (await owner<{ t: string; c: string }>(FK_LESS)).filter((row) =>
      CATALOG[row.t]?.links.includes(row.c),
    );
    const expected = new Set([...reached, ...fkLess.map((row) => row.t), ...BY_NAME]);
    const missing = [...expected].filter((table) => !(table in CATALOG));
    const stale = Object.keys(CATALOG).filter((table) => !expected.has(table));
    expect(missing, "add it to personal-data-catalog.ts: export section, erasure").toEqual([]);
    expect(stale, "no longer linked to a player: remove it from personal-data-catalog.ts").toEqual(
      [],
    );
  });

  it("names a link column for every foreign key into the player's tables", async () => {
    const links = await owner<{ child: string; parent: string; cols: string[] }>(FK_LINKS);
    const unnamed = links
      .filter((fk) => !fk.cols.some((column) => CATALOG[fk.child]?.links.includes(column)))
      .map((fk) => `${fk.child}(${fk.cols.join(",")}) -> ${fk.parent}`);
    expect(unnamed).toEqual([]);
  });

  it("classifies every FK-less uuid, uuid[] and jsonb column as a link, the player's own data or not a player", async () => {
    const columns = await owner<{ t: string; c: string }>(FK_LESS);
    const unclassified = columns.filter((row) => !known(row)).map((row) => `${row.t}.${row.c}`);
    const names = new Set(columns.map((row) => `${row.t}.${row.c}`));
    const stale = Object.keys(NOT_PLAYER).filter((name) => !names.has(name));
    expect(unclassified, "classify it in personal-data-catalog.ts (a link or NOT_PLAYER)").toEqual(
      [],
    );
    expect(stale).toEqual([]);
  });

  it("explains every kept or cleared table", () => {
    const silent = Object.entries(CATALOG)
      .filter(([, entry]) => entry.erasure !== "delete" && (entry.why ?? "") === "")
      .map(([table]) => table);
    expect(silent).toEqual([]);
  });

  it("exports something in every section the catalog names for a fully seeded player", () => {
    const empty = Object.entries(CATALOG)
      .filter(([, entry]) => typeof entry.export === "string")
      .filter(([, entry]) => !hasItems(file, section(entry.export as string)))
      .map(([table, entry]) => `${table}: ${String(entry.export)}`);
    expect(empty, "seed the table in test/support/full-player.ts").toEqual([]);
    const text = JSON.stringify(file);
    expect(text).toContain(full.phone);
    expect(text).toContain(full.email);
    expect(text).toContain(full.joinAnswer);
    expect(text).not.toContain("push_token_");
  });

  it("leaves no personal data behind after the admin erasure", async () => {
    await withRequestContext(db.app, { isAdmin: true, staffUserId: adminId }, () =>
      db.app.query(
        "SELECT * FROM admin_erase_player($1, 'legal_request', 'CASE-1', $2, true, $3)",
        [full.player, full.username, randomUUID()],
      ),
    );
    const params = [full.player, full.phone, full.email];
    const needles = [
      full.username,
      full.phone,
      full.email,
      full.joinAnswer,
      full.submission,
      full.ticket,
    ];
    const left: string[] = [];
    for (const [table, entry] of Object.entries(CATALOG)) {
      const rows = await owner(
        `WITH v AS (SELECT $1::uuid AS a, $2::text AS b, $3::text AS c)
         SELECT to_jsonb(x) AS r FROM ${table} x, v WHERE ${entry.rows}`,
        params,
      );
      if (entry.erasure !== "keep" && rows.length > 0) {
        left.push(`${table}: ${rows.length} row(s)`);
      }
      const text = JSON.stringify(rows);
      for (const needle of needles) {
        if (text.includes(needle)) left.push(`${table}: holds ${needle}`);
      }
    }
    expect(left).toEqual([]);
    const audit = JSON.stringify(
      await owner(
        "SELECT before, after FROM audit_log WHERE target_id = $1::text OR actor_id = $1::uuid",
        [full.player],
      ),
    );
    for (const needle of [full.username, full.phone, full.email]) {
      expect(audit).not.toContain(needle);
    }
  });
});
