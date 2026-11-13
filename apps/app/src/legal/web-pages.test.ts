import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { ABOUT_PAGES, webPageUrl } from "#src/legal/web-pages.ts";

describe("web page links (FR-1707, Q-769)", () => {
  it("opens the legal documents under /legal in the app's language", () => {
    expect(webPageUrl("ar", "privacy_policy")).toBe("https://questify.sa/ar/legal/privacy_policy");
    expect(webPageUrl("en", "terms_of_use")).toBe("https://questify.sa/en/legal/terms_of_use");
    expect(webPageUrl("en", "community_guidelines")).toBe(
      "https://questify.sa/en/legal/community_guidelines",
    );
  });

  it("opens the contact and deletion pages at the language root", () => {
    expect(webPageUrl("ar", "contact")).toBe("https://questify.sa/ar/contact");
    expect(webPageUrl("en", "delete-account")).toBe("https://questify.sa/en/delete-account");
  });

  it("lists every store-required page once, each with an Arabic and an English label", () => {
    expect(ABOUT_PAGES.map((row) => row.page)).toEqual([
      "privacy_policy",
      "terms_of_use",
      "community_guidelines",
      "contact",
      "delete-account",
    ]);
    for (const row of ABOUT_PAGES) {
      expect(MESSAGES[row.label].ar).not.toBe("");
      expect(MESSAGES[row.label].en).not.toBe("");
    }
  });
});
