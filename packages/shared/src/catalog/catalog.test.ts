import { describe, expect, it } from "vitest";
import {
  AMOUNT_RANGES,
  GEM_AMOUNTS,
  TEMPLATE_BODY_MAX_BYTES,
  XP_AMOUNTS,
  achievementBeforeSchema,
  achievementDocSchema,
  amountsDocSchema,
  loweredGemsSchema,
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
  const name = { ar: "صائد المهام", en: "Quest Hunter" };

  it("holds the name and three whole thresholds 1 to 100,000, strictly rising", () => {
    expect(
      achievementDocSchema.safeParse({ name, bronze: 1, silver: 2, gold: 100_000 }).success,
    ).toBe(true);
    for (const tiers of [
      { bronze: 5, silver: 5, gold: 10 },
      { bronze: 6, silver: 5, gold: 10 },
      { bronze: 1, silver: 10, gold: 10 },
      { bronze: 0, silver: 5, gold: 10 },
      { bronze: 1, silver: 5, gold: 100_001 },
      { bronze: 1.5, silver: 5, gold: 10 },
      { bronze: 1, silver: 5 },
    ]) {
      expect(
        achievementDocSchema.safeParse({ name, ...tiers }).success,
        JSON.stringify(tiers),
      ).toBe(false);
    }
  });

  it("refuses anything else, the confirmation included (the route takes it apart)", () => {
    for (const extra of [{ threshold: 1 }, { confirmed: true }]) {
      expect(
        achievementDocSchema.safeParse({ name, bronze: 1, silver: 2, gold: 3, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("reverts an entry with the name alone (T-709b's entries)", () => {
    expect(achievementBeforeSchema.safeParse({ name }).success).toBe(true);
    expect(achievementBeforeSchema.safeParse({ name, bronze: 1, silver: 2, gold: 3 }).success).toBe(
      true,
    );
  });

  it("reads the gems a lowering pays, per lowered tier", () => {
    expect(loweredGemsSchema.safeParse({ bronze: 10, gold: 50 }).success).toBe(true);
    expect(loweredGemsSchema.safeParse({ platinum: 1 }).success).toBe(false);
  });
});

describe("amounts document", () => {
  const amounts = {
    xp: { questXp: 100, dailyFinishXp: 20, dailyRightXp: 10, dailyWordXp: 50 },
    gems: { levelUp: 20, bronze: 10, silver: 25, gold: 50 },
  };

  it("takes every range's ends and refuses one past them", () => {
    for (const group of ["xp", "gems"] as const) {
      for (const [field, [low, high]] of Object.entries(AMOUNT_RANGES[group])) {
        const at = (value: number) => ({
          ...amounts,
          [group]: { ...amounts[group], [field]: value },
        });
        expect(amountsDocSchema.safeParse(at(low)).success, `${field} ${low}`).toBe(true);
        expect(amountsDocSchema.safeParse(at(high)).success, `${field} ${high}`).toBe(true);
        expect(amountsDocSchema.safeParse(at(low - 1)).success, `${field} ${low - 1}`).toBe(false);
        expect(amountsDocSchema.safeParse(at(high + 1)).success, `${field} ${high + 1}`).toBe(
          false,
        );
      }
    }
  });

  it("names every amount once and refuses a missing or extra one", () => {
    expect(Object.keys(AMOUNT_RANGES.xp)).toEqual([...XP_AMOUNTS]);
    expect(Object.keys(AMOUNT_RANGES.gems)).toEqual([...GEM_AMOUNTS]);
    const { gold: _gold, ...three } = amounts.gems;
    expect(amountsDocSchema.safeParse({ ...amounts, gems: three }).success).toBe(false);
    expect(
      amountsDocSchema.safeParse({ ...amounts, gems: { ...amounts.gems, ruby: 1 } }).success,
    ).toBe(false);
    expect(amountsDocSchema.safeParse({ ...amounts, moderation: {} }).success).toBe(false);
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
