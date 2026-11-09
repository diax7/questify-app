import { DEFAULT_TERMS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { translatorFor } from "#src/lib/language.ts";
import { builderEventOf, problemText, sendHeaders } from "#src/lib/quest-builder.ts";

const header = (name: { ar: string | null; en: string | null }, extra = {}) => ({
  event: { timezone: "Asia/Riyadh", statusNow: "live", name, ...extra },
});

describe("builderEventOf", () => {
  it("reads the name in the page's language and defaults the switches and terms", () => {
    expect(builderEventOf(header({ ar: "معرض", en: "Expo" }), "ar")).toEqual({
      timezone: "Asia/Riyadh",
      statusNow: "live",
      name: "معرض",
      terms: DEFAULT_TERMS,
      flashQuests: true,
      boosts: true,
    });
    expect(builderEventOf(header({ ar: "معرض", en: "Expo" }), "en").name).toBe("Expo");
  });

  it("falls back to the other name, then to empty", () => {
    expect(builderEventOf(header({ ar: "معرض", en: null }), "en").name).toBe("معرض");
    expect(builderEventOf(header({ ar: null, en: "Expo" }), "ar").name).toBe("Expo");
    expect(builderEventOf(header({ ar: null, en: null }), "en").name).toBe("");
  });

  it("turns a switch off only when the API says false", () => {
    const view = builderEventOf(
      header({ ar: "a", en: "b" }, { flashQuests: false, boosts: true }),
      "en",
    );
    expect(view.flashQuests).toBe(false);
    expect(view.boosts).toBe(true);
    expect(builderEventOf(header({ ar: "a", en: "b" }, { boosts: false }), "en").boosts).toBe(
      false,
    );
  });
});

describe("problemText", () => {
  const t = translatorFor("en");

  it("names the field to fix for a builder refusal", () => {
    const body = {
      code: "invalid_quest",
      message: { ar: "x", en: "x" },
      details: { field: "place" },
    };
    expect(problemText(body, "en", t)).toBe(
      "Enter a latitude from -90 to 90, a longitude from -180 to 180 and a radius from 20 to 2000.",
    );
  });

  it("uses the API's message for any other refusal and the network words for no answer", () => {
    const other = {
      code: "forbidden",
      message: { ar: "ليس لك.", en: "Not yours." },
      details: { field: "place" },
    };
    expect(problemText(other, "en", t)).toBe("Not yours.");
    expect(problemText(undefined, "en", t)).toBe(
      "Could not connect. Check your connection and try again.",
    );
  });
});

describe("sendHeaders", () => {
  it("carries the key of a create and nothing otherwise", () => {
    expect(sendHeaders("k-1")).toEqual({ "idempotency-key": "k-1" });
    expect(sendHeaders(undefined)).toEqual({});
  });
});
