import { describe, expect, it, vi } from "vitest";
import { formatNumber, toWesternDigits } from "./digits";

describe("toWesternDigits", () => {
  it("turns Arabic-Indic digits into 0-9", () => {
    expect(toWesternDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("turns Persian (extended Arabic-Indic) digits into 0-9 as well", () => {
    expect(toWesternDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("leaves letters, punctuation and Western digits alone", () => {
    expect(toWesternDigits("لديك 12 نقطة، و{points}!")).toBe("لديك 12 نقطة، و{points}!");
  });

  it("converts digits inside mixed text", () => {
    expect(toWesternDigits("المركز ٣ من ١٢٠")).toBe("المركز 3 من 120");
  });

  it("changes nothing in an empty string", () => {
    expect(toWesternDigits("")).toBe("");
  });

  it("converts the first and last digit of each block", () => {
    expect(toWesternDigits("٠٩۰۹")).toBe("0909");
    expect(toWesternDigits("ٟ٪ۯۺ")).toBe("ٟ٪ۯۺ");
  });
});

describe("formatNumber", () => {
  it.each(["ar", "en"] as const)("uses only Western digits in %s", (language) => {
    const text = formatNumber(1234567.5, language);
    expect(text).toBe("1,234,567.5");
    expect(text).not.toMatch(/[٠-٩۰-۹]/);
  });

  it("formats zero, small and large numbers the same way in both languages", () => {
    for (const value of [0, 7, 1000, 20000, 999999999]) {
      expect(formatNumber(value, "ar")).toBe(formatNumber(value, "en"));
    }
  });

  it("keeps the minus sign of a negative number in Arabic", () => {
    const marks = [0x200e, 0x200f, 0x061c].map((code) => String.fromCodePoint(code));
    const text = [...formatNumber(-12, "ar")]
      .filter((character) => !marks.includes(character))
      .join("");
    expect(text).toBe("-12");
  });

  it("rounds to at most the digits asked for", () => {
    expect(formatNumber(0.123456, "en")).toBe("0.123");
  });
});

describe("the number formats", () => {
  it("ask for Western digits explicitly in both languages, because some devices default Arabic to Arabic-Indic", async () => {
    vi.resetModules();
    const Original = Intl.NumberFormat;
    const spy = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (
      locales?: string | string[],
      options?: Intl.NumberFormatOptions,
    ) {
      return new Original(locales, options);
    } as never);
    try {
      const fresh = await import("./digits");
      fresh.formatNumber(1, "ar");
      fresh.formatNumber(1, "en");
      expect(spy).toHaveBeenCalledWith("ar-SA", { numberingSystem: "latn" });
      expect(spy).toHaveBeenCalledWith("en", { numberingSystem: "latn" });
    } finally {
      spy.mockRestore();
    }
  });
});
