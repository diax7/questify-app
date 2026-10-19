import { describe, expect, it } from "vitest";
import {
  FALLBACK_LANGUAGE,
  decideBoot,
  isLanguage,
  isRtl,
  languageFromDevice,
} from "#src/i18n/language.ts";

const locale = (languageCode: string | null) => ({ languageCode });

describe("isLanguage", () => {
  it("accepts only ar and en", () => {
    expect(isLanguage("ar")).toBe(true);
    expect(isLanguage("en")).toBe(true);
    for (const value of ["AR", "fr", "", null, undefined, 1, {}]) {
      expect(isLanguage(value)).toBe(false);
    }
  });
});

describe("isRtl", () => {
  it("is true for Arabic and false for English", () => {
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("en")).toBe(false);
  });
});

describe("languageFromDevice", () => {
  it("takes the first language in the phone's list that the app speaks", () => {
    expect(languageFromDevice([locale("fr"), locale("ar"), locale("en")])).toBe("ar");
    expect(languageFromDevice([locale("fr"), locale("en"), locale("ar")])).toBe("en");
  });

  it("ignores letter case", () => {
    expect(languageFromDevice([locale("AR")])).toBe("ar");
  });

  it("skips entries with no language code", () => {
    expect(languageFromDevice([locale(null), locale("ar")])).toBe("ar");
  });

  it("falls back to English when the phone speaks neither, so a first launch needs no restart", () => {
    expect(FALLBACK_LANGUAGE).toBe("en");
    expect(languageFromDevice([locale("fr"), locale("de")])).toBe("en");
    expect(languageFromDevice([])).toBe("en");
  });
});

describe("decideBoot", () => {
  it("follows the phone on a first launch, with no restart when the layout already matches", () => {
    expect(decideBoot({ stored: undefined, device: [locale("ar")], layoutIsRtl: true })).toEqual({
      language: "ar",
      needsRestart: false,
    });
    expect(decideBoot({ stored: null, device: [locale("en")], layoutIsRtl: false })).toEqual({
      language: "en",
      needsRestart: false,
    });
  });

  it("uses the player's saved choice over the phone's language", () => {
    expect(decideBoot({ stored: "ar", device: [locale("en")], layoutIsRtl: true }).language).toBe(
      "ar",
    );
    expect(decideBoot({ stored: "en", device: [locale("ar")], layoutIsRtl: false }).language).toBe(
      "en",
    );
  });

  it("asks for a restart when the saved language needs the other direction", () => {
    expect(decideBoot({ stored: "ar", device: [locale("en")], layoutIsRtl: false })).toEqual({
      language: "ar",
      needsRestart: true,
    });
    expect(decideBoot({ stored: "en", device: [locale("ar")], layoutIsRtl: true })).toEqual({
      language: "en",
      needsRestart: true,
    });
  });

  it("ignores a saved value that is not a language", () => {
    for (const stored of ["fr", "", 5, {}, "AR"]) {
      expect(decideBoot({ stored, device: [locale("ar")], layoutIsRtl: true })).toEqual({
        language: "ar",
        needsRestart: false,
      });
    }
  });
});
