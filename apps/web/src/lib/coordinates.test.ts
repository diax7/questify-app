import { describe, expect, it } from "vitest";
import { isCoordinate, isRadius, pinIsValid, pinTyped } from "#src/lib/coordinates.ts";

describe("isCoordinate", () => {
  it("accepts numbers within the limit, both ends included", () => {
    expect(isCoordinate("24.7136", 90)).toBe(true);
    expect(isCoordinate("-90", 90)).toBe(true);
    expect(isCoordinate("180", 180)).toBe(true);
  });

  it("refuses blanks, words and numbers beyond the limit", () => {
    expect(isCoordinate("", 90)).toBe(false);
    expect(isCoordinate("  ", 90)).toBe(false);
    expect(isCoordinate("north", 90)).toBe(false);
    expect(isCoordinate("90.1", 90)).toBe(false);
    expect(isCoordinate("-181", 180)).toBe(false);
    expect(isCoordinate("Infinity", 180)).toBe(false);
  });
});

describe("pinIsValid", () => {
  it("treats an untouched pin as no pin", () => {
    expect(pinTyped("", " ")).toBe(false);
    expect(pinIsValid("", "")).toBe(true);
  });

  it("needs both numbers in range once either is typed", () => {
    expect(pinIsValid("24.7", "46.6")).toBe(true);
    expect(pinIsValid("24.7", "")).toBe(false);
    expect(pinIsValid("", "46.6")).toBe(false);
    expect(pinIsValid("91", "46.6")).toBe(false);
    expect(pinIsValid("24.7", "181")).toBe(false);
  });
});

describe("isRadius", () => {
  it("accepts whole metres within the bounds", () => {
    expect(isRadius("20", 20, 2000)).toBe(true);
    expect(isRadius("2000", 20, 2000)).toBe(true);
  });

  it("refuses blanks, fractions and values outside the bounds", () => {
    expect(isRadius("", 20, 2000)).toBe(false);
    expect(isRadius("19", 20, 2000)).toBe(false);
    expect(isRadius("2001", 20, 2000)).toBe(false);
    expect(isRadius("50.5", 20, 2000)).toBe(false);
  });
});
