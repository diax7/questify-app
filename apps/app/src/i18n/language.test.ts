import { describe, expect, it } from "vitest";
import {
  FALLBACK_LANGUAGE,
  decideBoot,
  isLanguage,
  isRtl,
  languageFromDevice,
  languageOfLayout,
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
    expect(
      decideBoot({
        stored: undefined,
        device: [locale("ar")],
        layoutIsRtl: true,
        restartTriedFor: null,
      }),
    ).toEqual({
      language: "ar",
      needsRestart: false,
      fellBack: false,
    });
    expect(
      decideBoot({
        stored: null,
        device: [locale("en")],
        layoutIsRtl: false,
        restartTriedFor: null,
      }),
    ).toEqual({
      language: "en",
      needsRestart: false,
      fellBack: false,
    });
  });

  it("uses the player's saved choice over the phone's language", () => {
    expect(
      decideBoot({ stored: "ar", device: [locale("en")], layoutIsRtl: true, restartTriedFor: null })
        .language,
    ).toBe("ar");
    expect(
      decideBoot({
        stored: "en",
        device: [locale("ar")],
        layoutIsRtl: false,
        restartTriedFor: null,
      }).language,
    ).toBe("en");
  });

  it("asks for a restart when the saved language needs the other direction", () => {
    expect(
      decideBoot({
        stored: "ar",
        device: [locale("en")],
        layoutIsRtl: false,
        restartTriedFor: null,
      }),
    ).toEqual({
      language: "ar",
      needsRestart: true,
      fellBack: false,
    });
    expect(
      decideBoot({
        stored: "en",
        device: [locale("ar")],
        layoutIsRtl: true,
        restartTriedFor: null,
      }),
    ).toEqual({
      language: "en",
      needsRestart: true,
      fellBack: false,
    });
  });

  it("ignores a saved value that is not a language", () => {
    for (const stored of ["fr", "", 5, {}, "AR"]) {
      expect(
        decideBoot({ stored, device: [locale("ar")], layoutIsRtl: true, restartTriedFor: null }),
      ).toEqual({
        language: "ar",
        needsRestart: false,
        fellBack: false,
      });
    }
  });
});

describe("decideBoot after a restart that did not take", () => {
  it("carries on in the layout's language instead of restarting again", () => {
    expect(
      decideBoot({
        stored: "ar",
        device: [locale("en")],
        layoutIsRtl: false,
        restartTriedFor: "ar",
      }),
    ).toEqual({ language: "en", needsRestart: false, fellBack: true });
    expect(
      decideBoot({
        stored: "en",
        device: [locale("ar")],
        layoutIsRtl: true,
        restartTriedFor: "en",
      }),
    ).toEqual({ language: "ar", needsRestart: false, fellBack: true });
  });

  it("still restarts when the earlier attempt was for a different language", () => {
    expect(
      decideBoot({
        stored: "ar",
        device: [locale("en")],
        layoutIsRtl: false,
        restartTriedFor: "en",
      }),
    ).toEqual({ language: "ar", needsRestart: true, fellBack: false });
  });

  it("ignores the note when the layout already matches", () => {
    expect(
      decideBoot({
        stored: "ar",
        device: [locale("en")],
        layoutIsRtl: true,
        restartTriedFor: "ar",
      }),
    ).toEqual({ language: "ar", needsRestart: false, fellBack: false });
  });
});

describe("languageOfLayout", () => {
  it("is Arabic for a right-to-left layout and English otherwise", () => {
    expect(languageOfLayout(true)).toBe("ar");
    expect(languageOfLayout(false)).toBe("en");
  });
});
