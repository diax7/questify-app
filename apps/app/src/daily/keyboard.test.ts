import { DAILY_LETTERS, normalizeWord } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { gridDirection, KEY_ROWS, tileLetter } from "#src/daily/keyboard.ts";

describe("the keyboard", () => {
  it.each(["ar", "en"] as const)("has exactly the %s letters, each on one key", (language) => {
    const keys = KEY_ROWS[language].flat();
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...DAILY_LETTERS[language]].sort());
  });

  it("has the 33 Arabic keys, including ة ى ء ؤ ئ", () => {
    const keys = KEY_ROWS.ar.flat();
    expect(keys).toHaveLength(33);
    for (const letter of ["ة", "ى", "ء", "ؤ", "ئ"]) expect(keys).toContain(letter);
  });

  it("has no key for a letter the server folds away", () => {
    const keys = KEY_ROWS.ar.flat();
    for (const folded of ["أ", "إ", "آ", "ٱ", "ـ"]) expect(keys).not.toContain(folded);
  });

  it("can type any word the server accepts, one key per letter", () => {
    for (const word of ["كتاب", "مدرسة", "ماءان"].filter((w) => w.length === 5)) {
      const typed = [...word].every((letter) => KEY_ROWS.ar.flat().includes(letter));
      expect(typed).toBe(true);
      expect(normalizeWord("ar", word)).toBe(word);
    }
    expect([..."crane"].every((letter) => KEY_ROWS.en.flat().includes(letter))).toBe(true);
  });

  it("keeps each key within a few to a row so a key stays large enough to press", () => {
    for (const rows of Object.values(KEY_ROWS)) {
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("the grid", () => {
  it("fills right to left for Arabic and left to right for English, whatever the app's language", () => {
    expect(gridDirection("ar")).toBe("rtl");
    expect(gridDirection("en")).toBe("ltr");
  });

  it("shows English letters in capitals and Arabic letters as they are", () => {
    expect(tileLetter("en", "q")).toBe("Q");
    expect(tileLetter("ar", "ب")).toBe("ب");
  });
});
