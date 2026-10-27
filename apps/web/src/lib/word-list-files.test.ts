import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeWord, type DailyLanguage } from "@questify/shared";
import { IMPORT_CALL_WORDS, chunkWords, parseWordLines } from "#src/lib/console-daily-forms.ts";

const DIRECTORY = join(import.meta.dirname, "..", "..", "..", "..", "data", "word-lists");
const BYTE_ORDER_MARK = 0xfeff;

/** What each shipped list must at least hold (a cut-off file would fall under it) and words every player knows. */
const LISTS: ReadonlyArray<
  Readonly<{
    language: DailyLanguage;
    minimum: number;
    common: readonly string[];
    keptOut: readonly string[];
  }>
> = [
  {
    language: "en",
    minimum: 8_000,
    common: ["about", "house", "crane", "water", "world", "apple"],
    keptOut: ["paris", "whore", "penis"],
  },
  {
    language: "ar",
    minimum: 100_000,
    common: ["مدرسة", "الباب", "الماء", "الوقت", "جميلة", "مكتبة"],
    keptOut: ["عاهرة", "متناك"],
  },
];

const textOf = (language: DailyLanguage): string =>
  readFileSync(join(DIRECTORY, `guess-list-${language}.txt`), "utf8");

describe.each(LISTS)("the $language guess list file", ({ language, minimum, common, keptOut }) => {
  const text = textOf(language);
  const lines = text.slice(0, -1).split("\n");

  it("is plain lines of text: no byte order mark, no carriage return, one newline at the end", () => {
    expect(text.codePointAt(0)).not.toBe(BYTE_ORDER_MARK);
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("holds only words that are their own normalized form, five letters of the language", () => {
    const strays = lines.filter((line) => normalizeWord(language, line) !== line);
    expect(strays.slice(0, 10)).toEqual([]);
  });

  it("holds each word once, in order", () => {
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines).toEqual(lines.toSorted());
  });

  it("is large enough and has the common words", () => {
    expect(lines.length).toBeGreaterThanOrEqual(minimum);
    expect(common.filter((word) => !lines.includes(word))).toEqual([]);
  });

  it("leaves out names, abbreviations and the words a family game keeps out", () => {
    expect(keptOut.filter((word) => lines.includes(word))).toEqual([]);
  });

  it("goes through the console import whole: every line a word, none too long, each call within the limit", () => {
    const parsed = parseWordLines(text);
    expect(parsed.tooLong).toBe(0);
    expect(parsed.words).toEqual(lines);
    expect(chunkWords(parsed.words).every((call) => call.length <= IMPORT_CALL_WORDS)).toBe(true);
  });
});
