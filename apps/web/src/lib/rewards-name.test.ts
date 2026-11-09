import { describe, expect, it } from "vitest";
import { rewardNameIn } from "#src/lib/rewards.ts";

describe("rewardNameIn", () => {
  it("prefers the page's language", () => {
    expect(rewardNameIn({ name: { ar: "قهوة", en: "Coffee" } }, "ar")).toBe("قهوة");
    expect(rewardNameIn({ name: { ar: "قهوة", en: "Coffee" } }, "en")).toBe("Coffee");
  });

  it("falls back to the other language", () => {
    expect(rewardNameIn({ name: { ar: null, en: "Coffee" } }, "ar")).toBe("Coffee");
    expect(rewardNameIn({ name: { ar: "قهوة", en: null } }, "en")).toBe("قهوة");
  });

  it("is empty with no name at all", () => {
    expect(rewardNameIn({ name: { ar: null, en: null } }, "en")).toBe("");
  });
});
