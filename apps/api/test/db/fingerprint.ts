import type { Client } from "pg";

/**
 * A hash of every row of every base table in every application schema, by table: equal before and after means
 * nothing was written anywhere. Read as the migration owner, a superuser here, because row-level security is forced
 * on every table and would hide rows from any other role. Nothing is excluded, so a table added later is covered
 * without editing this. Sequences are left out on purpose: `nextval` is never rolled back, so an undone write still
 * skips identity numbers (gaps only, ADR-249's cost); every row that would carry one is covered by its table.
 */
export async function fingerprint(owner: Client): Promise<Readonly<Record<string, string>>> {
  const { rows: who } = await owner.query<{ name: string; superuser: boolean }>(
    "SELECT current_user AS name, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
  );
  if (who[0]?.superuser !== true) {
    throw new Error(
      `fingerprint must read as a superuser (row-level security is forced and would hide rows from ${who[0]?.name ?? "this role"}); pass the test database's owner connection.`,
    );
  }
  const { rows: tables } = await owner.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_%'
     ORDER BY 1`,
  );
  const hashes: Record<string, string> = {};
  for (const { name } of tables) {
    const { rows } = await owner.query<{ hash: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash FROM ${name} t`,
    );
    hashes[name] = rows[0]?.hash ?? "";
  }
  return hashes;
}
