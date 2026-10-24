import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { openPairing, type DeviceDeps } from "#src/devices/devices";
import { createScreenCodeKey } from "#src/quests/qr";

const drawn = vi.hoisted(() => ({ codes: [] as string[] }));
vi.mock("#src/devices/pairing-code", async (original) => ({
  ...(await original<typeof import("#src/devices/pairing-code")>()),
  generatePairingCode: () => drawn.codes.shift() ?? "ZZZZZZZZ",
}));

type Refusal = Readonly<{ code: string; detail?: string }>;

/** A pool whose pairing door answers each attempt in turn (a refusal, or an expiry); throttle reads answer room. */
function fakePool(answers: Array<Refusal | Date>) {
  const asked: Buffer[] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("open_device_request")) {
        asked.push(values[1] as Buffer);
        const next = answers.shift();
        if (next === undefined || !(next instanceof Date)) {
          throw Object.assign(new Error("refused"), next ?? { code: "XX000" });
        }
        return { rows: [{ at: next }] };
      }
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM auth_throttle")) {
        return { rows: [{ count: 0, retry_after: null }] };
      }
      if (sql.includes("INSERT INTO auth_throttle")) {
        return { rows: [{ at: "now" }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, asked };
}

const keys = createAuthKeys("k".repeat(40));
const depsOf = (pool: Pool, alarm = vi.fn()): DeviceDeps => ({
  pool,
  keys,
  screenKey: createScreenCodeKey("q".repeat(40)),
  settings: { forEvent: async () => ({ kind: "missing" }) as never },
  dashboardOrigin: "https://app.questify.test",
  alarm,
});
const reply = { header: () => undefined };
const request = { kind: "station" as const, client: "", address: "198.51.100.7" };

describe("openPairing's code draw (T-309)", () => {
  beforeEach(() => {
    drawn.codes = ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "DDDDDDDD"];
  });

  it("draws another code when one is taken, and shows the one that was stored", async () => {
    const expires = new Date("2026-10-24T10:10:00Z");
    const { pool, asked } = fakePool([{ code: "DV409", detail: "code_taken" }, expires]);
    const made = await openPairing(depsOf(pool), request, reply);
    expect(made.shown).toEqual({
      state: "pending",
      kind: "station",
      code: "BBBB-BBBB",
      expiresAt: expires.toISOString(),
    });
    expect(asked.map((hash) => hash.toString("hex"))).toEqual([
      keys.pairingCodeHash("AAAAAAAA").toString("hex"),
      keys.pairingCodeHash("BBBBBBBB").toString("hex"),
    ]);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("answers busy after three taken codes, without alarming", async () => {
    const alarm = vi.fn();
    const taken = { code: "DV409", detail: "code_taken" };
    const { pool, asked } = fakePool([taken, taken, taken]);
    await expect(openPairing(depsOf(pool, alarm), request, reply)).rejects.toMatchObject({
      status: 503,
    });
    expect(asked).toHaveLength(3);
    expect(alarm).not.toHaveBeenCalled();
  });

  it("answers busy at the flood cap and alerts ops (CTO 9)", async () => {
    const alarm = vi.fn();
    const { pool, asked } = fakePool([{ code: "DV503", detail: "busy" }]);
    await expect(openPairing(depsOf(pool, alarm), request, reply)).rejects.toMatchObject({
      status: 503,
    });
    expect(asked).toHaveLength(1);
    expect(alarm).toHaveBeenCalledWith("device.request_flood", { kind: "station" });
  });

  it("lets any other failure through as it is", async () => {
    const { pool } = fakePool([{ code: "XX000" }]);
    await expect(openPairing(depsOf(pool), request, reply)).rejects.toThrow("refused");
  });
});
