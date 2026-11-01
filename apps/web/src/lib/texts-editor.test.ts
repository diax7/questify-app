import { describe, expect, it } from "vitest";
import { EVENT_TEXT_KEYS, EVENT_TEXT_MAX, readEventTexts } from "@questify/shared";
import {
  bodyOf,
  differs,
  draftOf,
  isRenamed,
  problemOf,
  resetLabel,
  withText,
} from "#src/lib/texts-editor.ts";

const PRIZES = readEventTexts({
  ar: { "nav.rewards": "الهدايا" },
  en: { "nav.rewards": "Prizes" },
});

describe("the labels draft", () => {
  it("holds every approved label in both languages, blank for one the event did not rename", () => {
    const draft = draftOf(readEventTexts(undefined));
    for (const language of ["ar", "en"] as const) {
      expect(Object.keys(draft[language])).toEqual([...EVENT_TEXT_KEYS]);
      expect(Object.values(draft[language]).every((text) => text === "")).toBe(true);
    }
    expect(draftOf(PRIZES).en["nav.rewards"]).toBe("Prizes");
  });

  it("saves only what is typed, trimmed, and leaves a blank to the platform's text", () => {
    const draft = withText(draftOf(PRIZES), "en", "nav.scan", "  Go  ");
    expect(bodyOf(draft)).toEqual({
      ar: { "nav.rewards": "الهدايا" },
      en: { "nav.rewards": "Prizes", "nav.scan": "Go" },
    });
    expect(bodyOf(withText(draft, "en", "nav.scan", "   ")).en).toEqual({
      "nav.rewards": "Prizes",
    });
  });

  it("resets one label in both languages and leaves the others", () => {
    const draft = withText(draftOf(PRIZES), "ar", "nav.scan", "امسح");
    const reset = resetLabel(draft, "nav.rewards");
    expect(isRenamed(reset, "nav.rewards")).toBe(false);
    expect(reset.ar["nav.scan"]).toBe("امسح");
    expect(bodyOf(reset)).toEqual({ ar: { "nav.scan": "امسح" }, en: {} });
  });

  it("tells a label renamed in one language only as renamed", () => {
    expect(
      isRenamed(withText(draftOf(readEventTexts(undefined)), "ar", "nav.home", "ابدأ"), "nav.home"),
    ).toBe(true);
    expect(isRenamed(draftOf(PRIZES), "nav.home")).toBe(false);
  });

  it("differs only when the saved body would differ", () => {
    const saved = draftOf(PRIZES);
    expect(differs(saved, draftOf(PRIZES))).toBe(false);
    expect(differs(withText(saved, "en", "nav.rewards", " Prizes "), saved)).toBe(false);
    expect(differs(withText(saved, "en", "nav.rewards", "Gifts"), saved)).toBe(true);
    expect(differs(resetLabel(saved, "nav.rewards"), saved)).toBe(true);
  });

  it("names the label and language the server would refuse, and nothing for good text", () => {
    const saved = draftOf(PRIZES);
    expect(problemOf(saved)).toBeNull();
    expect(problemOf(withText(saved, "en", "nav.profile", "Me {points}"))).toEqual({
      key: "nav.profile",
      language: "en",
    });
    expect(problemOf(withText(saved, "ar", "nav.quests", "{x}"))).toEqual({
      key: "nav.quests",
      language: "ar",
    });
    expect(problemOf(withText(saved, "en", "nav.scan", "a".repeat(EVENT_TEXT_MAX)))).toBeNull();
  });
});
