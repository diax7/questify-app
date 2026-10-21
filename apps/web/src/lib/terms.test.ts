import { DEFAULT_TERMS, type EventTerms } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { checkTerms, previewOf, termFieldOf, termsBodyOf } from "#src/lib/terms.ts";

const GEMS = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };
const STUDENTS = { ar: { one: "طالب", many: "طلاب" }, en: { one: "student", many: "students" } };
const EMPTY = { ar: { one: "", many: "" }, en: { one: " ", many: "" } };

const draft = (patch: Partial<EventTerms>): EventTerms => ({ ...DEFAULT_TERMS, ...patch });

describe("termsBodyOf", () => {
  it("is empty for the defaults, so every word follows them", () => {
    expect(termsBodyOf(DEFAULT_TERMS)).toStrictEqual({});
  });

  it("carries the changed words and a changed icon, and leaves out an emptied word", () => {
    const body = termsBodyOf(
      draft({ currency: { icon: "gem", ...GEMS }, player: STUDENTS, operator: EMPTY }),
    );
    expect(body).toStrictEqual({ currency: { ...GEMS, icon: "gem" }, player: STUDENTS });
  });

  it("carries an icon on its own, and one changed form of a word", () => {
    expect(
      termsBodyOf(draft({ currency: { ...DEFAULT_TERMS.currency, icon: "leaf" } })),
    ).toStrictEqual({ currency: { icon: "leaf" } });
    const player = { ...DEFAULT_TERMS.player, en: { one: "player", many: "gamers" } };
    expect(termsBodyOf(draft({ player }))).toStrictEqual({ player });
  });
});

describe("checkTerms", () => {
  it("passes a full set", () => {
    expect(checkTerms(draft({ player: STUDENTS }))).toStrictEqual({
      ok: true,
      body: { player: STUDENTS },
    });
  });

  it("names the empty form of a partly filled word", () => {
    const player = { ar: STUDENTS.ar, en: { one: "student", many: "  " } };
    expect(checkTerms(draft({ player }))).toStrictEqual({
      ok: false,
      field: { word: "player", language: "en", form: "many" },
    });
  });

  it("names a form with a digit", () => {
    const currency = { icon: "coin" as const, ar: { one: "نقطة٢", many: "نقاط" }, en: GEMS.en };
    expect(checkTerms(draft({ currency }))).toStrictEqual({
      ok: false,
      field: { word: "currency", language: "ar", form: "one" },
    });
  });
});

describe("termFieldOf", () => {
  it("reads a form's path and nothing else", () => {
    expect(termFieldOf("operator.ar.many")).toStrictEqual({
      word: "operator",
      language: "ar",
      form: "many",
    });
    for (const path of [
      "",
      "currency.icon",
      "player.en",
      "prize.ar.one",
      "player.fr.one",
      "player.en.one.x",
      7,
    ]) {
      expect(termFieldOf(path)).toBeUndefined();
    }
  });
});

describe("previewOf", () => {
  it("shows the words trimmed, and the default for an emptied or partly filled word", () => {
    const player = { ar: { one: " طالب ", many: "طلاب" }, en: STUDENTS.en };
    const operator = { ...DEFAULT_TERMS.operator, en: { one: "host", many: "" } };
    expect(
      previewOf(draft({ player, operator, currency: { icon: "gem", ...EMPTY } })),
    ).toStrictEqual({
      currency: { ...DEFAULT_TERMS.currency, icon: "gem" },
      player: STUDENTS,
      operator: DEFAULT_TERMS.operator,
    });
  });
});
