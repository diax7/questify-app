import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DEVICE_LIMITS, holdBack } from "#src/devices/limits";

/** A pool whose advisory lock answers `locked` and whose throttle windows hold no attempt; every SQL is kept. */
function fakePool(locked: boolean) {
  const asked: string[] = [];
  const client = {
    query: async (sql: string) => {
      asked.push(sql);
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked }] };
      }
      if (sql.includes("FROM auth_throttle")) {
        return { rows: [{ count: 0, retry_after: null }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, asked };
}

const limit = { limit: DEVICE_LIMITS.claimsPerActor, key: Buffer.alloc(32, 7) };

describe("holdBack", () => {
  it("answers too_many_attempts with a 1 second wait while another call holds the key", async () => {
    const { pool, asked } = fakePool(false);
    const header = vi.fn();
    await expect(holdBack(pool, [limit], true, { header })).rejects.toMatchObject({
      status: 429,
      envelope: { code: "too_many_attempts", details: { retryAfterSeconds: 1 } },
    });
    expect(header).toHaveBeenCalledWith("retry-after", "1");
    expect(asked.some((sql) => sql.includes("INSERT INTO auth_throttle"))).toBe(false);
  });

  it("holds a busy key without a reply to set Retry-After on", async () => {
    const { pool } = fakePool(false);
    await expect(holdBack(pool, [limit], true)).rejects.toMatchObject({ status: 429 });
  });

  it("lets a free key through and records the attempt", async () => {
    const { pool, asked } = fakePool(true);
    await expect(holdBack(pool, [limit], true)).resolves.toBeUndefined();
    expect(asked.filter((sql) => sql.includes("INSERT INTO auth_throttle"))).toHaveLength(1);
  });

  it("holds nothing and takes no lock without a limit", async () => {
    const { pool, asked } = fakePool(false);
    await expect(holdBack(pool, [], true)).resolves.toBeUndefined();
    expect(asked.some((sql) => sql.includes("pg_try_advisory_xact_lock"))).toBe(false);
  });
});
