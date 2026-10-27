import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import {
  boostApplied,
  bonusPaid,
  completeQuest,
  levelReached,
  locationQuestsOn,
  type CompletionDeps,
  type CompletionRequest,
} from "#src/completions/complete";
import { createQuestCodeKey, createScreenCodeKey, questCode } from "#src/quests/qr";
import type { SettingsService } from "#src/settings/service";

const SECRET = "x".repeat(32);
const QUEST = "3b9f7a1e-0c52-4f0e-9d6a-1c2b3d4e5f60";
const PLAYER = "7a1d2c3b-4e5f-4a60-8b71-92a3b4c5d6e7";

type Reply = { rows: unknown[] } | Error | unknown;
type Query = { sql: string; params: unknown[] | undefined };

const ENGINE_ROW = {
  completion_id: "c1",
  points: "10",
  occurrence: 1,
  score: "10",
  balance: "10",
  replayed: false,
};

/** A database that answers by SQL text: `replies` match first, then the throttle and transaction defaults. */
function fakeDatabase(replies: Readonly<Record<string, Reply>> = {}) {
  const queries: Query[] = [];
  const answer = (sql: string): Reply => {
    for (const [fragment, reply] of Object.entries(replies)) {
      if (sql.includes(fragment)) {
        return reply;
      }
    }
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (sql.includes("count(*)")) {
      return { rows: [{ count: 0, retry_after: null }] };
    }
    if (sql.includes("INSERT INTO auth_throttle")) {
      return { rows: [{ at: "2026-10-27 10:00:00+00" }] };
    }
    if (sql.includes("complete_quest")) {
      return { rows: [ENGINE_ROW] };
    }
    return { rows: [] };
  };
  const client = {
    query: vi.fn((sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const reply = answer(sql);
      return reply instanceof Error || typeof reply === "string"
        ? Promise.reject(reply)
        : Promise.resolve(reply);
    }),
    release: vi.fn(),
  };
  const connect = vi.fn(() => Promise.resolve(client));
  return {
    pool: { connect } as unknown as Pool,
    client: client as unknown as PoolClient,
    connect,
    queries,
    engineCalls: () => queries.filter((query) => query.sql.includes("complete_quest")),
  };
}

const settingsWith = (features: Record<string, unknown>) => ({
  forEvent: vi.fn(() =>
    Promise.resolve({ kind: "ok" as const, config: { features }, etag: "e" } as never),
  ),
});

const qr = () => ({
  type: "qr" as const,
  code: questCode(createQuestCodeKey(SECRET), QUEST, 1),
});

const POSITION = { lat: 24.7, lng: 46.7, accuracyM: 5, ageS: 1 };

const requestOf = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  playerId: PLAYER,
  questId: QUEST,
  proof: { type: "code", code: "ABCD" },
  position: null,
  idempotencyKey: "key-1",
  deviceId: undefined,
  ...overrides,
});

const callerWith = () => {
  const log = vi.fn();
  return { log, caller: { address: "1.2.3.4", userAgent: null, log } as Caller };
};

const depsOf = (
  pool: Pool,
  settings: Pick<SettingsService, "forEvent"> = settingsWith({}),
): CompletionDeps => ({
  pool,
  codeKey: createQuestCodeKey(SECRET),
  screenKey: createScreenCodeKey(SECRET),
  keys: createAuthKeys(SECRET),
  settings,
});

