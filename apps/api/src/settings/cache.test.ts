import { describe, expect, it } from "vitest";
import { createTtlCache } from "#src/settings/cache";

const make = (ttlMs = 1000, maxEntries = 3) => {
  const clock = { now: 10_000 };
  const cache = createTtlCache<string>({ ttlMs, maxEntries, now: () => clock.now });
  return { cache, clock };
};

describe("createTtlCache", () => {
  it("returns what was stored, and undefined for what was not", () => {
    const { cache } = make();
    cache.set("a", "1");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBeUndefined();
  });

  it("keeps an entry until just before its time is up and drops it at the moment it is", () => {
    const { cache, clock } = make(1000);
    cache.set("a", "1");
    clock.now += 999;
    expect(cache.get("a")).toBe("1");
    clock.now += 1;
    expect(cache.get("a")).toBeUndefined();
  });

  it("starts the time again when a key is stored again", () => {
    const { cache, clock } = make(1000);
    cache.set("a", "1");
    clock.now += 800;
    cache.set("a", "2");
    clock.now += 800;
    expect(cache.get("a")).toBe("2");
  });

  it("forgets the oldest entry when it holds more than its maximum", () => {
    const { cache } = make(1000, 3);
    for (const key of ["a", "b", "c", "d"]) {
      cache.set(key, key);
    }
    expect(cache.get("a")).toBeUndefined();
    expect(["b", "c", "d"].map((key) => cache.get(key))).toEqual(["b", "c", "d"]);
  });

  it("counts a re-stored key as the newest, not the oldest", () => {
    const { cache } = make(1000, 3);
    for (const key of ["a", "b", "c"]) {
      cache.set(key, key);
    }
    cache.set("a", "again");
    cache.set("d", "d");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("again");
  });

  it("empties on clear", () => {
    const { cache } = make();
    cache.set("a", "1");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });
});
