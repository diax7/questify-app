import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { RECHECK_PAGE, sweepNameFlags } from "#src/join/name-recheck";

/** A pool whose sweep answers the given page sizes in turn, each on a connection of its own. */
function pagedPool(pages: number[]) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return sql.includes("name_flag_sweep")
        ? { rows: [{ count: pages.shift() ?? 0 }] }
        : { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, client };
}

describe("sweepNameFlags", () => {
  it("runs pages, each in its own transaction, until one comes back short", async () => {
    const { pool, statements, client } = pagedPool([RECHECK_PAGE, RECHECK_PAGE, 7]);
    expect(await sweepNameFlags(pool)).toBe(2 * RECHECK_PAGE + 7);
    expect(statements.filter((sql) => sql.includes("name_flag_sweep"))).toHaveLength(3);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(3);
    expect(client.release).toHaveBeenCalledTimes(3);
  });

  it("asks for pages of 250, so a page at the slowest name stays well under 1 s (ADR-817)", async () => {
    const { pool, client } = pagedPool([0]);
    await sweepNameFlags(pool);
    expect(RECHECK_PAGE).toBe(250);
    expect(client.query).toHaveBeenCalledWith("SELECT name_flag_sweep($1) AS count", [250]);
  });

  it("stops when nothing is pending", async () => {
    const { pool, statements } = pagedPool([0]);
    expect(await sweepNameFlags(pool)).toBe(0);
    expect(statements.filter((sql) => sql.includes("name_flag_sweep"))).toHaveLength(1);
  });

  it("leaves the rest to the next run once its budget is spent", async () => {
    const { pool, statements } = pagedPool([RECHECK_PAGE, RECHECK_PAGE, RECHECK_PAGE]);
    const clock = [0, 1500, 2500];
    expect(await sweepNameFlags(pool, () => clock.shift() ?? 9999)).toBe(2 * RECHECK_PAGE);
    expect(statements.filter((sql) => sql.includes("name_flag_sweep"))).toHaveLength(2);
  });
});
