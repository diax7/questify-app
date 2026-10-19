import { describe, expect, it } from "vitest";
import {
  directionOf,
  isolate,
  languageCookie,
  negotiateLanguage,
  otherLanguage,
  translatorFor,
} from "#src/lib/language.ts";

describe("negotiateLanguage", () => {
  it("uses the saved choice first", () => {
    expect(negotiateLanguage("ar", "en-US,en;q=0.9")).toBe("ar");
    expect(negotiateLanguage("en", "ar-SA")).toBe("en");
  });

  it("ignores a saved value that is not a language", () => {
    expect(negotiateLanguage("fr", "ar-SA")).toBe("ar");
    expect(negotiateLanguage("", "ar")).toBe("ar");
  });

  it("takes the browser's best Arabic or English entry by preference", () => {
    expect(negotiateLanguage(undefined, "fr-FR,ar-SA;q=0.8,en;q=0.5")).toBe("ar");
    expect(negotiateLanguage(undefined, "en;q=0.2, ar;q=0.9")).toBe("ar");
    expect(negotiateLanguage(undefined, "EN-gb")).toBe("en");
  });

  it("keeps the browser's order when weights are equal, and skips refused languages", () => {
    expect(negotiateLanguage(undefined, "en, ar")).toBe("en");
    expect(negotiateLanguage(undefined, "ar;q=0, en;q=0.1")).toBe("en");
  });

  it("falls back to English for any other language or no header", () => {
    expect(negotiateLanguage(undefined, "fr-FR,de")).toBe("en");
    expect(negotiateLanguage(undefined, null)).toBe("en");
    expect(negotiateLanguage(undefined, "")).toBe("en");
  });
});

describe("language helpers", () => {
  it("pairs each language with the other and with its direction", () => {
    expect(otherLanguage("ar")).toBe("en");
    expect(otherLanguage("en")).toBe("ar");
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
  });

  it("remembers the language for a year, site-wide, secure, readable by the page", () => {
    expect(languageCookie("ar")).toBe("qs_lang=ar; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  });

  it("isolates left-to-right text placed inside a sentence", () => {
    expect(isolate("a@b.sa")).toBe(
      `${String.fromCodePoint(0x2068)}a@b.sa${String.fromCodePoint(0x2069)}`,
    );
  });

  it("translates the shipped texts with their placeholders, digits Western", () => {
    expect(translatorFor("ar")("staff.attemptsLeft", { count: 3 })).toBe("المحاولات المتبقية: 3");
    expect(translatorFor("en")("staff.signIn")).toBe("Sign in");
  });
});
