import { describe, expect, it } from "vitest";
import { BAR_KEYS, HOME_KEYS } from "#src/layout/layout";
import { LAYOUT_PRESETS } from "#src/layout/presets";
import { validateLayoutRequest } from "#src/layout/validate";

type Part = Partial<{ order: readonly string[]; hidden: readonly string[] }>;

const body = (changes: { bar?: Part; home?: Part }) => ({
  bar: { order: BAR_KEYS, hidden: [], ...changes.bar },
  home: { order: HOME_KEYS, hidden: [], ...changes.home },
});

const issuesOf = (input: unknown) => {
  const checked = validateLayoutRequest(input);
  return checked.ok ? [] : checked.issues;
};

describe("validateLayoutRequest", () => {
  it("accepts a reorder and a hidden item that is not protected", () => {
    const checked = validateLayoutRequest(
      body({
        bar: { order: ["rewards", "index", "scan", "quests", "profile"], hidden: ["quests"] },
        home: { order: HOME_KEYS.toReversed(), hidden: ["sponsors", "streak"] },
      }),
    );
    expect(checked.ok).toBe(true);
    expect(checked.ok ? checked.value.bar.hidden : null).toEqual(["quests"]);
  });

  it.each(LAYOUT_PRESETS.map((preset) => preset.id))(
    "applies the approved preset %s by name",
    (id) => {
      const checked = validateLayoutRequest({ preset: id });
      expect(checked.ok ? checked.value : null).toEqual(
        LAYOUT_PRESETS.find((preset) => preset.id === id)?.layout,
      );
    },
  );

  it("refuses a preset the team does not offer, and names it", () => {
    expect(issuesOf({ preset: "retired" })).toEqual([
      { path: "preset", message: "is not an approved preset" },
    ]);
  });

  it.each([
    ["Home", "bar", "index"],
    ["the scan button", "bar", "scan"],
    ["Profile, which holds Settings and legal", "bar", "profile"],
    ["the points and balance", "home", "standing"],
    ["prizes and results", "home", "prizes"],
    ["history and event info", "home", "links"],
  ] as const)("refuses to hide %s and names the item", (_name, list, item) => {
    expect(issuesOf(body({ [list]: { hidden: [item] } }))).toEqual([
      {
        path: `${list}.hidden.0`,
        message: "is always shown and cannot be hidden",
        protectedItem: item,
      },
    ]);
  });

  it("refuses a bar with more than five slots", () => {
    const issues = issuesOf(body({ bar: { order: [...BAR_KEYS, "map"] } }));
    expect(issues).toContainEqual({ path: "bar.order", message: "has more than 5 slots" });
  });

  it("refuses an item the app does not have, an item listed twice and one that is left out", () => {
    const unknown = issuesOf(body({ home: { order: [...HOME_KEYS.slice(1), "confetti"] } }));
    expect(unknown.map((issue) => issue.path)).toEqual(["home.order.10", "home.order"]);
    const twice = issuesOf(
      body({ bar: { order: ["index", "index", "scan", "rewards", "profile"] } }),
    );
    expect(twice.map((issue) => issue.message)).toEqual([
      "is listed twice",
      "must list every item; missing quests",
    ]);
  });

  it("refuses a hidden item that is not in the list, or hidden twice", () => {
    expect(issuesOf(body({ bar: { hidden: ["map"] } }))).toEqual([
      { path: "bar.hidden.0", message: "is not an item of the list" },
    ]);
    expect(issuesOf(body({ bar: { hidden: ["quests", "quests"] } }))).toEqual([
      { path: "bar.hidden.1", message: "is listed twice" },
    ]);
  });

  it.each([
    ["nothing", undefined],
    ["a string", "classic"],
    ["no Home list", { bar: { order: BAR_KEYS, hidden: [] } }],
    ["an extra field", { ...body({}), colour: "red" }],
    ["a preset beside a list", { ...body({}), preset: "classic" }],
    ["lists that are not lists", { bar: { order: "index", hidden: 1 }, home: {} }],
  ])("refuses %s", (_name, input) => {
    expect(validateLayoutRequest(input).ok).toBe(false);
  });

  it("reports every protected item at once", () => {
    const issues = issuesOf(
      body({ bar: { hidden: ["scan", "profile"] }, home: { hidden: ["standing"] } }),
    );
    expect(issues.map((issue) => issue.protectedItem)).toEqual(["scan", "profile", "standing"]);
  });
});
