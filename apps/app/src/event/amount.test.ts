import {
  DEFAULT_TERMS,
  MESSAGES,
  createTranslator,
  formatEventTime,
  type Language,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  amountLabel,
  bonusLine,
  completedText,
  itemLine,
  knownIcon,
  paidText,
} from "#src/event/amount.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) =>
  (key: keyof typeof MESSAGES, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);

const GEMS = {
  ...DEFAULT_TERMS,
  currency: {
    icon: "gem" as const,
    ar: { one: "جوهرة", many: "جواهر" },
    en: { one: "gem", many: "gems" },
  },
};

describe("amountLabel", () => {
  it("labels an amount with the event's currency in both languages", () => {
    expect(amountLabel(tIn("ar"), GEMS, "ar", "1,200")).toBe("جواهر: 1,200");
    expect(amountLabel(tIn("en"), GEMS, "en", "1,200")).toBe("Gems: 1,200");
  });

  it("uses Questify's words for an event that set none", () => {
    expect(amountLabel(tIn("ar"), DEFAULT_TERMS, "ar", "1")).toBe("نقاط: 1");
    expect(amountLabel(tIn("en"), DEFAULT_TERMS, "en", "1")).toBe("Points: 1");
  });
});

describe("completedText", () => {
  it("never counts the Arabic word, and counts the English one", () => {
    expect(completedText(tIn("ar"), GEMS, "ar", 1)).toBe("جواهر: \u200E+1");
    expect(completedText(tIn("en"), GEMS, "en", 1)).toBe("+1 gem");
    expect(completedText(tIn("en"), GEMS, "en", 2500)).toBe("+2,500 gems");
  });
});

describe("knownIcon", () => {
  it("keeps the five icons and shows the coin for one this version does not know", () => {
    expect(["coin", "crownCoin", "gem", "leaf", "star"].map(knownIcon)).toStrictEqual([
      "coin",
      "crownCoin",
      "gem",
      "leaf",
      "star",
    ]);
    expect(knownIcon("trophy")).toBe("coin");
  });
});

describe("bonusLine", () => {
  it("names the bonus and its category in both languages, with Western digits", () => {
    const bonus = { points: 1500, category: { ar: "المرحلة", en: "Stage" }, item: null };
    expect(bonusLine(tIn("en"), "en", bonus)).toBe("+1,500 bonus: Stage complete");
    expect(bonusLine(tIn("ar"), "ar", bonus)).toBe("أكملت «المرحلة»: مكافأة ‎+1,500");
  });

  it("says an item-only bonus as the category complete, with its item (T-304d)", () => {
    const bonus = {
      points: 0,
      category: { ar: "المرحلة", en: "Stage" },
      item: { name: { ar: "قميص", en: "T-shirt" }, outcome: "pending" as const, until: null },
    };
    expect(bonusLine(tIn("en"), "en", bonus)).toBe(
      "Stage complete + T-shirt: collect it at the prize desk",
    );
    expect(bonusLine(tIn("ar"), "ar", bonus)).toBe(
      "أكملت «المرحلة» ‎+ قميص: استلم جائزتك من مكتب الجوائز",
    );
  });
});

describe("itemLine", () => {
  it("says where to collect the item, or that it ran out or the desk closed (FR-1617)", () => {
    const name = { ar: "قميص", en: "T-shirt" };
    expect(itemLine(tIn("en"), "en", { name, outcome: "out_of_stock", until: null })).toBe(
      "The T-shirt ran out; you got the points",
    );
    expect(itemLine(tIn("ar"), "ar", { name, outcome: "out_of_stock", until: null })).toBe(
      "نفدت الكمية من «قميص»، وحصلت على النقاط",
    );
    expect(itemLine(tIn("en"), "en", { name, outcome: "claim_closed", until: null })).toBe(
      "The prize desk has closed; you got the points",
    );
  });

  it("says a pending item's deadline in the event's zone, with Western digits (ADR-205)", () => {
    const name = { ar: "قميص", en: "T-shirt" };
    const until = { at: "2030-11-01T15:30:00.000Z", timeZone: "Asia/Riyadh" };
    const at = new Date(until.at);
    expect(itemLine(tIn("en"), "en", { name, outcome: "pending", until })).toBe(
      `+ T-shirt: collect it at the prize desk by ${formatEventTime(at, "Asia/Riyadh", "en")}`,
    );
    const ar = itemLine(tIn("ar"), "ar", { name, outcome: "pending", until });
    expect(ar).toBe(
      `‎+ قميص: استلم جائزتك من مكتب الجوائز قبل ${formatEventTime(at, "Asia/Riyadh", "ar")}`,
    );
    expect(ar).toMatch(/18:30|6:30/);
    expect(ar).not.toMatch(/[٠-٩]/);
  });
});

describe("paidText", () => {
  it("says the points, then the bonus when one was paid", () => {
    const bonus = { points: 50, category: { ar: null, en: "Stage" }, item: null };
    expect(paidText(tIn("en"), GEMS, "en", { points: 10, bonus: null, item: null })).toBe(
      "+10 gems",
    );
    expect(paidText(tIn("en"), GEMS, "en", { points: 10, bonus, item: null })).toBe(
      "+10 gems +50 bonus: Stage complete",
    );
    const item = { name: { ar: null, en: "Cap" }, outcome: "pending" as const, until: null };
    expect(paidText(tIn("en"), GEMS, "en", { points: 0, bonus, item })).toBe(
      "+0 gems + Cap: collect it at the prize desk +50 bonus: Stage complete",
    );
  });
});
