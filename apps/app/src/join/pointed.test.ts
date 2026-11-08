import { describe, expect, it } from "vitest";
import {
  pointAtMissing,
  pointedText,
  refusalAmong,
  refusalFromParams,
  refusalOf,
  refusalParams,
} from "#src/join/pointed.ts";

const NAME = {
  ar: "لا يمكن استخدام هذا الاسم. أدخل اسمًا آخر.",
  en: "That name can't be used. Enter another name.",
};
const FILL = "Fill in this field to join.";

describe("the pointed join field", () => {
  it("says the API's words under the field it refused, never the fixed fill-in line", () => {
    const refusal = refusalOf({ kind: "invalid_answers", field: "f1", problem: NAME });
    expect(refusal).toEqual({ pointed: { field: "f1", problem: NAME }, problem: null });
    expect(pointedText(refusal.pointed, "f1", "en", FILL)).toBe(NAME.en);
    expect(pointedText(refusal.pointed, "f1", "ar", FILL)).toBe(NAME.ar);
    expect(pointedText(refusal.pointed, "f2", "en", FILL)).toBeUndefined();
  });

  it("says fill in for a field the app found empty, and puts a refusal naming no field on the Problem line", () => {
    expect(pointedText(pointAtMissing("f1"), "f1", "en", FILL)).toBe(FILL);
    expect(pointAtMissing(undefined)).toBeUndefined();
    expect(refusalOf({ kind: "invalid_answers", field: null, problem: NAME })).toEqual({
      pointed: undefined,
      problem: NAME,
    });
  });

  it("keeps the field through sign-in: the params carry it and the card opens pointing at it", () => {
    const params = refusalParams({ kind: "invalid_answers", field: "f1", problem: NAME });
    expect(params).toEqual({ problemAr: NAME.ar, problemEn: NAME.en, problemField: "f1" });
    expect(refusalFromParams(params)).toEqual({
      pointed: { field: "f1", problem: NAME },
      problem: null,
    });
  });

  it("carries other refusals as words only, and nothing for a join that went through", () => {
    const params = refusalParams({ kind: "refused", code: "event_ended", problem: NAME });
    expect(params).toEqual({ problemAr: NAME.ar, problemEn: NAME.en });
    expect(refusalFromParams(params)).toEqual({ pointed: undefined, problem: NAME });
    expect(refusalParams({ kind: "network" })).toEqual({});
    expect(refusalFromParams({})).toEqual({ pointed: undefined, problem: null });
  });

  it("puts the words on the Problem line when the field carried from sign-in is gone from the card", () => {
    const opening = refusalFromParams({
      problemAr: NAME.ar,
      problemEn: NAME.en,
      problemField: "f9",
    });
    expect(refusalAmong(opening, ["f1", "f2"])).toEqual({ pointed: undefined, problem: NAME });
    expect(refusalAmong(opening, ["f9"])).toEqual(opening);
    expect(refusalAmong({ pointed: pointAtMissing("f9"), problem: null }, ["f1"])).toEqual({
      pointed: undefined,
      problem: null,
    });
    expect(refusalAmong({ pointed: undefined, problem: NAME }, [])).toEqual({
      pointed: undefined,
      problem: NAME,
    });
  });
});