describe("how the engine's refusals are told apart", () => {
  it("answers an operator who may not play with its own reason", async () => {
    const db = fakeDatabase({ complete_quest: Object.assign(new Error("no"), { code: "QP403" }) });
    const { caller } = callerWith();
    expect(await completeQuest(depsOf(db.pool), requestOf(), caller)).toEqual({
      kind: "enrollment_inactive",
      reason: "operator_not_playing",
    });
  });

  it("passes the detail on, and an empty reason when the engine gave none", async () => {
    const withDetail = fakeDatabase({
      complete_quest: Object.assign(new Error("no"), { code: "QC403", detail: "ended" }),
    });
    const without = fakeDatabase({
      complete_quest: Object.assign(new Error("no"), { code: "QC403" }),
    });
    const { caller } = callerWith();
    expect(await completeQuest(depsOf(withDetail.pool), requestOf(), caller)).toEqual({
      kind: "enrollment_inactive",
      reason: "ended",
    });
    expect(await completeQuest(depsOf(without.pool), requestOf(), caller)).toEqual({
      kind: "enrollment_inactive",
      reason: "",
    });
  });

  it("rethrows an error that is no known refusal, with or without a code", async () => {
    const { caller } = callerWith();
    const unknownCode = fakeDatabase({
      complete_quest: Object.assign(new Error("boom"), { code: "XX000" }),
    });
    const noCode = fakeDatabase({ complete_quest: new Error("down") });
    await expect(completeQuest(depsOf(unknownCode.pool), requestOf(), caller)).rejects.toThrow(
      "boom",
    );
    await expect(completeQuest(depsOf(noCode.pool), requestOf(), caller)).rejects.toThrow("down");
  });

  it("reads a check-in refusal's distance from the hint", async () => {
    const db = fakeDatabase({
      complete_quest: Object.assign(new Error("far"), {
        code: "QV422",
        detail: "not_here",
        hint: "120",
      }),
    });
    const { caller } = callerWith();
    const result = await completeQuest(
      depsOf(db.pool, settingsWith({ locationQuests: { enabled: true } })),
      requestOf({ proof: { type: "location" }, position: POSITION }),
      caller,
    );
    expect(result).toEqual({ kind: "location_refused", reason: "not_here", distanceM: 120 });
  });
});

describe("giving a held attempt back", () => {
  const throttleDelete = "DELETE FROM auth_throttle";

  it("logs the error's name when the database drops while giving it back", async () => {
    const db = fakeDatabase({ [throttleDelete]: new TypeError("gone") });
    const { caller, log } = callerWith();
    const result = await completeQuest(depsOf(db.pool), requestOf(), caller);
    expect(result.kind).toBe("completed");
    expect(log).toHaveBeenCalledWith("quest.code_release_failed", { reason: "TypeError" });
  });

  it("logs 'unknown' when what was thrown is no Error", async () => {
    const db = fakeDatabase({ [throttleDelete]: "not an error object" });
    const { caller, log } = callerWith();
    await completeQuest(depsOf(db.pool), requestOf(), caller);
    expect(log).toHaveBeenCalledWith("quest.code_release_failed", { reason: "unknown" });
  });

  it("gives the held attempt back when the engine fails on a typed code", async () => {
    const db = fakeDatabase({ complete_quest: new Error("down") });
    const { caller } = callerWith();
    await expect(completeQuest(depsOf(db.pool), requestOf(), caller)).rejects.toThrow("down");
    expect(db.queries.some((query) => query.sql.includes(throttleDelete))).toBe(true);
  });

  it("has nothing to give back for a QR scan, and logs no failed release", async () => {
    const db = fakeDatabase({ complete_quest: new Error("down") });
    const { caller, log } = callerWith();
    await expect(
      completeQuest(depsOf(db.pool), requestOf({ proof: qr() }), caller),
    ).rejects.toThrow("down");
    expect(log).not.toHaveBeenCalledWith("quest.code_release_failed", expect.anything());
    expect(db.connect).toHaveBeenCalledTimes(1);
  });
});

describe("when the platform's location switch is read", () => {
  it("is not read for a scan that sent no reading", async () => {
    const db = fakeDatabase();
    const settings = settingsWith({ locationQuests: { enabled: true } });
    const { caller } = callerWith();
    await completeQuest(depsOf(db.pool, settings), requestOf({ proof: qr() }), caller);
    expect(settings.forEvent).not.toHaveBeenCalled();
  });

  it("passes a scan's reading on only while the switch is on", async () => {
    const { caller } = callerWith();
    const on = fakeDatabase();
    await completeQuest(
      depsOf(on.pool, settingsWith({ locationQuests: { enabled: true } })),
      requestOf({ proof: qr(), position: POSITION }),
      caller,
    );
    expect(on.engineCalls()[0]?.params?.[6]).toEqual(POSITION);

    const off = fakeDatabase();
    await completeQuest(
      depsOf(off.pool, settingsWith({ locationQuests: { enabled: false } })),
      requestOf({ proof: qr(), position: POSITION }),
      caller,
    );
    expect(off.engineCalls()[0]?.params?.[6]).toBeNull();
  });

  it("refuses a check-in while the switch is off, without asking the engine", async () => {
    const db = fakeDatabase();
    const { caller } = callerWith();
    const result = await completeQuest(
      depsOf(db.pool, settingsWith({})),
      requestOf({ proof: { type: "location" }, position: POSITION }),
      caller,
    );
    expect(result).toEqual({ kind: "feature_off" });
    expect(db.engineCalls()).toHaveLength(0);
  });
});

