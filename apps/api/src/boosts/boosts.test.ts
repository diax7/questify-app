import { describe, expect, it } from "vitest";
import {
  MAX_BOOSTS,
  boostBody,
  boostRefusalOf,
  boostsPlatformOn,
  deleteBoost,
  listBoosts,
  saveBoost,
  stopBoost,
} from "#src/boosts/boosts";
import type { ConfigResult } from "#src/settings/service";
import { fakePool, pgError } from "#test/support/fake-pool";

const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
} as const;
const settingsWith = (features: Record<string, { enabled: boolean }>) => ({
  forEvent: async (): Promise<ConfigResult> =>
    ({ kind: "ok", config: { features }, etag: "x" }) as unknown as ConfigResult,
});
const ON = settingsWith({});
const ROW = {
  id: "b1",
  categoryId: "c1",
  category: { ar: null, en: "Stage" },
  multiplier: 2,
  startsAt: "2030-11-01T07:00:00+00:00",
  endsAt: "2030-11-01T07:30:00+00:00",
  rehearsal: false,
  editable: true,
  paid: 3,
};
const VIEW = {
  ...ROW,
  startsAt: "2030-11-01T07:00:00.000Z",
  endsAt: "2030-11-01T07:30:00.000Z",
};

describe("the boost refusals (migration 0055)", () => {
  it.each([
    [{ code: "AN404" }, { kind: "not_found" }],
    [{ code: "BN404" }, { kind: "not_found" }],
    [
      { code: "BO422", detail: "outside_event" },
      { kind: "invalid", issues: ["outside_event"] },
    ],
    [{ code: "BO422" }, { kind: "invalid", issues: ["boost"] }],
    [{ code: "BO409", detail: "boost_overlap" }, { kind: "boost_overlap" }],
    [{ code: "BO409", detail: "boost_started" }, { kind: "boost_started" }],
    [{ code: "BO409", detail: "event_ended" }, { kind: "event_ended" }],
    [{ code: "BO409", detail: "not_started" }, { kind: "not_started" }],
    [
      { code: "BO409", detail: "limit_reached" },
      { kind: "limit_reached", limit: MAX_BOOSTS },
    ],
  ])("maps %o", (pg, refusal) => {
    expect(boostRefusalOf(pg)).toEqual(refusal);
  });

  it("leaves anything else to the caller", () => {
    expect(boostRefusalOf({ code: "BO409", detail: "other" })).toBeUndefined();
    expect(boostRefusalOf({ code: "BO409" })).toBeUndefined();
    expect(boostRefusalOf({ code: "23503" })).toBeUndefined();
  });
});

describe("the boost body", () => {
  it("takes a category, an optional start and 1 to 1,440 minutes", () => {
    const category = "11111111-1111-4111-8111-111111111111";
    expect(boostBody.safeParse({ categoryId: category, minutes: 1 }).success).toBe(true);
    expect(
      boostBody.safeParse({ categoryId: category, minutes: 1440, startsAt: null }).success,
    ).toBe(true);
    expect(boostBody.safeParse({ categoryId: category, minutes: 0 }).success).toBe(false);
    expect(boostBody.safeParse({ categoryId: category, minutes: 1441 }).success).toBe(false);
    expect(boostBody.safeParse({ categoryId: category, minutes: 1.5 }).success).toBe(false);
    expect(boostBody.safeParse({ categoryId: category, minutes: 5, x: 1 }).success).toBe(false);
  });
});

describe("the platform switch", () => {
  it("is on unless a Questify admin turned boosts off, and off when the settings can not be read", async () => {
    expect(await boostsPlatformOn(ON)).toBe(true);
    expect(await boostsPlatformOn(settingsWith({ boosts: { enabled: true } }))).toBe(true);
    expect(await boostsPlatformOn(settingsWith({ boosts: { enabled: false } }))).toBe(false);
    expect(
      await boostsPlatformOn({
        forEvent: async () => ({ kind: "unavailable" }) as unknown as ConfigResult,
      }),
    ).toBe(false);
  });
});

