import { describe, expect, it } from "vitest";
import { interpolate, placeholdersOf } from "./placeholders";

describe("placeholdersOf", () => {
  it("finds each placeholder once, sorted", () => {
    expect(placeholdersOf("{points} {player} {points}")).toEqual(["player", "points"]);
  });

  it("finds none in plain text", () => {
    expect(placeholdersOf("no placeholders here")).toEqual([]);
    expect(placeholdersOf("")).toEqual([]);
  });

  it("works in Arabic text", () => {
    expect(placeholdersOf("مرحبا {player}، لديك {points} نقطة")).toEqual(["player", "points"]);
  });

  it.each(["{}", "{ player }", "{1abc}", "{pla yer}", "{{", "}player{", "{pla-yer}"])(
    "does not count %j",
    (text) => {
      expect(placeholdersOf(text)).toEqual([]);
    },
  );

  it("accepts letters and digits after the first letter", () => {
    expect(placeholdersOf("{a1} {Player2} {aB3c}")).toEqual(["Player2", "a1", "aB3c"]);
  });
});

describe("interpolate", () => {
  it("fills every occurrence of a placeholder", () => {
    expect(interpolate("{a}-{a}-{b}", { a: "x", b: "y" }, "en")).toBe("x-x-y");
  });

  it("formats numbers with Western digits in both languages", () => {
    expect(interpolate("{points}", { points: 20000 }, "ar")).toBe("20,000");
    expect(interpolate("{points}", { points: 20000 }, "en")).toBe("20,000");
  });

  it("leaves text without placeholders unchanged", () => {
    expect(interpolate("plain", { a: 1 }, "en")).toBe("plain");
  });

  it("leaves a placeholder in place when no value was given, so a missing value is visible", () => {
    expect(interpolate("hi {player}", {}, "en")).toBe("hi {player}");
  });

  it("does not treat a value as text to fill again", () => {
    expect(interpolate("{a} {b}", { a: "{b}", b: "x" }, "en")).toBe("{b} x");
  });

  it("ignores values that have no placeholder", () => {
    expect(interpolate("hi", { player: "Sara" }, "en")).toBe("hi");
  });
});
