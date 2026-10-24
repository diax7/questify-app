import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  EMPTY_LIVE,
  LIVE_CACHE_MS,
  LIVE_LIMIT,
  createLiveReader,
  liveEtagOf,
} from "#src/plays/live";
import { createFirstBonusCache } from "#src/quests/first-bonus";
import { fakePool } from "#test/support/fake-pool";

const unusedPool = {} as Pool;
const unusedSettings = { forEvent: () => Promise.reject(new Error("unused")) };

describe("the live read's limit (T-306)", () => {
  it("allows 30 calls a player in a minute, then says how long to wait, and starts again next minute", () => {
    let at = 60_000 * 100 + 15_000;
    const reader = createLiveReader(
      { pool: unusedPool, settings: unusedSettings, firstBonus: createFirstBonusCache() },
      () => at,
    );
    for (let call = 0; call < LIVE_LIMIT.max; call += 1) {
      expect(reader.allow("p1")).toBeUndefined();
    }
    expect(reader.allow("p1")).toBe(45);
    expect(reader.allow("p2")).toBeUndefined();
    at += 44_500;
    expect(reader.allow("p1")).toBe(1);
    at += 1_000;
    expect(reader.allow("p1")).toBeUndefined();
  });
});

const PLAYER = "33333333-3333-4333-8333-333333333333";
/** A reader whose events are all quiet; `checks` lists the events whose "anything live" was asked. */
const quietReader = (at: () => number) => {
  const checks: string[] = [];
  const fake = fakePool((sql, values) => {
    expect(sql).toContain("event_has_live");
    checks.push(String(values[0]));
    return { rows: [{ open: false }] };
  });
  return {
    reader: createLiveReader(
      { pool: fake.pool, settings: unusedSettings, firstBonus: createFirstBonusCache() },
      at,
    ),
    checks,
  };
};

describe("the live read's memory (ADR-221)", () => {
  it("keeps an event's answer for 3 seconds, then asks again", async () => {
    let at = 1_000_000;
    const { reader, checks } = quietReader(() => at);
    await reader.read(PLAYER, "e1");
    at += LIVE_CACHE_MS - 1;
    expect(await reader.read(PLAYER, "e1")).toEqual(EMPTY_LIVE);
    expect(checks).toEqual(["e1"]);
    at += 1;
    await reader.read(PLAYER, "e1");
    expect(checks).toEqual(["e1", "e1"]);
  });

  it("keeps each event apart, and empties itself past 20,000 events", async () => {
    const { reader, checks } = quietReader(() => 5_000);
    for (let n = 0; n < 20_000; n += 1) {
      await reader.read(PLAYER, `e${n}`);
    }
    await reader.read(PLAYER, "e0");
    expect(checks).toHaveLength(20_000);
    await reader.read(PLAYER, "fresh");
    await reader.read(PLAYER, "e1");
    expect(checks.slice(20_000)).toEqual(["fresh", "e1"]);
  });

  it("answers the empty state when the database answers no row", async () => {
    let live = true;
    const fake = fakePool((sql) =>
      sql.includes("event_has_live") ? { rows: live ? [{ open: true }] : [] } : { rows: [] },
    );
    let at = 0;
    const reader = createLiveReader(
      { pool: fake.pool, settings: unusedSettings, firstBonus: createFirstBonusCache() },
      () => at,
    );
    expect(await reader.read(PLAYER, "e1")).toEqual(EMPTY_LIVE);
    live = false;
    at += LIVE_CACHE_MS;
    expect(await reader.read(PLAYER, "e1")).toEqual(EMPTY_LIVE);
    expect(fake.queries.filter((sql) => sql.includes("live_state"))).toHaveLength(1);
  });

  it("forgets the minute's counts past 20,000 players", () => {
    const reader = createLiveReader(
      { pool: unusedPool, settings: unusedSettings, firstBonus: createFirstBonusCache() },
      () => 30_000,
    );
    for (let call = 0; call < LIVE_LIMIT.max; call += 1) {
      reader.allow("p0");
    }
    for (let n = 1; n < 19_999; n += 1) {
      reader.allow(`p${n}`);
    }
    expect(reader.allow("p0")).toBe(30);
    reader.allow("p19999");
    expect(reader.allow("p0")).toBeUndefined();
  });
});

