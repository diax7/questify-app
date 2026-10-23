import { describe, expect, it } from "vitest";
import { cleanOptions, joinOptionLabel, type JoinOption } from "#src/join/options";

const ids = (...made: string[]) => {
  const queue = [...made];
  return () => queue.shift() ?? "zzz";
};

const many = (count: number) => Array.from({ length: count }, (_, i) => ({ en: `Option ${i}` }));

const CURRENT: JoinOption[] = [
  { id: "women", ar: "نساء", en: "Women" },
  { id: "men", ar: "رجال", en: "Men" },
];

describe("choice field options", () => {
  it("keeps ids, trims labels and makes ids for new options", () => {
    expect(
      cleanOptions(
        [{ id: "women", ar: " سيدات ", en: "Ladies" }, { en: "Kids " }, { id: "men", ar: "رجال" }],
        CURRENT,
        ids("k1"),
      ),
    ).toEqual([
      { id: "women", ar: "سيدات", en: "Ladies" },
      { id: "k1", ar: null, en: "Kids" },
      { id: "men", ar: "رجال", en: null },
    ]);
  });

  it("skips a made id that is taken or malformed", () => {
    expect(
      cleanOptions([{ en: "A" }, { en: "B" }], CURRENT, ids("men", "Bad Id", "a1", "a1", "b2")),
    ).toEqual([
      { id: "a1", ar: null, en: "A" },
      { id: "b2", ar: null, en: "B" },
    ]);
  });

  it("fails loudly when no fresh id comes", () => {
    expect(() => cleanOptions([{ en: "A" }, { en: "B" }], CURRENT, () => "men")).toThrow(
      /could not make a new option id/,
    );
  });

  it("takes 2 to 20 options", () => {
    let next = 0;
    const counter = () => {
      next += 1;
      return `o${next}`;
    };
    expect(cleanOptions(many(1), [], counter)).toBeUndefined();
    expect(cleanOptions(many(2), [], counter)).toHaveLength(2);
    expect(cleanOptions(many(20), [], counter)).toHaveLength(20);
    expect(cleanOptions(many(21), [], counter)).toBeUndefined();
  });

  it.each([
    ["no label", [{ en: "  " }, { en: "B" }]],
    ["a long Arabic label", [{ ar: "ب".repeat(61) }, { en: "B" }]],
    ["a long English label", [{ en: "x".repeat(61) }, { en: "B" }]],
    ["an id the field does not have", [{ id: "kids", en: "Kids" }, { en: "B" }]],
    [
      "the same id twice",
      [
        { id: "men", en: "Men" },
        { id: "men", en: "Other" },
      ],
    ],
    ["the same English label", [{ en: "Men" }, { en: "men" }]],
    ["the same Arabic label", [{ ar: "رجال" }, { ar: "رجال", en: "Other" }]],
  ])("refuses %s", (_, input) => {
    expect(cleanOptions(input, CURRENT, ids("n1", "n2"))).toBeUndefined();
  });

  it("allows 60-character labels and the same label across languages", () => {
    expect(
      cleanOptions(
        [
          { en: "x".repeat(60), ar: "ب".repeat(60) },
          { ar: "B", en: "B" },
        ],
        [],
        ids("a", "b"),
      ),
    ).toHaveLength(2);
  });

  it("names an option in a language, else in the other one", () => {
    expect(joinOptionLabel({ id: "a", ar: "نساء", en: "Women" }, "ar")).toBe("نساء");
    expect(joinOptionLabel({ id: "a", ar: "نساء", en: "Women" }, "en")).toBe("Women");
    expect(joinOptionLabel({ id: "a", ar: null, en: "Women" }, "ar")).toBe("Women");
    expect(joinOptionLabel({ id: "a", ar: "نساء", en: null }, "en")).toBe("نساء");
    expect(joinOptionLabel({ id: "a", ar: null, en: null }, "en")).toBe("");
  });
});
