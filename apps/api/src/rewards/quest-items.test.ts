import { describe, expect, it } from "vitest";
import { itemOf, refusalOf } from "#src/rewards/quest-items";

describe("refusalOf", () => {
  it.each([
    ["AN404", "", { kind: "not_found" }],
    ["DL409", "", { kind: "desk_needed" }],
    ["QI409", "item_in_use", { kind: "item_in_use" }],
    ["QI409", "removed", undefined],
    ["23514", "item_in_use", undefined],
    ["23514", "", undefined],
    [undefined, "", undefined],
  ] as const)("maps %s %s", (code, detail, expected) => {
    expect(refusalOf(code, detail)).toEqual(expected);
  });
});

describe("itemOf", () => {
  it("reads a quest_items row with its links", () => {
    expect(
      itemOf({
        id: "i1",
        name_ar: "قميص",
        name_en: null,
        description_ar: null,
        description_en: "One size",
        stock_total: 10,
        units_out: 4,
        stock_left: 6,
        missed: 2,
        quests: [{ id: "q1", ar: null, en: "Lion" }],
        categories: [{ id: "c1", ar: "المرحلة", en: "Stage" }],
      }),
    ).toEqual({
      id: "i1",
      name: { ar: "قميص", en: null },
      description: { ar: null, en: "One size" },
      stockTotal: 10,
      unitsOut: 4,
      stockLeft: 6,
      missed: 2,
      quests: [{ id: "q1", name: { ar: null, en: "Lion" } }],
      categories: [{ id: "c1", name: { ar: "المرحلة", en: "Stage" } }],
    });
  });

  it("reads a missing or non-text name as null, and the Arabic description", () => {
    expect(itemOf({ id: "i3", name_ar: 5, description_ar: "مقاس واحد" })).toMatchObject({
      name: { ar: null, en: null },
      description: { ar: "مقاس واحد", en: null },
    });
  });

  it("reads no links as none", () => {
    expect(itemOf({ id: "i2", quests: null, categories: undefined })).toMatchObject({
      quests: [],
      categories: [],
    });
  });
});
