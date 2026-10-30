import { describe, expect, it } from "vitest";
import { celebrates, finaleSeenKey, readFinale } from "#src/event/finale.ts";

describe("the finale on Home", () => {
  it("reads the player's own place, or none, and nothing else", () => {
    expect(readFinale({ place: 2 })).toEqual({ place: 2 });
    expect(readFinale({ place: null })).toEqual({ place: null });
    expect(readFinale({ place: 2, score: 900, username: "sara" })).toEqual({ place: 2 });
  });

  it("shows none for an older API, a missing place or one it cannot read", () => {
    expect(readFinale(undefined)).toBeNull();
    expect(readFinale(null)).toBeNull();
    expect(readFinale("yes")).toBeNull();
    expect(readFinale({})).toBeNull();
    expect(readFinale({ place: "1" })).toBeNull();
    expect(readFinale({ place: 0 })).toBeNull();
    expect(readFinale({ place: 1.5 })).toBeNull();
  });

  it("plays once per event on this phone, only after the reveal", () => {
    expect(celebrates({ place: 1 }, false)).toBe(true);
    expect(celebrates({ place: null }, false)).toBe(true);
    expect(celebrates({ place: 1 }, true)).toBe(false);
    expect(celebrates(null, false)).toBe(false);
    expect(finaleSeenKey("e1")).not.toBe(finaleSeenKey("e2"));
  });
});
