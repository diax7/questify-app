import { describe, expect, it } from "vitest";
import {
  fieldsInUse,
  ruleArgs,
  ruleOf,
  type FieldState,
  type TargetedItem,
} from "#src/audience/rules";

const SECTION: FieldState = {
  id: "f1",
  options: [
    { id: "women", ar: "نساء", en: "Women" },
    { id: "men", ar: "رجال", en: "Men" },
  ],
};
const TEAM: FieldState = { id: "f2", options: null };
const KIDS = { id: "kids", ar: null, en: "Kids" };
const [WOMEN, MEN] = SECTION.options ?? [];

const ladies: TargetedItem = {
  kind: "category",
  name: { ar: "سيدات", en: "Ladies" },
  fieldId: "f1",
  values: ["women"],
};
const spa: TargetedItem = {
  kind: "reward",
  name: { ar: null, en: "Spa" },
  fieldId: "f1",
  values: ["women"],
};

const keep = (entries: [string, FieldState["options"]][]) => new Map(entries);

describe("targeting rules", () => {
  it("reads a rule from its columns", () => {
    expect(
      ruleOf({ audience_kind: null, audience_field_id: null, audience_values: null }),
    ).toBeNull();
    expect(
      ruleOf({ audience_kind: "answer", audience_field_id: "f1", audience_values: ["men"] }),
    ).toEqual({
      kind: "answer",
      fieldId: "f1",
      values: ["men"],
    });
    expect(
      ruleOf({ audience_kind: "tag", audience_field_id: null, audience_values: ["vip"] }),
    ).toEqual({
      kind: "tag",
      values: ["vip"],
    });
    expect(
      ruleOf({ audience_kind: "answer", audience_field_id: null, audience_values: ["x"] }),
    ).toBeNull();
    expect(
      ruleOf({ audience_kind: "tag", audience_field_id: null, audience_values: null }),
    ).toEqual({
      kind: "tag",
      values: [],
    });
  });

  it("gives set_audience its arguments", () => {
    expect(ruleArgs(null)).toEqual([null, null, null]);
    expect(ruleArgs({ kind: "answer", fieldId: "f1", values: ["men"] })).toEqual([
      "answer",
      "f1",
      ["men"],
    ]);
    expect(ruleArgs({ kind: "tag", values: ["vip"] })).toEqual(["tag", null, ["vip"]]);
  });
});

describe("fields in use", () => {
  it("lets labels change, options be added and unused ones go", () => {
    const relabelled = [{ ...WOMEN, en: "Ladies" }, KIDS] as FieldState["options"];
    expect(
      fieldsInUse(
        [SECTION, TEAM],
        keep([
          ["f1", relabelled],
          ["f2", null],
        ]),
        [{ fieldId: "f1", chosen: ["women"] }],
        [ladies],
      ),
    ).toBeUndefined();
  });

  it("refuses deleting a field a rule names, naming the items", () => {
    expect(fieldsInUse([SECTION, TEAM], keep([["f2", null]]), [], [ladies, spa])).toEqual({
      reason: "rules",
      categories: [ladies.name],
      rewards: [spa.name],
    });
  });

  it("lets a field with answers but no rule be deleted", () => {
    expect(
      fieldsInUse([SECTION], keep([]), [{ fieldId: "f1", chosen: ["men"] }], []),
    ).toBeUndefined();
  });

  it("refuses removing an option a rule names, or clearing the options of a named field", () => {
    expect(
      fieldsInUse([SECTION], keep([["f1", [MEN, KIDS] as FieldState["options"]]]), [], [ladies]),
    ).toMatchObject({ reason: "rules", categories: [ladies.name], rewards: [] });
    expect(fieldsInUse([SECTION], keep([["f1", null]]), [], [spa])).toMatchObject({
      reason: "rules",
    });
    const other: TargetedItem = { ...ladies, fieldId: "f2" };
    expect(fieldsInUse([SECTION], keep([["f1", null]]), [], [other])).toBeUndefined();
  });

  it("refuses removing an answered option or clearing answered options", () => {
    const answered = [{ fieldId: "f1", chosen: ["men"] }];
    expect(
      fieldsInUse([SECTION], keep([["f1", [WOMEN, KIDS] as FieldState["options"]]]), answered, []),
    ).toEqual({
      reason: "answers",
    });
    expect(fieldsInUse([SECTION], keep([["f1", null]]), answered, [])).toEqual({
      reason: "answers",
    });
    expect(
      fieldsInUse([SECTION], keep([["f1", [MEN, KIDS] as FieldState["options"]]]), answered, []),
    ).toBeUndefined();
  });

  it("refuses options on a field that already has free-text answers, not on an unanswered one", () => {
    const options = SECTION.options;
    expect(
      fieldsInUse([TEAM], keep([["f2", options]]), [{ fieldId: "f2", chosen: [] }], []),
    ).toEqual({ reason: "answers" });
    expect(fieldsInUse([TEAM], keep([["f2", options]]), [], [])).toBeUndefined();
    expect(
      fieldsInUse([TEAM], keep([["f2", null]]), [{ fieldId: "f2", chosen: [] }], []),
    ).toBeUndefined();
  });

  it("reports rules before answers", () => {
    expect(
      fieldsInUse(
        [SECTION],
        keep([["f1", null]]),
        [{ fieldId: "f1", chosen: ["women"] }],
        [ladies],
      ),
    ).toMatchObject({ reason: "rules" });
  });
});
