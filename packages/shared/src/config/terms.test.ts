import { describe, expect, it } from "vitest";
import { DEFAULT_TERMS, readEventTerms, termFor, validateEventTerms } from "./terms";

const GEMS = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };
const STUDENTS = { ar: { one: "طالب", many: "طلاب" }, en: { one: "student", many: "students" } };

describe("validateEventTerms", () => {
  it("accepts every word, trimmed", () => {
    const result = validateEventTerms({
      currency: { icon: "gem", ar: { one: " جوهرة ", many: "جواهر" }, en: GEMS.en },
      player: STUDENTS,
      operator: { ar: { one: "مشرف", many: "مشرفون" }, en: { one: "host", many: "hosts" } },
    });
    expect(result).toStrictEqual({
      ok: true,
      value: {
        currency: { icon: "gem", ...GEMS },
        player: STUDENTS,
        operator: { ar: { one: "مشرف", many: "مشرفون" }, en: { one: "host", many: "hosts" } },
      },
    });
  });

  it("accepts nothing, an icon on its own, and names with no icon", () => {
    expect(validateEventTerms({})).toStrictEqual({ ok: true, value: {} });
    expect(validateEventTerms({ currency: { icon: "leaf" } })).toStrictEqual({
      ok: true,
      value: { currency: { icon: "leaf" } },
    });
    expect(validateEventTerms({ currency: GEMS })).toStrictEqual({
      ok: true,
      value: { currency: GEMS },
    });
  });

  it.each([
    [{ currency: { ar: GEMS.ar } }, "currency.en"],
    [{ currency: { en: GEMS.en } }, "currency.ar"],
    [{ player: { ar: STUDENTS.ar } }, "player.en"],
    [{ player: { ar: STUDENTS.ar, en: { one: "student" } } }, "player.en.many"],
    [{ operator: { ar: { many: "مشرفون" }, en: STUDENTS.en } }, "operator.ar.one"],
  ])("names the missing form of a partly named word", (input, path) => {
    const result = validateEventTerms(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toStrictEqual([path]);
  });

  it.each([
    ["a blank form", "   "],
    ["a Western digit", "team1"],
    ["an Arabic-Indic digit", "فريق١"],
    ["a brace", "{points}"],
    ["a line break", "two\nlines"],
    ["a tab", "a\tb"],
    ["a line separator", "a\u2028b"],
    ["a bidi override", "\u202Egem"],
    ["a bidi isolate", "\u2066gem"],
    ["31 characters", "a".repeat(31)],
  ])("refuses %s", (_name, text) => {
    const result = validateEventTerms({ player: { ...STUDENTS, en: { one: text, many: "x" } } });
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toStrictEqual([
      "player.en.one",
    ]);
  });

  it("accepts 30 characters and the joiners Arabic uses", () => {
    const result = validateEventTerms({
      player: { ar: { one: "عضو\u200Cفريق", many: "أ".repeat(30) }, en: STUDENTS.en },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    [{ currency: { icon: "trophy" } }, "currency.icon"],
    [{ prize: GEMS }, ""],
    [{ player: { ...STUDENTS, fr: STUDENTS.en } }, "player"],
    [{ player: { ar: { ...STUDENTS.ar, two: "طالبان" }, en: STUDENTS.en } }, "player.ar"],
    [[], ""],
    ["gems", ""],
  ])("refuses an unknown icon, key or shape", (input, path) => {
    const result = validateEventTerms(input);
    expect(result.ok ? [] : result.issues.map((issue) => issue.path)).toStrictEqual([path]);
  });
});

describe("readEventTerms", () => {
  it("is the defaults for nothing or a damaged value", () => {
    for (const value of [undefined, null, "gems", [], {}, { currency: [], player: "x" }]) {
      expect(readEventTerms(value)).toStrictEqual(DEFAULT_TERMS);
    }
  });

  it("keeps the words that are usable and the defaults for the rest", () => {
    expect(readEventTerms({ currency: { icon: "gem" }, player: STUDENTS })).toStrictEqual({
      currency: { ...DEFAULT_TERMS.currency, icon: "gem" },
      player: STUDENTS,
      operator: DEFAULT_TERMS.operator,
    });
    expect(readEventTerms({ currency: GEMS })).toStrictEqual({
      ...DEFAULT_TERMS,
      currency: { icon: "coin", ...GEMS },
    });
  });

  it("drops one bad word and an unknown icon, and keys it does not know", () => {
    const read = readEventTerms({
      currency: { icon: "trophy", ...GEMS, extra: true },
      player: { ar: { one: "طالب", many: "" }, en: STUDENTS.en },
      operator: { ...STUDENTS, fr: STUDENTS.en },
    });
    expect(read).toStrictEqual({
      currency: { icon: "coin", ...GEMS },
      player: DEFAULT_TERMS.player,
      operator: STUDENTS,
    });
  });

  it("drops a word with a digit, as the save does", () => {
    const player = { ar: STUDENTS.ar, en: { one: "player1", many: "players" } };
    expect(readEventTerms({ player }).player).toStrictEqual(DEFAULT_TERMS.player);
  });
});

describe("termFor", () => {
  it("is always the Arabic plural, a label never counted", () => {
    expect([0, 1, 2, 11, undefined].map((count) => termFor(GEMS, "ar", count))).toStrictEqual([
      "جواهر",
      "جواهر",
      "جواهر",
      "جواهر",
      "جواهر",
    ]);
  });

  it("is the English singular for exactly 1, as typed", () => {
    expect([0, 1, 2, -1].map((count) => termFor(GEMS, "en", count))).toStrictEqual([
      "gems",
      "gem",
      "gems",
      "gems",
    ]);
  });

  it("is the English plural with a capital as a label, keeping the rest as typed", () => {
    expect(termFor(GEMS, "en")).toBe("Gems");
    const typed = { ...GEMS, en: { one: "XP point", many: "XP points" } };
    expect(termFor(typed, "en")).toBe("XP points");
  });
});
