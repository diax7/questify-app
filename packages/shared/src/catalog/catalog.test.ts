import { describe, expect, it } from "vitest";
import {
  TEMPLATE_BODY_MAX_BYTES,
  achievementDocSchema,
  templateDocSchema,
} from "#src/catalog/catalog";
import { arabicText, englishText } from "#src/text/bilingual";

const quest = {
  type: "scan_qr",
  titleAr: "سجّل حضورك",
  titleEn: "Check in",
  descriptionAr: "امسح الرمز.",
  descriptionEn: "Scan the code.",
  points: 50,
  repeatCap: 1,
  typeConfig: {},
};
const reward = (descriptionAr: string, descriptionEn: string) => ({
  kind: "experience",
  nameAr: "جولة",
  nameEn: "Tour",
  descriptionAr,
  descriptionEn,
  price: 300,
  perPlayerLimit: null,
  section: null,
  tagNew: false,
  tagLimited: false,
});
const doc = (rewards: unknown[]) => ({
  name: { ar: "مؤتمر", en: "Conference" },
  description: { ar: "يوم طويل.", en: "A long day." },
  body: {
    config: { features: {}, accent: "sky", layoutPreset: "classic" },
    categories: [
      { nameAr: "البداية", nameEn: "Start", orderMode: "any", completionBonus: 0, quests: [quest] },
    ],
    rewards,
  },
  enabled: true,
});

const messagesOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe("template body size", () => {
  it("accepts a setup under the limit", () => {
    expect(
      templateDocSchema.safeParse(doc([reward("ا".repeat(200), "a".repeat(200))])).success,
    ).toBe(true);
  });

  it("refuses a setup over the limit and says its size, the limit and why", () => {
    const rewards = Array.from({ length: 6 }, () => reward("ا".repeat(2000), "a".repeat(2000)));
    const result = templateDocSchema.safeParse(doc(rewards));
    expect(result.success).toBe(false);
    const [message] = messagesOf(result);
    expect(message).toContain(String(TEMPLATE_BODY_MAX_BYTES));
    expect(message).toMatch(/\d+ bytes/);
    expect(message).toContain("audit log");
  });

  it("counts bytes, not characters: Arabic letters take two", () => {
    const rewards = Array.from({ length: 8 }, () => reward("ا".repeat(2000), "a"));
    const text = JSON.stringify(doc(rewards).body);
    expect(text.length).toBeLessThan(TEMPLATE_BODY_MAX_BYTES);
    expect(templateDocSchema.safeParse(doc(rewards)).success).toBe(false);
  });
});

describe("achievement edit document", () => {
  it("holds the name and nothing else, so a threshold cannot ride along", () => {
    const name = { ar: "صائد المهام", en: "Quest Hunter" };
    expect(achievementDocSchema.safeParse({ name }).success).toBe(true);
    for (const extra of [{ bronze: 5 }, { bronze: 1, silver: 2, gold: 3 }, { threshold: 1 }]) {
      expect(
        achievementDocSchema.safeParse({ name, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe("a name an admin types", () => {
  it("says Western digits when another script's digits are the problem", () => {
    const result = arabicText(20).safeParse("اسم ٣");
    expect(messagesOf(result)).toEqual(["Western digits only"]);
  });

  it("says control or direction characters when one is the problem, and not digits", () => {
    expect(messagesOf(arabicText(20).safeParse("اسم\u0007"))).toEqual([
      "no control or direction characters",
    ]);
    expect(messagesOf(englishText(20).safeParse("Na‮me"))).toEqual([
      "no control or direction characters",
    ]);
  });

  it("reports both when a name has both problems", () => {
    expect(messagesOf(arabicText(20).safeParse("اسم ٣\u0007"))).toEqual([
      "Western digits only",
      "no control or direction characters",
    ]);
  });
});
