import { describe, expect, it } from "vitest";
import { DEFAULT_TERMS, wordParams } from "#src/config/terms";
import { MESSAGES } from "./messages";
import { placeholdersOf } from "./placeholders";
import {
  NO_OVERRIDES,
  createTranslator,
  isUsableOverride,
  validateTranslation,
  type Overrides,
} from "./translate";

const messages = {
  "greet.player": {
    ar: "مرحبا {player}، لديك {points} نقطة",
    en: "Hi {player}, you have {points} points",
  },
  "plain.text": { ar: "نص عادي", en: "Plain text" },
} as const;

describe("the shipped messages", () => {
  const entries = Object.entries(MESSAGES);

  it("has Arabic and English for every key", () => {
    for (const [key, text] of entries) {
      expect(text.ar.trim(), key).not.toBe("");
      expect(text.en.trim(), key).not.toBe("");
    }
  });

  // The event's words are filled in everywhere (FR-941, FR-942), and Arabic often cannot take a renamed noun where
  // English can (ADR-252), so a text may name one in a single language.
  const wordNames = Object.keys(wordParams(DEFAULT_TERMS, "en"));
  const withoutWords = (text: string): string[] =>
    placeholdersOf(text).filter((name) => !wordNames.includes(name));

  it("uses the same placeholders in both languages, the event's words aside", () => {
    for (const [key, text] of entries) {
      expect(withoutWords(text.ar), key).toEqual(withoutWords(text.en));
    }
  });

  it("names only event words that exist", () => {
    const wordLike = /^(quest|category|player)[A-Z]/;
    for (const [key, text] of entries) {
      for (const name of placeholdersOf(`${text.ar} ${text.en}`).filter((n) => wordLike.test(n))) {
        expect(wordNames, `${key} {${name}}`).toContain(name);
      }
    }
  });

  it("names keys in lower-case dotted words", () => {
    for (const [key] of entries) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/);
    }
  });

  it("contains no Arabic-Indic digits (ADR-018)", () => {
    for (const [key, text] of entries) {
      expect(`${text.ar}${text.en}`, key).not.toMatch(/[٠-٩۰-۹]/);
    }
  });
});

const check = (key: string, language: "ar" | "en", text: string) =>
  validateTranslation(messages, key, language, text);

describe("validateTranslation", () => {
  it("accepts a text that keeps every placeholder", () => {
    expect(check("greet.player", "en", "Hello {player}! {points} points")).toEqual({
      ok: true,
      value: "Hello {player}! {points} points",
    });
  });

  it("accepts the placeholders in another order", () => {
    expect(check("greet.player", "ar", "{points} نقطة يا {player}").ok).toBe(true);
  });

  it("refuses a save that removes a placeholder, naming it (FR-1767)", () => {
    expect(check("greet.player", "en", "Hello, you have {points} points")).toEqual({
      ok: false,
      issues: [{ path: "en", message: "is missing {player}" }],
    });
  });

  it("refuses a save that renames a placeholder, naming both problems", () => {
    expect(check("greet.player", "en", "Hi {name}, {points}")).toEqual({
      ok: false,
      issues: [
        { path: "en", message: "is missing {player}" },
        { path: "en", message: "uses {name}, which this text does not have" },
      ],
    });
  });

  it("refuses a placeholder the text never had", () => {
    expect(check("plain.text", "en", "Plain {surprise}")).toEqual({
      ok: false,
      issues: [{ path: "en", message: "uses {surprise}, which this text does not have" }],
    });
  });

  it("checks each language against its own shipped text", () => {
    expect(check("greet.player", "ar", "مرحبا").ok).toBe(false);
  });

  it("accepts a blank value as 'use the shipped text' (FR-1766)", () => {
    expect(check("greet.player", "en", "")).toEqual({ ok: true, value: "" });
    expect(check("greet.player", "ar", "   \n ")).toEqual({ ok: true, value: "" });
  });

  it("turns Arabic-Indic digits into Western digits and trims the ends (FR-1507)", () => {
    expect(check("plain.text", "ar", "  المركز ٣ من ١٢٠  ")).toEqual({
      ok: true,
      value: "المركز 3 من 120",
    });
  });

  it("refuses a key the app does not have", () => {
    expect(check("nope", "en", "x")).toEqual({
      ok: false,
      issues: [{ path: "key", message: "is not a text of the app" }],
    });
  });

  it("allows 1000 characters and refuses 1001", () => {
    expect(check("plain.text", "en", "a".repeat(1000)).ok).toBe(true);
    expect(check("plain.text", "en", "a".repeat(1001))).toEqual({
      ok: false,
      issues: [{ path: "en", message: "must have at most 1000 characters" }],
    });
  });
});

