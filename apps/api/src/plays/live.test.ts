import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { EMPTY_LIVE, LIVE_LIMIT, createLiveReader, liveEtagOf } from "#src/plays/live";

const unusedPool = {} as Pool;
const unusedSettings = { forEvent: () => Promise.reject(new Error("unused")) };

describe("the live read's limit (T-306)", () => {
  it("allows 30 calls a player in a minute, then says how long to wait, and starts again next minute", () => {
    let at = 60_000 * 100 + 15_000;
    const reader = createLiveReader({ pool: unusedPool, settings: unusedSettings }, () => at);
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
