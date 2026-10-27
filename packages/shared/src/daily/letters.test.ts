import { describe, expect, it } from "vitest";
import {
  DAILY_LANGUAGES,
  DAILY_LETTERS,
  WORD_LENGTH,
  foldWord,
  normalizeWord,
} from "#src/daily/letters";

const ch = (code: number) => String.fromCharCode(code);

describe("the daily word's letters", () => {
  it("has 33 Arabic keys, each once, with the five extra letters and no folded form", () => {
    expect(DAILY_LANGUAGES).toEqual(["ar", "en"]);
    expect(WORD_LENGTH).toBe(5);
    expect(DAILY_LETTERS.ar).toHaveLength(33);
    expect(new Set(DAILY_LETTERS.ar).size).toBe(33);
    for (const letter of ["ة", "ى", "ء", "ؤ", "ئ", "ا", "ي"])
      expect(DAILY_LETTERS.ar).toContain(letter);
    for (const folded of ["أ", "إ", "آ", "ٱ", ch(0x0640)])
      expect(DAILY_LETTERS.ar).not.toContain(folded);
    expect(DAILY_LETTERS.en.join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("folds as the server does: trimmed, English lower-cased, Arabic marks and tatweel dropped, alef forms folded", () => {
    expect(foldWord("en", "  CraNe ")).toBe("crane");
    const fatha = ch(0x064e);
    const tatweel = ch(0x0640);
    expect(foldWord("ar", ` أ${fatha}م${tatweel}انة `)).toBe("امانة");
    expect(foldWord("ar", "إآٱ")).toBe("ااا");
    expect(foldWord("ar", `ب${ch(0x0670)}${ch(0x0651)}`)).toBe("ب");
    expect(foldWord("ar", "ؤئءةى")).toBe("ؤئءةى");
  });

  it("normalizes only five letters of the language", () => {
    expect(normalizeWord("en", "Crane")).toBe("crane");
    expect(normalizeWord("en", "cranes")).toBeNull();
    expect(normalizeWord("en", "cr4ne")).toBeNull();
    expect(normalizeWord("en", "كتابة")).toBeNull();
    expect(normalizeWord("ar", "أمانة")).toBe("امانة");
    expect(normalizeWord("ar", "مكتبة1")).toBeNull();
    expect(normalizeWord("ar", "كتاب")).toBeNull();
    expect(normalizeWord("ar", "crane")).toBeNull();
  });
});
