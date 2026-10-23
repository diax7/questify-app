import { describe, expect, it } from "vitest";
import {
  answersFor,
  firstMissing,
  forgetAnswers,
  heldAnswers,
  holdAnswers,
} from "#src/join/answers.ts";
import type { JoinField } from "#src/join/join-api.ts";

const FIELDS: JoinField[] = [
  { id: "a", kind: "full_name", label: { ar: null, en: null }, required: false, options: null },
  { id: "b", kind: "company", label: { ar: null, en: null }, required: true, options: null },
  { id: "c", kind: "custom", label: { ar: "القسم", en: null }, required: true, options: null },
];

describe("the card's answers", () => {
  it("points at the first required field left empty, in the card's order", () => {
    expect(firstMissing(FIELDS, {})).toBe("b");
    expect(firstMissing(FIELDS, { b: "  " })).toBe("b");
    expect(firstMissing(FIELDS, { b: "Acme" })).toBe("c");
    expect(firstMissing(FIELDS, { b: "Acme", c: "Women" })).toBeUndefined();
    expect(firstMissing([], {})).toBeUndefined();
  });

  it("sends this card's fields only, trimmed, without the empty ones", () => {
    expect(answersFor(FIELDS, { a: "  ", b: " Acme ", c: "Women", stale: "x" })).toEqual({
      b: "Acme",
      c: "Women",
    });
  });

  it("holds answers through sign-in by code in any case, until forgotten", () => {
    holdAnswers("abc234", { b: "Acme" });
    expect(heldAnswers("ABC234")).toEqual({ b: "Acme" });
    expect(heldAnswers("abc234")).toEqual({ b: "Acme" });
    forgetAnswers("Abc234");
    expect(heldAnswers("ABC234")).toBeUndefined();
  });
});