describe("locationQuestsOn", () => {
  it("is on only for an ok configuration with the switch enabled", async () => {
    expect(await locationQuestsOn(settingsWith({ locationQuests: { enabled: true } }))).toBe(true);
    expect(await locationQuestsOn(settingsWith({ locationQuests: { enabled: false } }))).toBe(
      false,
    );
  });

  it("is off when the configuration has no such switch", async () => {
    expect(await locationQuestsOn(settingsWith({}))).toBe(false);
  });

  it("is off when no configuration could be composed", async () => {
    const settings = { forEvent: () => Promise.resolve({ kind: "event_not_found" as const }) };
    expect(await locationQuestsOn(settings)).toBe(false);
  });
});

describe("the level a completion reached", () => {
  const level = { level_up: 3, up_title_ar: "ثلاثة", up_title_en: "Three" };
  const item = { kind: "badge", id: "b1" };

  it("is null when the credit reached no level, or the engine gave no row", async () => {
    const none = fakeDatabase({ "FROM own_level(": { rows: [] } });
    const same = fakeDatabase({ "FROM own_level(": { rows: [{ ...level, level_up: null }] } });
    expect(await levelReached(none.client, "c1")).toBeNull();
    expect(await levelReached(same.client, "c1")).toBeNull();
  });

  it("carries the title and the items the level gave", async () => {
    const db = fakeDatabase({
      "FROM own_level(": { rows: [level] },
      "own_level_items($1)": { rows: [{ items: [item] }] },
    });
    expect(await levelReached(db.client, "c1")).toEqual({
      level: 3,
      title: { ar: "ثلاثة", en: "Three" },
      items: [item],
    });
    expect(db.queries.some((query) => query.sql.includes("own_level_items($1)"))).toBe(true);
  });

  it("has no items when none came back", async () => {
    const noRow = fakeDatabase({ "FROM own_level(": { rows: [level] } });
    const nullItems = fakeDatabase({
      "FROM own_level(": { rows: [level] },
      "own_level_items($1)": { rows: [{ items: null }] },
    });
    expect((await levelReached(noRow.client, "c1"))?.items).toEqual([]);
    expect((await levelReached(nullItems.client, "c1"))?.items).toEqual([]);
  });
});

describe("the boost a completion was paid with", () => {
  it("is null when no row or no multiplier came back", async () => {
    const none = fakeDatabase({ completion_boost: { rows: [] } });
    const unboosted = fakeDatabase({ completion_boost: { rows: [{ multiplier: null }] } });
    expect(await boostApplied(none.client, "c1")).toBeNull();
    expect(await boostApplied(unboosted.client, "c1")).toBeNull();
  });

  it("carries the multiplier", async () => {
    const db = fakeDatabase({ completion_boost: { rows: [{ multiplier: 2 }] } });
    expect(await boostApplied(db.client, "c1")).toEqual({ multiplier: 2 });
  });
});

describe("the category bonus and its item", () => {
  const bonusRow = {
    category_id: "k1",
    points: "50",
    name_ar: "فئة",
    name_en: "Category",
    item_ar: "قبعة",
    item_en: "Cap",
    item_outcome: "pending",
    item_until: new Date("2026-11-01T10:00:00.000Z"),
    item_time_zone: "Asia/Riyadh",
  };

  it("names the item with its deadline and the event's zone", async () => {
    const db = fakeDatabase({ own_bonus: { rows: [bonusRow] } });
    expect(await bonusPaid(db.client, "c1")).toEqual({
      categoryId: "k1",
      points: 50,
      category: { ar: "فئة", en: "Category" },
      item: {
        name: { ar: "قبعة", en: "Cap" },
        outcome: "pending",
        until: { at: "2026-11-01T10:00:00.000Z", timeZone: "Asia/Riyadh" },
      },
    });
  });

  it("has no item when the category gave none", async () => {
    const db = fakeDatabase({
      own_bonus: { rows: [{ ...bonusRow, item_outcome: null, item_ar: null, item_en: null }] },
    });
    expect((await bonusPaid(db.client, "c1"))?.item).toBeNull();
  });

  it("has no deadline without the event's zone", async () => {
    const db = fakeDatabase({ own_bonus: { rows: [{ ...bonusRow, item_time_zone: null }] } });
    expect((await bonusPaid(db.client, "c1"))?.item?.until).toBeNull();
  });
});
