import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import {
  deviceScreenCode,
  deviceState,
  openPairing,
  stationsOn,
  type DeviceDeps,
} from "#src/devices/devices";
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

  it("draws no other code for another DV409, or for code_taken under another SQLSTATE", async () => {
    for (const refusal of [
      { code: "DV409", detail: "wrong_kind" },
      { code: "XX000", detail: "code_taken" },
    ]) {
      const { pool, asked } = fakePool([refusal, new Date()]);
      await expect(openPairing(depsOf(pool), request, reply)).rejects.toBeDefined();
      expect(asked).toHaveLength(1);
    }
  });
});

const PAIRED = {
  state: "paired",
  id: "11111111-1111-4111-8111-111111111111",
  kind: "station",
  eventId: "22222222-2222-4222-8222-222222222222",
  questId: null,
  activated: true,
  secretHash: Buffer.alloc(32),
} as const;

/** A pool that answers the device's view and its code row; throttle reads answer room. */
function viewPool(answers: Readonly<{ view?: object; code?: object }>) {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("device_view")) {
        return { rows: [{ view: answers.view }] };
      }
      if (sql.includes("screen_code_for")) {
        return { rows: [answers.code] };
      }
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM auth_throttle")) {
        return { rows: [{ count: 0, retry_after: null }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

const settingsOf = (features: Record<string, { enabled: boolean }>) => ({
  forEvent: async () => ({ kind: "ok", config: { features } }) as never,
});

describe("stationsOn", () => {
  it("is on without a switch, off when switched off, and off when the settings cannot be read", async () => {
    await expect(stationsOn(settingsOf({}))).resolves.toBe(true);
    await expect(stationsOn(settingsOf({ stations: { enabled: false } }))).resolves.toBe(false);
    await expect(
      stationsOn({ forEvent: async () => ({ kind: "missing" }) as never }),
    ).resolves.toBe(false);
  });
});

describe("deviceState of an activated device", () => {
  const view = {
    kind: "screen",
    label: "Main hall",
    shut: null,
    event: { nameAr: null, nameEn: "Hall Fest" },
    quest: null,
  };

  it("answers a big screen with no quest", async () => {
    const deps = { ...depsOf(viewPool({ view })), settings: settingsOf({}) };
    await expect(deviceState(deps, { ...PAIRED, kind: "screen" })).resolves.toEqual({
      state: "paired",
      activated: true,
      kind: "screen",
      label: "Main hall",
      shut: null,
      event: { name: { ar: null, en: "Hall Fest" } },
      quest: null,
    });
  });

  it("shuts only a kiosk while the platform's kiosks switch is off", async () => {
    const off = settingsOf({ kiosks: { enabled: false } });
    const station = { ...depsOf(viewPool({ view: { ...view, kind: "station" } })), settings: off };
    await expect(deviceState(station, PAIRED)).resolves.toMatchObject({ shut: null });
    const kiosk = { ...depsOf(viewPool({ view: { ...view, kind: "kiosk" } })), settings: off };
    await expect(deviceState(kiosk, PAIRED)).resolves.toMatchObject({ shut: "feature_off" });
  });
});

/** A station's code answer when the database's code row is `code`. */
const codeOf = (code: object) =>
  deviceScreenCode({ ...depsOf(viewPool({ code })), settings: settingsOf({}) }, PAIRED, reply);

describe("deviceScreenCode", () => {
  const row = {
    quest_id: "33333333-3333-4333-8333-333333333333",
    shut: null,
    window_number: 1000,
    ms_to_next: 12_000,
    title_ar: null,
    title_en: "Hall B",
    points: 10,
  };

  it("shows a signed code while the quest is open", async () => {
    await expect(codeOf(row)).resolves.toMatchObject({
      state: "open",
      changesInMs: 12_000,
      quest: { title: { ar: null, en: "Hall B" }, points: 10 },
    });
  });

  it("shows no code when shut, or when the window or its end is missing", async () => {
    await expect(codeOf({ ...row, shut: "paused" })).resolves.toEqual({
      state: "paused",
      quest: { title: { ar: null, en: "Hall B" }, points: 10 },
    });
    await expect(codeOf({ ...row, window_number: null })).resolves.toMatchObject({
      state: "hidden",
    });
    await expect(codeOf({ ...row, ms_to_next: null })).resolves.toMatchObject({
      state: "hidden",
    });
  });
});
