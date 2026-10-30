import { describe, expect, it } from "vitest";
import { CHEER_FLOOD, createCheerFlood } from "#src/cheers/flood";

describe("the cheer flood counter (T-509 review)", () => {
  it("allows twice the database limit a minute, then says how long the window has left, then starts again", () => {
    let at = 60_000 * 100 + 15_000;
    const flood = createCheerFlood(() => at);
    for (let tap = 0; tap < CHEER_FLOOD.max; tap += 1) {
      expect(flood("p1")).toBeUndefined();
    }
    expect(flood("p1")).toBe(45);
    expect(flood("p2")).toBeUndefined();
    at += 44_500;
    expect(flood("p1")).toBe(1);
    at += 1_000;
    expect(flood("p1")).toBeUndefined();
  });

  it("keeps the flood limit above the database's 30 a minute, which stays the real one", () => {
    expect(CHEER_FLOOD.max).toBe(60);
  });

  it("forgets the minute's counts past 20,000 players", () => {
    const flood = createCheerFlood(() => 30_000);
    for (let tap = 0; tap < CHEER_FLOOD.max; tap += 1) {
      flood("p0");
    }
    for (let n = 1; n < 19_999; n += 1) {
      flood(`p${n}`);
    }
    expect(flood("p0")).toBe(30);
    flood("p19999");
    expect(flood("p0")).toBeUndefined();
  });
});
