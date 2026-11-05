import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { cleanModel, labelDevice } from "#src/players/devices";

describe("the device label (T-810c)", () => {
  it("keeps a model that fits the column, folded, and drops anything else", () => {
    expect(cleanModel("  iPhone 15   Pro ")).toBe("iPhone 15 Pro");
    expect(cleanModel("SM-S918B")).toBe("SM-S918B");
    expect(cleanModel("Pixel 8 (GKWS6)")).toBe("Pixel 8 (GKWS6)");
    expect(cleanModel("Sara's iPhone")).toBeNull();
    expect(cleanModel("هاتف")).toBeNull();
    expect(cleanModel("x".repeat(41))).toBeNull();
    expect(cleanModel("")).toBeNull();
    expect(cleanModel(undefined)).toBeNull();
  });

  it("never fails a sign-in, and logs only the error's class, never the platform or the model", async () => {
    const lines: Array<Readonly<Record<string, string | number>>> = [];
    const pool = {
      connect: async () => {
        throw new TypeError("connection refused");
      },
    } as unknown as Pool;
    await labelDevice(
      { pool, keys: createAuthKeys("x".repeat(64)) },
      Buffer.alloc(32),
      { platform: "ios", model: "iPhone 15 Pro" },
      {
        address: "203.0.113.9",
        userAgent: null,
        log: (event, fields = {}) => lines.push({ event, ...fields }),
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "player.device_label_failed", reason: "TypeError" });
    expect(JSON.stringify(lines)).not.toMatch(/iPhone|ios/);
  });

  it("sends nothing for an app that sent no label", async () => {
    const pool = {
      connect: async () => {
        throw new Error("must not connect");
      },
    } as unknown as Pool;
    await expect(
      labelDevice({ pool, keys: createAuthKeys("x".repeat(64)) }, Buffer.alloc(32), undefined, {
        address: "203.0.113.9",
        userAgent: null,
        log: () => undefined,
      }),
    ).resolves.toBeUndefined();
  });
});
