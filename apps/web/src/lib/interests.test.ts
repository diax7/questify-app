import { describe, expect, it } from "vitest";
import {
  interestChoices,
  interestName,
  readInterests,
  toggleInterest,
} from "#src/lib/interests.ts";

const sport = { id: "sport", name: { ar: "رياضة", en: "Sport" } };
const music = { id: "music", name: { ar: "موسيقى", en: "Music" } };

describe("readInterests", () => {
  it("reads the list the API sends", () => {
    expect(readInterests({ interests: [sport, music] })).toEqual([sport, music]);
  });

  it("is undefined for anything else, so a broken answer is not an empty list", () => {
    expect(readInterests(undefined)).toBeUndefined();
    expect(readInterests({})).toBeUndefined();
    expect(readInterests({ interests: [{ id: "sport" }] })).toBeUndefined();
    expect(readInterests({ interests: [{ id: "Bad Id", name: sport.name }] })).toBeUndefined();
    expect(readInterests([sport])).toBeUndefined();
  });
});

describe("interestName", () => {
  it("uses the page's language and falls back to the other one", () => {
    expect(interestName(sport, "ar")).toBe("رياضة");
    expect(interestName(sport, "en")).toBe("Sport");
    expect(interestName({ id: "x", name: { ar: "", en: "X" } }, "ar")).toBe("X");
  });
});

describe("interestChoices", () => {
  it("offers the list as it is when every chosen interest is in it", () => {
    expect(interestChoices([sport, music], ["music"])).toEqual([sport, music]);
    expect(interestChoices([sport, music], [])).toEqual([sport, music]);
  });

  it("puts an interest the list no longer has first, so it is not dropped silently", () => {
    expect(interestChoices([sport], ["old"])[0]).toEqual({
      id: "old",
      name: { ar: "old", en: "old" },
    });
  });
});

describe("toggleInterest", () => {
  it("adds and removes one", () => {
    expect(toggleInterest([], "sport")).toEqual(["sport"]);
    expect(toggleInterest(["sport", "music"], "sport")).toEqual(["music"]);
  });

  it("stops at three", () => {
    const full = ["sport", "music", "tech"];
    expect(toggleInterest(full, "food")).toBe(full);
    expect(toggleInterest(full, "tech")).toEqual(["sport", "music"]);
  });
});
