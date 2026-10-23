import { describe, expect, it } from "vitest";
import { COMING_GAMES, GAME_LEVELS, GAME_NAMES } from "#src/games/levels";
import { GAME_LEVEL_KEYS, GAME_NAME_KEYS, targetWords } from "#src/games/words";
import { MESSAGES } from "#src/i18n/messages";
import { createTranslator, NO_OVERRIDES } from "#src/i18n/translate";

describe("the games' words", () => {
  it("names every game, the ones to come too, and every level", () => {
    expect(Object.keys(GAME_NAME_KEYS)).toEqual([...GAME_NAMES, ...COMING_GAMES]);
    expect(Object.keys(GAME_LEVEL_KEYS)).toEqual([...GAME_LEVELS]);
    for (const key of [...Object.values(GAME_NAME_KEYS), ...Object.values(GAME_LEVEL_KEYS)]) {
      expect(MESSAGES).toHaveProperty([key]);
    }
  });

  it("puts each target in words, in Western digits in both languages", () => {
    const translate = createTranslator(MESSAGES, NO_OVERRIDES);
    const en = (key: keyof typeof MESSAGES, values?: Readonly<Record<string, string | number>>) =>
      translate(key, "en", values);
    const ar = (key: keyof typeof MESSAGES, values?: Readonly<Record<string, string | number>>) =>
      translate(key, "ar", values);
    expect(targetWords(en, { game: "memory_match", pairs: 8, maxMoves: 20 }, "en")).toBe(
      "Find all 8 pairs in 20 moves or fewer.",
    );
    expect(targetWords(en, { game: "memory_match", pairs: 6, maxMoves: null }, "en")).toBe(
      "Find all 6 pairs.",
    );
    expect(targetWords(en, { game: "slide_puzzle", seconds: 180 }, "en")).toBe(
      "Put the picture back together within 180 seconds.",
    );
    expect(targetWords(ar, { game: "memory_match", pairs: 10, maxMoves: 22 }, "ar")).toBe(
      "اعثر على جميع الأزواج (10) في 22 حركة أو أقل.",
    );
  });
});