describe("the live ETag", () => {
  it("is weak, the same for the same state, and another for another", () => {
    const tag = liveEtagOf(EMPTY_LIVE);
    expect(tag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(liveEtagOf({ ...EMPTY_LIVE })).toBe(tag);
    expect(
      liveEtagOf({
        ...EMPTY_LIVE,
        polls: [{ questId: "q", closesAt: "2030-01-01T00:00:00.000Z" }],
      }),
    ).not.toBe(tag);
  });
});

describe("the live read's flash quests and boosts (T-307)", () => {
  it("passes them on with their ends as ISO times, and nothing when nothing is live", async () => {
    let anything = true;
    const fake = fakePool((sql) => {
      if (sql.includes("event_has_live")) {
        return { rows: [{ open: anything }] };
      }
      return {
        rows: [
          {
            state: {
              polls: [],
              closed: [],
              community: null,
              flash: [
                {
                  questId: "q1",
                  title: { ar: null, en: "Drop" },
                  closesAt: "2030-11-01T07:10:00+00:00",
                },
              ],
              boosts: [
                {
                  boostId: "b1",
                  categoryId: "c1",
                  category: { ar: null, en: "Stage" },
                  multiplier: 2,
                  endsAt: "2030-11-01T07:30:00+00:00",
                },
              ],
            },
          },
        ],
      };
    });
    let at = 0;
    const reader = createLiveReader(
      { pool: fake.pool, settings: unusedSettings, firstBonus: createFirstBonusCache() },
      () => at,
    );
    expect(await reader.read("33333333-3333-4333-8333-333333333333", "e1")).toEqual({
      polls: [],
      closed: [],
      community: null,
      flash: [
        { questId: "q1", title: { ar: null, en: "Drop" }, closesAt: "2030-11-01T07:10:00.000Z" },
      ],
      boosts: [
        {
          boostId: "b1",
          categoryId: "c1",
          category: { ar: null, en: "Stage" },
          multiplier: 2,
          endsAt: "2030-11-01T07:30:00.000Z",
        },
      ],
      firstBonus: [],
    });
    anything = false;
    at += LIVE_CACHE_MS + 1;
    expect(await reader.read("33333333-3333-4333-8333-333333333333", "e2")).toEqual(EMPTY_LIVE);
    expect(EMPTY_LIVE).toEqual({
      polls: [],
      closed: [],
      community: null,
      flash: [],
      boosts: [],
      firstBonus: [],
    });
  });
});

const liveWith = (ids: readonly string[], free: () => number) =>
  fakePool((sql) => {
    if (sql.includes("event_has_live")) {
      return { rows: [{ open: true }] };
    }
    if (sql.includes("first_bonus_left")) {
      return {
        rows: [
          { quest_id: "q1", points: 7, slots: 5, free: free(), given: 1, real_given: 1 },
          { quest_id: "q9", points: 3, slots: 2, free: 2, given: 0, real_given: 0 },
        ],
      };
    }
    return {
      rows: [
        {
          state: {
            polls: [],
            closed: [],
            community: null,
            flash: [],
            boosts: [],
            firstBonus: ids,
          },
        },
      ],
    };
  });

describe("the live read's first-N bonuses (T-313, ADR-263)", () => {
  it("lists the bonuses live_state named with the cached left, 0 included; the ETag moves with left", async () => {
    let free = 4;
    const fake = liveWith(["q1", "gone"], () => free);
    let at = 0;
    const reader = createLiveReader(
      { pool: fake.pool, settings: unusedSettings, firstBonus: createFirstBonusCache(() => at) },
      () => at,
    );
    const first = await reader.read(PLAYER, "e1");
    expect(first.firstBonus).toEqual([{ questId: "q1", left: 4, slots: 5 }]);
    free = 0;
    at += 1000;
    expect((await reader.read(PLAYER, "e1")).firstBonus).toEqual([
      { questId: "q1", left: 4, slots: 5 },
    ]);
    at += 3000;
    const later = await reader.read(PLAYER, "e1");
    expect(later.firstBonus).toEqual([{ questId: "q1", left: 0, slots: 5 }]);
    expect(liveEtagOf(later)).not.toBe(liveEtagOf(first));
    expect(fake.queries.filter((sql) => sql.includes("first_bonus_left"))).toHaveLength(2);
  });

  it("never counts for a player live_state named no bonus quest for", async () => {
    const fake = liveWith([], () => 1);
    const reader = createLiveReader(
      { pool: fake.pool, settings: unusedSettings, firstBonus: createFirstBonusCache() },
      () => 0,
    );
    expect((await reader.read(PLAYER, "e1")).firstBonus).toEqual([]);
    expect(fake.queries.filter((sql) => sql.includes("first_bonus_left"))).toEqual([]);
  });
});
