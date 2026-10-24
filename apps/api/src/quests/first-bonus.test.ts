import { describe, expect, it } from "vitest";
import {
  FIRST_BONUS_CACHE_MS,
  builderBonusOf,
  createFirstBonusCache,
  type FirstBonusCount,
} from "#src/quests/first-bonus";

const count = (left: number): FirstBonusCount => ({
  questId: "q1",
  points: 7,
  slots: 5,
  left,
  given: 5 - left,
  realGiven: 5 - left,
});

describe("the first-N bonus cache (T-313, ADR-263)", () => {
  it("shares one load among concurrent callers and keeps it for 2 seconds, then loads again", async () => {
    let at = 1_000;
    let loads = 0;
    const cache = createFirstBonusCache(() => at);
    const load = () => {
      loads += 1;
      return Promise.resolve([count(5 - loads)]);
    };
    const [one, two] = await Promise.all([cache.get("e1", load), cache.get("e1", load)]);
    expect(one).toBe(two);
    expect(loads).toBe(1);
    at += FIRST_BONUS_CACHE_MS - 1;
    expect(await cache.get("e1", load)).toEqual([count(4)]);
    expect(loads).toBe(1);
    at += 1;
    expect(await cache.get("e1", load)).toEqual([count(3)]);
    expect(loads).toBe(2);
  });

  it("keeps each event apart", async () => {
    const cache = createFirstBonusCache(() => 0);
    const seen: string[] = [];
    const load = (event: string) => () => {
      seen.push(event);
      return Promise.resolve([]);
    };
    await cache.get("e1", load("e1"));
    await cache.get("e2", load("e2"));
    await cache.get("e1", load("e1"));
    expect(seen).toEqual(["e1", "e2"]);
  });

  it("never keeps a failed load: the next caller loads afresh", async () => {
    const cache = createFirstBonusCache(() => 0);
    await expect(cache.get("e1", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cache.get("e1", () => Promise.resolve([count(2)]))).toEqual([count(2)]);
  });

  it("empties itself past 20,000 events", async () => {
    const cache = createFirstBonusCache(() => 0);
    let loads = 0;
    const load = () => {
      loads += 1;
      return Promise.resolve([]);
    };
    for (let n = 0; n < 20_000; n += 1) {
      await cache.get(`e${n}`, load);
    }
    await cache.get("e0", load);
    expect(loads).toBe(20_000);
    await cache.get("fresh", load);
    await cache.get("e1", load);
    expect(loads).toBe(20_002);
  });
});

describe("the builder's view of a bonus", () => {
  it("locks once a real player got it, never for rehearsal claims alone", () => {
    expect(builderBonusOf({ ...count(3), given: 2, realGiven: 0 })).toEqual({
      points: 7,
      slots: 5,
      given: 2,
      left: 3,
      locked: false,
    });
    expect(builderBonusOf({ ...count(3), realGiven: 1 }).locked).toBe(true);
  });
});
