import { describe, expect, it } from "vitest";
import {
  draftOf,
  hasValue,
  nameIn,
  pickField,
  pickKind,
  ruleBody,
  ruleWords,
  toggleValue,
  type ChoiceField,
} from "#src/lib/audience.ts";

const FIELDS: ChoiceField[] = [
  {
    id: "f1",
    label: { ar: "القسم", en: "Section" },
    options: [
      { id: "women", ar: "نساء", en: "Women" },
      { id: "men", ar: null, en: "Men" },
    ],
  },
  { id: "f2", label: { ar: null, en: "Team" }, options: [{ id: "a", ar: "أ", en: "A" }] },
];

describe("the audience editor", () => {
  it("starts from the saved rule, or everyone on the first choice field", () => {
    expect(draftOf(null, FIELDS)).toEqual({ kind: "everyone", fieldId: "f1", values: [] });
    expect(draftOf(null, [])).toEqual({ kind: "everyone", fieldId: "", values: [] });
    expect(draftOf({ kind: "answer", fieldId: "f2", values: ["a"] }, FIELDS)).toEqual({
      kind: "answer",
      fieldId: "f2",
      values: ["a"],
    });
    expect(draftOf({ kind: "tag", values: ["vip"] }, FIELDS)).toEqual({
      kind: "tag",
      fieldId: "f1",
      values: ["vip"],
    });
  });

  it("ticks and unticks values, tags without case", () => {
    const tags = { kind: "tag" as const, fieldId: "", values: ["vip"] };
    expect(toggleValue(tags, "VIP").values).toEqual([]);
    expect(toggleValue(tags, "Speaker").values).toEqual(["vip", "Speaker"]);
    expect(hasValue(tags, "Vip")).toBe(true);
    const answer = { kind: "answer" as const, fieldId: "f1", values: ["women"] };
    expect(toggleValue(answer, "Women").values).toEqual(["women", "Women"]);
    expect(hasValue(answer, "WOMEN")).toBe(false);
    expect(toggleValue(answer, "women").values).toEqual([]);
  });

  it("clears picked values when the field or the kind changes, and keeps them otherwise", () => {
    const answer = { kind: "answer" as const, fieldId: "f1", values: ["women"] };
    expect(pickField(answer, "f2")).toEqual({ kind: "answer", fieldId: "f2", values: [] });
    expect(pickField(answer, "f1")).toEqual(answer);
    expect(pickKind(answer, "tag")).toEqual({ kind: "tag", fieldId: "f1", values: [] });
    expect(pickKind(answer, "answer")).toEqual(answer);
  });

  it("sends a rule only once something is picked", () => {
    expect(ruleBody({ kind: "everyone", fieldId: "f1", values: ["x"] })).toEqual({ rule: null });
    expect(ruleBody({ kind: "answer", fieldId: "f1", values: [] })).toBeUndefined();
    expect(ruleBody({ kind: "answer", fieldId: "", values: ["a"] })).toBeUndefined();
    expect(ruleBody({ kind: "tag", fieldId: "", values: [] })).toBeUndefined();
    expect(ruleBody({ kind: "answer", fieldId: "f1", values: ["men"] })).toEqual({
      rule: { kind: "answer", fieldId: "f1", values: ["men"] },
    });
    expect(ruleBody({ kind: "tag", fieldId: "f1", values: ["vip"] })).toEqual({
      rule: { kind: "tag", values: ["vip"] },
    });
  });

  it("says who sees an item in either language, showing stored values it cannot name", () => {
    expect(ruleWords(null, FIELDS, "en")).toBeNull();
    expect(
      ruleWords({ kind: "answer", fieldId: "f1", values: ["women", "men"] }, FIELDS, "ar"),
    ).toEqual({
      field: "القسم",
      values: "نساء، Men",
    });
    expect(
      ruleWords({ kind: "answer", fieldId: "f1", values: ["women", "gone"] }, FIELDS, "en"),
    ).toEqual({
      field: "Section",
      values: "Women, gone",
    });
    expect(ruleWords({ kind: "answer", fieldId: "nope", values: ["x"] }, FIELDS, "en")).toEqual({
      field: null,
      values: "x",
    });
    expect(ruleWords({ kind: "tag", values: ["vip", "speaker"] }, FIELDS, "ar")).toEqual({
      field: null,
      values: "vip، speaker",
    });
    expect(ruleWords({ kind: "tag", values: ["vip", "speaker"] }, FIELDS, "en")?.values).toBe(
      "vip, speaker",
    );
  });

  it("names in a language, else in the other one", () => {
    expect(nameIn({ ar: "أ", en: "A" }, "ar")).toBe("أ");
    expect(nameIn({ ar: null, en: "A" }, "ar")).toBe("A");
    expect(nameIn({ ar: "أ", en: null }, "en")).toBe("أ");
    expect(nameIn({ ar: null, en: null }, "en")).toBe("");
  });
});