describe("isUsableOverride", () => {
  it("is true for a text with the right placeholders", () => {
    expect(isUsableOverride(messages, "greet.player", "en", "{player} {points}")).toBe(true);
  });

  it.each([
    ["blank", "  "],
    ["missing a placeholder", "{player}"],
    ["with an extra placeholder", "{player} {points} {extra}"],
  ])("is false for a text that is %s", (_label, text) => {
    expect(isUsableOverride(messages, "greet.player", "en", text)).toBe(false);
  });

  it("is false when the placeholders are as many but not the same", () => {
    expect(isUsableOverride(messages, "greet.player", "en", "{player} {coins}")).toBe(false);
  });

  it("is false for an unknown key", () => {
    expect(isUsableOverride(messages, "nope", "en", "text")).toBe(false);
  });
});

describe("createTranslator", () => {
  const overrides: Overrides = {
    ar: { "plain.text": "نص جديد" },
    en: { "plain.text": "New text", "greet.player": "Broken {player}" },
  };

  it("shows the shipped text when the store has nothing (FR-1768)", () => {
    const t = createTranslator(messages, NO_OVERRIDES);
    expect(t("plain.text", "en")).toBe("Plain text");
    expect(t("plain.text", "ar")).toBe("نص عادي");
  });

  it("shows the shipped text when no overrides were loaded at all", () => {
    expect(createTranslator(messages)("plain.text", "en")).toBe("Plain text");
  });

  it("shows the admin's text when there is a usable one, per language", () => {
    const t = createTranslator(messages, overrides);
    expect(t("plain.text", "en")).toBe("New text");
    expect(t("plain.text", "ar")).toBe("نص جديد");
  });

  it("falls back to the shipped text for a blank value", () => {
    const t = createTranslator(messages, { ar: {}, en: { "plain.text": "  " } });
    expect(t("plain.text", "en")).toBe("Plain text");
  });

  it("falls back to the shipped text for a damaged value that lost a placeholder", () => {
    const t = createTranslator(messages, overrides);
    expect(t("greet.player", "en", { player: "Sara", points: 5 })).toBe(
      "Hi Sara, you have 5 points",
    );
  });

  it("fills placeholders and shows numbers in Western digits in both languages", () => {
    const t = createTranslator(messages);
    expect(t("greet.player", "ar", { player: "سارة", points: 20000 })).toBe(
      "مرحبا سارة، لديك 20,000 نقطة",
    );
    expect(t("greet.player", "en", { player: "Sara", points: 20000 })).toBe(
      "Hi Sara, you have 20,000 points",
    );
  });

  it("shows the key itself, not nothing, for a key that somehow is not shipped", () => {
    const t = createTranslator(messages) as (key: string, language: "en") => string;
    expect(t("ghost.key", "en")).toBe("ghost.key");
  });

  it("works with the real shipped messages", () => {
    const t = createTranslator(MESSAGES);
    expect(t("quests.pointsShort", "en", { points: 1250, currency: "Gems" })).toBe("Gems: 1,250");
    expect(t("quests.pointsShort", "ar", { points: 1250, currency: "جواهر" })).toBe("جواهر: 1,250");
  });
});