describe("the boost doors", () => {
  it("lists the event's boosts with their times as ISO strings", async () => {
    const fake = fakePool(() => ({ rows: [{ boosts: [ROW] }] }));
    expect(await listBoosts({ pool: fake.pool, settings: ON }, CONTEXT, "e1")).toEqual({
      kind: "done",
      value: [VIEW],
    });
    const none = fakePool(() => ({ rows: [{ boosts: null }] }));
    expect(await listBoosts({ pool: none.pool, settings: ON }, CONTEXT, "e1")).toEqual({
      kind: "done",
      value: [],
    });
  });

  it("saves with every field, a missing start as null, and answers the saved boost", async () => {
    const seen: unknown[][] = [];
    const fake = fakePool((sql, values) => {
      if (sql.includes("save_boost")) {
        seen.push([...values]);
        return { rows: [{ id: "b1" }] };
      }
      return { rows: [{ boosts: [ROW] }] };
    });
    const saved = await saveBoost({ pool: fake.pool, settings: ON }, CONTEXT, {
      eventId: "e1",
      boostId: null,
      body: { categoryId: "c1", minutes: 30 },
      requestId: "r1",
    });
    expect(saved).toEqual({ kind: "done", value: VIEW });
    expect(seen[0]).toEqual(["e1", null, "c1", null, 30, "r1"]);
  });

  it("answers not_found when the saved boost is not listed, and feature_off without a write", async () => {
    const fake = fakePool((sql) =>
      sql.includes("save_boost") ? { rows: [{ id: "b9" }] } : { rows: [{ boosts: [ROW] }] },
    );
    const request = {
      eventId: "e1",
      boostId: "b9",
      body: { categoryId: "c1", startsAt: "2030-11-01T07:00:00Z", minutes: 30 },
      requestId: "r1",
    };
    expect(await saveBoost({ pool: fake.pool, settings: ON }, CONTEXT, request)).toEqual({
      kind: "not_found",
    });
    const off = fakePool(() => ({ rows: [] }));
    expect(
      await saveBoost(
        { pool: off.pool, settings: settingsWith({ boosts: { enabled: false } }) },
        CONTEXT,
        request,
      ),
    ).toEqual({ kind: "feature_off" });
    expect(off.queries).toEqual([]);
  });

  it("answers event_feature_off without a write while the event's own switch is off", async () => {
    const fake = fakePool((sql) => {
      if (sql.includes("save_boost")) {
        throw new Error("a boost was written while the event's switch was off");
      }
      return { rows: [{ on: false }] };
    });
    expect(
      await saveBoost({ pool: fake.pool, settings: ON }, CONTEXT, {
        eventId: "e1",
        boostId: null,
        body: { categoryId: "c1", minutes: 30 },
        requestId: "r1",
      }),
    ).toEqual({ kind: "event_feature_off" });
  });

  it("turns a refusal into its kind and throws anything else", async () => {
    const refusing = fakePool(() => {
      throw pgError({ code: "BO409", detail: "boost_started" });
    });
    expect(
      await deleteBoost({ pool: refusing.pool, settings: ON }, CONTEXT, {
        eventId: "e1",
        boostId: "b1",
        requestId: "r1",
      }),
    ).toEqual({ kind: "boost_started" });
    const broken = pgError({ code: "XX000" });
    const failing = fakePool(() => {
      throw broken;
    });
    await expect(
      deleteBoost({ pool: failing.pool, settings: ON }, CONTEXT, {
        eventId: "e1",
        boostId: "b1",
        requestId: "r1",
      }),
    ).rejects.toBe(broken);
  });

  it("deletes and stops with the request's id; a stop answers its window", async () => {
    const seen: string[] = [];
    const fake = fakePool((sql) => {
      seen.push(sql);
      return sql.includes("end_boost")
        ? {
            rows: [
              {
                starts_at: new Date("2030-11-01T07:00:00Z"),
                ends_at: new Date("2030-11-01T07:05:00Z"),
                replayed: true,
              },
            ],
          }
        : { rows: [{}] };
    });
    const target = { eventId: "e1", boostId: "b1", requestId: "r1" };
    expect(await deleteBoost({ pool: fake.pool, settings: ON }, CONTEXT, target)).toEqual({
      kind: "done",
      value: null,
    });
    expect(await stopBoost({ pool: fake.pool, settings: ON }, CONTEXT, target)).toEqual({
      kind: "done",
      value: {
        startsAt: "2030-11-01T07:00:00.000Z",
        endsAt: "2030-11-01T07:05:00.000Z",
        replayed: true,
      },
    });
    expect(seen).toEqual([
      "SELECT delete_boost($1, $2, $3)",
      "SELECT * FROM end_boost($1, $2, $3)",
    ]);
  });
});
