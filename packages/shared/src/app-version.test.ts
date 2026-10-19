import { describe, expect, it } from "vitest";
import { compareVersions, isBelowMinimum } from "./app-version";

describe("compareVersions", () => {
  it.each([
    ["1.0.0", "1.0.0", 0],
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.0.1", -1],
    ["1.10.0", "1.9.9", 1],
    ["2.0.0", "1.99.99", 1],
    ["1.2", "1.2.0", 0],
    ["1.2.4", "1.2.3", 1],
    ["1.2.3", "1.2.4", -1],
    ["1.3.0", "1.2.9", 1],
    ["1.2.9", "1.3.0", -1],
    ["10.0.0", "9.0.0", 1],
  ])("%s vs %s is %d", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each(["", "a.b.c", "1..2", "1.2.3.4", "-1.0.0", "1", " 1.0.0", "1.0.0 "])(
    "rejects %j",
    (bad) => {
      expect(() => compareVersions(bad, "1.0.0")).toThrow(RangeError);
    },
  );
});

describe("isBelowMinimum", () => {
  it("is true only when the app is older than the minimum", () => {
    expect(isBelowMinimum("1.0.2", "1.0.3")).toBe(true);
    expect(isBelowMinimum("1.0.3", "1.0.3")).toBe(false);
    expect(isBelowMinimum("1.1.0", "1.0.3")).toBe(false);
  });
});
