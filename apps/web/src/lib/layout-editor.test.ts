import { BAR_PROTECTED, validateLayoutRequest, type LayoutList } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { moveBy, moveTo, positionOf, setShown } from "#src/lib/layout-editor.ts";

const list = (order: string[], hidden: string[] = []): LayoutList<string> => ({ order, hidden });
const abc = list(["a", "b", "c"]);

describe("moveTo", () => {
  it("puts an item at a place and keeps the others in order", () => {
    expect(moveTo(abc, "c", 0).order).toEqual(["c", "a", "b"]);
    expect(moveTo(abc, "a", 2).order).toEqual(["b", "c", "a"]);
    expect(moveTo(abc, "b", 1).order).toEqual(["a", "b", "c"]);
  });

  it("clamps a place past either end", () => {
    expect(moveTo(abc, "b", -4).order).toEqual(["b", "a", "c"]);
    expect(moveTo(abc, "b", 9).order).toEqual(["a", "c", "b"]);
  });

  it("leaves the list alone for an item it does not hold, and keeps the hidden set", () => {
    expect(moveTo(abc, "z", 0)).toBe(abc);
    expect(moveTo(list(["a", "b"], ["b"]), "b", 0).hidden).toEqual(["b"]);
  });
});

describe("moveBy", () => {
  it("moves one place earlier or later and stops at the ends", () => {
    expect(moveBy(abc, "b", -1).order).toEqual(["b", "a", "c"]);
    expect(moveBy(abc, "b", 1).order).toEqual(["a", "c", "b"]);
    expect(moveBy(abc, "a", -1).order).toEqual(["a", "b", "c"]);
    expect(moveBy(abc, "c", 1).order).toEqual(["a", "b", "c"]);
  });
});

describe("setShown", () => {
  const none = new Set<string>();

  it("hides an item once and shows it again", () => {
    const hidden = setShown(abc, "b", false, none);
    expect(hidden.hidden).toEqual(["b"]);
    expect(setShown(hidden, "b", false, none).hidden).toEqual(["b"]);
    expect(setShown(hidden, "b", true, none).hidden).toEqual([]);
  });

  it("never hides a protected item", () => {
    expect(setShown(abc, "b", false, new Set(["b"])).hidden).toEqual([]);
  });

  it("builds a layout the server accepts, even when asked to hide Home or the scan button", () => {
    let bar: LayoutList<string> = list(["index", "quests", "scan", "rewards", "profile"]);
    for (const key of ["index", "scan", "profile", "rewards"]) {
      bar = setShown(bar, key, false, BAR_PROTECTED as ReadonlySet<string>);
    }
    expect(bar.hidden).toEqual(["rewards"]);
    const home = list([
      "countdown",
      "standing",
      "streak",
      "announcements",
      "sponsors",
      "prizes",
      "live",
      "goal",
      "ranking",
      "upNext",
      "links",
    ]);
    expect(validateLayoutRequest({ bar, home }).ok).toBe(true);
  });
});

describe("positionOf", () => {
  it("counts from one", () => {
    expect(positionOf(abc, "a")).toBe(1);
    expect(positionOf(moveTo(abc, "a", 2), "a")).toBe(3);
  });
});
