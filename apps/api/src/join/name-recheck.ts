import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** The most name answers one page of the sweep checks (`name_flag_sweep`, migration 0177). */
export const RECHECK_PAGE = 2000;

/** About how long one lifecycle run spends on the sweep, so the steps after it are not held up. */
export const RECHECK_BUDGET_MS = 2000;

/**
 * The name-flag sweep after a word-list change (ADR-817): pages of `name_flag_sweep`, each in its own transaction with
 * no context, until a page comes back short (the sweep is done, or nothing was pending) or the run's budget is spent; the
 * next run goes on from the stored key. Answers how many answers it checked.
 */
export async function sweepNameFlags(pool: Pool, now: () => number = Date.now): Promise<number> {
  const started = now();
  let checked = 0;
  for (;;) {
    const page = await withConnection(pool, (client) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ count: number }>(
          "SELECT name_flag_sweep($1) AS count",
          [RECHECK_PAGE],
        );
        return rows[0]?.count ?? 0;
      }),
    );
    checked += page;
    if (page < RECHECK_PAGE || now() - started >= RECHECK_BUDGET_MS) {
      return checked;
    }
  }
}
