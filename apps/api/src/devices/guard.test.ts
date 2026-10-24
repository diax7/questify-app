import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { deviceOfToken } from "#src/devices/guard";

describe("deviceOfToken", () => {
  it("never asks the database about a cookie that is not a token", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as Pool;
    for (const token of [undefined, "", "short", "a".repeat(42), `${"a".repeat(42)}!`]) {
      await expect(deviceOfToken(pool, token)).resolves.toBeUndefined();
    }
    expect(query).not.toHaveBeenCalled();
  });
});
