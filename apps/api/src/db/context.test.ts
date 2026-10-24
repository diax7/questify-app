import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { withRolledBackContext } from "#src/db/context";

const PLAYER = "6f1c1e1a-6b0f-4c39-9d4e-0d5b8e1f2a3c";

/** A pool of one connection that records every statement and how it was released. */
function recordingPool(fail: Readonly<{ on?: string }> = {}) {
  const sent: string[] = [];
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      sent.push(sql.startsWith("SELECT set_config(") ? "SET" : sql);
      if (fail.on !== undefined && sql === fail.on) {
        throw new Error(`${sql} failed`);
      }
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    release: (error?: unknown) => {
      released.push(error);
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, sent, released };
}

describe("withRolledBackContext (the practice scan's API wall, ADR-249)", () => {
  it("rolls back after work that succeeds, never commits, and gives the connection back", async () => {
    const { pool, sent, released } = recordingPool();
    const value = await withRolledBackContext(pool, { playerId: PLAYER }, async (client) => {
      await client.query("SELECT 1");
      return "seen";
    });
    expect(value).toBe("seen");
    expect(sent).toEqual(["BEGIN", "SET", "SELECT 1", "ROLLBACK"]);
    expect(released).toEqual([undefined]);
  });

  it("rolls back after work that throws, never commits, and rethrows", async () => {
    const { pool, sent, released } = recordingPool({ on: "SELECT boom" });
    await expect(
      withRolledBackContext(pool, { playerId: PLAYER }, async (client) => {
        await client.query("SELECT boom");
      }),
    ).rejects.toThrow("SELECT boom failed");
    expect(sent).toEqual(["BEGIN", "SET", "SELECT boom", "ROLLBACK"]);
    expect(sent).not.toContain("COMMIT");
    expect(released).toEqual([undefined]);
  });

  it("rolls back when BEGIN fails", async () => {
    const { pool, sent, released } = recordingPool({ on: "BEGIN" });
    await expect(withRolledBackContext(pool, {}, async () => "never")).rejects.toThrow(
      "BEGIN failed",
    );
    expect(sent).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toEqual([undefined]);
  });

  it("destroys the connection when the rollback fails (CTO MINOR-8)", async () => {
    const { pool, released } = recordingPool({ on: "ROLLBACK" });
    await expect(withRolledBackContext(pool, {}, async () => "done")).rejects.toThrow(
      "ROLLBACK failed",
    );
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it("refuses an id that is not a UUID before borrowing a connection", async () => {
    const { pool, sent, released } = recordingPool();
    await expect(
      withRolledBackContext(pool, { playerId: "not-a-uuid" }, async () => "never"),
    ).rejects.toThrow(RangeError);
    expect(sent).toEqual([]);
    expect(released).toEqual([]);
  });
});
