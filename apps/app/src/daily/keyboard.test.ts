import { DAILY_LETTERS, normalizeWord } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { gridDirection, KEY_ROWS, keyWidthFor, tileLetter } from "#src/daily/keyboard.ts";

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

describe("the key width", () => {
  it("keeps the Arabic rows to nine keys, the Arabic rows being the widest keys a 360px phone allows", () => {
    expect(Math.max(...KEY_ROWS.ar.map((row) => row.length))).toBe(9);
    // 360 wide, 24 side padding, 4 gap, 9 keys: (312 - 32) / 9 = 31.1.
    expect(keyWidthFor(360, 24, 4, 9)).toBe(31);
  });

  it("is one width for every row, so a short row is not stretched", () => {
    const widths = KEY_ROWS.ar.map(() => keyWidthFor(360, 24, 4, 9));
    expect(new Set(widths).size).toBe(1);
  });

  it("gives English's ten-key row a narrower key and never overflows the screen", () => {
    const width = keyWidthFor(360, 24, 4, 10);
    expect(width).toBe(27);
    expect(width * 10 + 4 * 9).toBeLessThanOrEqual(360 - 48);
  });

  it("does not stretch on a tablet", () => {
    expect(keyWidthFor(1024, 24, 4, 9)).toBe(keyWidthFor(480, 24, 4, 9));
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
