import { describe, expect, it } from "vitest";
import {
  readRetired,
  readWords,
  retiredPath,
  wordPath,
  wordsPath,
} from "#src/lib/console-words.ts";

describe("the word-list console's paths and readers (T-705)", () => {
  it("puts only the filters that are set in the address", () => {
    expect(wordsPath({ q: "  ", language: "", match: "" }, null)).toBe("/v1/admin/words");
    expect(wordsPath({ q: " snark ", language: "en", match: "part" }, "gnarl")).toBe(
      "/v1/admin/words?q=snark&language=en&match=part&after=gnarl",
    );
    expect(retiredPath("", null)).toBe("/v1/admin/retired-usernames");
    expect(retiredPath("rude", "abc")).toBe("/v1/admin/retired-usernames?q=rude&after=abc");
  });

  it("escapes a word in its own path", () => {
    expect(wordPath("سب")).toBe(`/v1/admin/words/${encodeURIComponent("سب")}`);
  });

  it("reads a page and refuses a changed shape", () => {
    const word = { word: "gnarl", match: "word", language: "en", addedAt: "2026-11-02T10:00:00Z" };
    expect(readWords({ words: [word], total: 1 })).toEqual({ words: [word], total: 1 });
    expect(readWords({ words: [{ ...word, match: "whole" }], total: 1 })).toBeUndefined();
    const name = { fold: "rude_name", retiredAt: "2026-11-02T10:00:00Z" };
    expect(readRetired({ names: [name] })).toEqual([name]);
    expect(readRetired({ names: "x" })).toBeUndefined();
    expect(readRetired(null)).toBeUndefined();
  });
});
