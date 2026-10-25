import { describe, expect, it } from "vitest";
import { createFirstBonusCache, type FirstBonusCount } from "#src/quests/first-bonus";

const deferred = () => {
  let resolve!: (value: FirstBonusCount[]) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<FirstBonusCount[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("first-N cache loads that outlive an eviction", () => {
  it.each(["success", "failure"] as const)(
    "preserves a replacement when the evicted load settles with %s",
    async (outcome) => {
      const cache = createFirstBonusCache(() => 0);
      const stale = deferred();
      const oldRead = cache.get("returning-event", () => stale.promise);
      const oldSettled = oldRead.catch(() => undefined);
      // The original event and 19,999 others fill the cache; the next distinct event clears it.
      for (let n = 0; n < 20_000; n += 1) {
        await cache.get(`other-event-${n}`, () => Promise.resolve([]));
      }
      const fresh = deferred();
      const replacement = cache.get("returning-event", () => fresh.promise);
      const current: FirstBonusCount[] = [
        { questId: "current-quest", points: 9, slots: 3, left: 2, given: 1, realGiven: 1 },
      ];
      fresh.resolve(current);
      expect(await replacement).toBe(current);
      if (outcome === "success") {
        stale.resolve([]);
      } else {
        stale.reject(new Error("old load failed"));
      }
      await oldSettled;
      let reloads = 0;
      const read = cache.get("returning-event", () => {
        reloads += 1;
        return Promise.resolve([]);
      });
      expect(await read).toBe(current);
      expect(read).toBe(replacement);
      expect(reloads).toBe(0);
    },
  );
});
