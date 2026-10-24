import type { Pool } from "pg";

/** What one query answers: its rows (and row count), or an error the database raised. */
export type FakeAnswer = Readonly<{ rows?: readonly unknown[]; rowCount?: number }>;

/**
 * A pool whose one connection answers each query from `answer`, for unit tests of how the API reads the database's
 * rows and errors. The transaction statements and the request context's `set_config` answer nothing; `answer` sees
 * every other query and either returns its rows or throws what the database would raise. `queries` keeps the SQL sent.
 */
export function fakePool(answer: (sql: string, values: readonly unknown[]) => FakeAnswer): {
  pool: Pool;
  queries: string[];
} {
  const queries: string[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.startsWith("SELECT set_config(")) {
      return { rows: [], rowCount: 0 };
    }
    queries.push(sql);
    const { rows = [], rowCount } = answer(sql, values);
    return { rows, rowCount: rowCount ?? rows.length };
  };
  const client = { query, release: () => undefined };
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

/** An error as `pg` reports one the database raised: its SQLSTATE and the fields a definer sets. */
export const pgError = (fields: Readonly<Record<string, string>>): Error =>
  Object.assign(new Error(`database error ${fields["code"] ?? ""}`), fields);
