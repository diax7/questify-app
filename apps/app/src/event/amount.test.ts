import { DEFAULT_TERMS, MESSAGES, createTranslator, type Language } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { amountLabel, completedText, knownIcon } from "#src/event/amount.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) =>
  (key: keyof typeof MESSAGES, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);

const GEMS = {
  ...DEFAULT_TERMS,
  currency: {
    icon: "gem" as const,
    ar: { one: "جوهرة", many: "جواهر" },
    en: { one: "gem", many: "gems" },
  },
};

describe("amountLabel", () => {
  it("labels an amount with the event's currency in both languages", () => {
    expect(amountLabel(tIn("ar"), GEMS, "ar", "1,200")).toBe("جواهر: 1,200");
    expect(amountLabel(tIn("en"), GEMS, "en", "1,200")).toBe("Gems: 1,200");
  });

  it("uses Questify's words for an event that set none", () => {
    expect(amountLabel(tIn("ar"), DEFAULT_TERMS, "ar", "1")).toBe("نقاط: 1");
    expect(amountLabel(tIn("en"), DEFAULT_TERMS, "en", "1")).toBe("Points: 1");
  });
});

describe("completedText", () => {
  it("never counts the Arabic word, and counts the English one", () => {
    expect(completedText(tIn("ar"), GEMS, "ar", 1)).toBe("جواهر: \u200E+1");
    expect(completedText(tIn("en"), GEMS, "en", 1)).toBe("+1 gem");
    expect(completedText(tIn("en"), GEMS, "en", 2500)).toBe("+2,500 gems");
  });
});

describe("knownIcon", () => {
  it("keeps the five icons and shows the coin for one this version does not know", () => {
    expect(["coin", "crownCoin", "gem", "leaf", "star"].map(knownIcon)).toStrictEqual([
      "coin",
      "crownCoin",
      "gem",
      "leaf",
      "star",
    ]);
    expect(knownIcon("trophy")).toBe("coin");
  });
});
