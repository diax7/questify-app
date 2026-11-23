import { describe, expect, it } from "vitest";
import { attemptsLeftOf } from "#src/account/attempts-left.ts";

describe("attemptsLeftOf", () => {
  it("reads a finite number of tries", () => {
    expect(attemptsLeftOf({ attemptsLeft: 2 })).toBe(2);
    expect(attemptsLeftOf({ attemptsLeft: 0 })).toBe(0);
  });

  it("reads anything else as none left", () => {
    expect(attemptsLeftOf({})).toBe(0);
    expect(attemptsLeftOf({ attemptsLeft: "2" })).toBe(0);
    expect(attemptsLeftOf({ attemptsLeft: Number.NaN })).toBe(0);
    expect(attemptsLeftOf({ attemptsLeft: Number.POSITIVE_INFINITY })).toBe(0);
  });
});
