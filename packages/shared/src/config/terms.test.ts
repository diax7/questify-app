import { describe, expect, it } from "vitest";
import { DEFAULT_TERMS, readEventTerms, termFor, validateEventTerms, wordParams } from "./terms";

const GEMS = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };
const MISSIONS = {
  ar: { one: "مغامرة", many: "مغامرات" },
  en: { one: "mission", many: "missions" },
};
const STAGES = { ar: { one: "مرحلة", many: "مراحل" }, en: { one: "stage", many: "stages" } };
const STUDENTS = { ar: { one: "طالب", many: "طلاب" }, en: { one: "student", many: "students" } };

describe("validateEventTerms", () => {
  it("accepts every word, trimmed", () => {
    const result = validateEventTerms({
      currency: { icon: "gem", ar: { one: " جوهرة ", many: "جواهر" }, en: GEMS.en },
      player: STUDENTS,
      operator: { ar: { one: "مشرف", many: "مشرفون" }, en: { one: "host", many: "hosts" } },
      quest: MISSIONS,
      category: STAGES,
    });
    expect(result).toStrictEqual({
      ok: true,
      value: {
        currency: { icon: "gem", ...GEMS },
        player: STUDENTS,
        operator: { ar: { one: "مشرف", many: "مشرفون" }, en: { one: "host", many: "hosts" } },
        quest: MISSIONS,
        category: STAGES,
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
    [{ quest: { ar: MISSIONS.ar } }, "quest.en"],
    [{ category: { en: STAGES.en } }, "category.ar"],
    [{ quest: { ar: MISSIONS.ar, en: { many: "missions" } } }, "quest.en.one"],
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
      quest: DEFAULT_TERMS.quest,
      category: DEFAULT_TERMS.category,
    });
    expect(readEventTerms({ currency: GEMS })).toStrictEqual({
      ...DEFAULT_TERMS,
      currency: { icon: "coin", ...GEMS },
    });
  });

  it("reads the quest and category words, each on its own", () => {
    expect(readEventTerms({ quest: MISSIONS })).toStrictEqual({
      ...DEFAULT_TERMS,
      quest: MISSIONS,
    });
    const read = readEventTerms({
      quest: { ar: MISSIONS.ar, en: { one: "mission" } },
      category: STAGES,
    });
    expect(read.quest).toStrictEqual(DEFAULT_TERMS.quest);
    expect(read.category).toStrictEqual(STAGES);
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
      quest: DEFAULT_TERMS.quest,
      category: DEFAULT_TERMS.category,
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

describe("wordParams", () => {
  it("is the defaults' four forms of each word in English", () => {
    expect(wordParams(DEFAULT_TERMS, "en")).toStrictEqual({
      questOne: "quest",
      questMany: "quests",
      questOneCap: "Quest",
      questCap: "Quests",
      categoryOne: "category",
      categoryMany: "categories",
      categoryOneCap: "Category",
      categoryCap: "Categories",
      playerOne: "player",
      playerMany: "players",
      playerOneCap: "Player",
      playerCap: "Players",
    });
  });

  it("is the Arabic words as typed, with no capitals", () => {
    const params = wordParams({ ...DEFAULT_TERMS, quest: MISSIONS }, "ar");
    expect(params["questOne"]).toBe("مغامرة");
    expect(params["questMany"]).toBe("مغامرات");
    expect(params["questOneCap"]).toBe("مغامرة");
    expect(params["questCap"]).toBe("مغامرات");
    expect(params["categoryMany"]).toBe("فئات");
  });

  it("follows the event's words and keeps the rest of the typed English", () => {
    const params = wordParams(
      { ...DEFAULT_TERMS, quest: { ...MISSIONS, en: { one: "XP mission", many: "XP missions" } } },
      "en",
    );
    expect(params["questOne"]).toBe("XP mission");
    expect(params["questCap"]).toBe("XP missions");
    expect(params["questOneCap"]).toBe("XP mission");
  });
});
