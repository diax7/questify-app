import { describe, expect, it } from "vitest";
import {
  blankReward,
  CODES_PER_UPLOAD,
  createRewardBody,
  editRewardBody,
  firstColumn,
  lowCodeRewards,
  parseCodes,
  rewardDraftOf,
  rewardProblem,
  shopProblem,
  shopRequest,
  type RewardView,
} from "#src/lib/rewards.ts";

const VIEW: RewardView = {
  id: "r1",
  kind: "item",
  name: { ar: "هودي", en: null },
  description: { ar: null, en: "Warm" },
  price: 200,
  stock: 5,
  unitsOut: 2,
  stockLeft: 3,
  perPlayerLimit: 1,
  opensAt: "2030-01-01T07:00:00.000Z",
  closesAt: null,
  section: "merch",
  tags: { new: true, limited: false },
  lowCodes: false,
};

describe("reward drafts", () => {
  it("reads a reward into the event's wall clock, and back into a create body", () => {
    const draft = rewardDraftOf(VIEW, "Asia/Riyadh");
    expect(draft).toMatchObject({
      nameAr: "هودي",
      nameEn: "",
      perPlayerLimit: "1",
      opensAt: "2030-01-01T10:00",
      closesAt: "",
      section: "merch",
    });
    expect(createRewardBody(draft)).toEqual({
      kind: "item",
      name: { ar: "هودي", en: "" },
      description: { ar: "", en: "Warm" },
      price: 200,
      stock: 5,
      perPlayerLimit: 1,
      opensAt: "2030-01-01T10:00",
      closesAt: null,
      section: "merch",
      tags: { new: true, limited: false },
    });
  });

  it("sends only what changed on an edit, with cleared values as null", () => {
    const before = rewardDraftOf(VIEW, "Asia/Riyadh");
    expect(
      editRewardBody({ ...before, stock: 9, perPlayerLimit: "", section: "" }, before),
    ).toEqual({
      stock: 9,
      perPlayerLimit: null,
      section: null,
    });
    expect(editRewardBody(before, before)).toEqual({});
  });
});

describe("rewardProblem", () => {
  const fine = { ...blankReward(), nameEn: "Hoodie" };

  it("accepts a complete draft", () => {
    expect(rewardProblem(fine)).toBeUndefined();
  });

  it.each([
    ["no name in either language", { nameEn: " " }, "name"],
    ["a price of zero", { price: 0 }, "price"],
    ["a price that is not whole", { price: 1.5 }, "price"],
    ["a price too high", { price: 1_000_001 }, "price"],
    ["negative stock", { stock: -1 }, "stock"],
    ["a limit of zero", { perPlayerLimit: "0" }, "perPlayerLimit"],
    ["a limit over 100", { perPlayerLimit: "101" }, "perPlayerLimit"],
    [
      "a close before the open",
      { opensAt: "2030-01-02T10:00", closesAt: "2030-01-01T10:00" },
      "closesAt",
    ],
  ] as const)("names the field for %s", (_name, change, field) => {
    expect(rewardProblem({ ...fine, ...change })).toBe(field);
  });

  it("refuses a stock below what is reserved, and allows it at that count", () => {
    expect(rewardProblem({ ...fine, stock: 1 }, 2)).toBe("stock");
    expect(rewardProblem({ ...fine, stock: 2 }, 2)).toBeUndefined();
  });
});

describe("shopProblem", () => {
  const rules = { ar: null, en: null };

  it("keeps the pickup time and the days after inside their ranges", () => {
    const off = { rules, spendLowersRank: false };
    expect(shopProblem({ pickupMinutes: 15, daysAfter: 0, ...off })).toBeUndefined();
    expect(shopProblem({ pickupMinutes: 10_080, daysAfter: 30, ...off })).toBeUndefined();
    expect(shopProblem({ pickupMinutes: 14, daysAfter: 3, ...off })).toBe("pickupMinutes");
    expect(shopProblem({ pickupMinutes: 120, daysAfter: 31, ...off })).toBe("daysAfter");
  });
});

describe("shopRequest", () => {
  it("sends empty rules as empty text, never null, and the ranking choice", () => {
    expect(
      shopRequest({
        pickupMinutes: 90,
        daysAfter: 2,
        rules: { ar: null, en: "One each" },
        spendLowersRank: true,
      }),
    ).toEqual({
      pickupMinutes: 90,
      daysAfter: 2,
      rules: { ar: "", en: "One each" },
      spendLowersRank: true,
    });
  });
});

describe("digital rewards (T-203)", () => {
  it("creates a digital reward without a stock, and never checks one", () => {
    const draft = { ...blankReward(), kind: "digital" as const, nameEn: "Card", stock: -1 };
    expect(createRewardBody(draft)).not.toHaveProperty("stock");
    expect(createRewardBody(draft)).toMatchObject({ kind: "digital" });
    expect(rewardProblem(draft)).toBeUndefined();
    expect(createRewardBody({ ...draft, kind: "item" })).toHaveProperty("stock", -1);
  });

  it("reads codes one per line, trimmed and normalized, dropping blank lines", () => {
    expect(parseCodes(" A-1 \r\n\nB-2\n  \ne\u0301\n")).toEqual({
      codes: ["A-1", "B-2", "\u00e9"],
    });
  });

  it("names empty, oversized and broken uploads", () => {
    expect(parseCodes(" \n \n")).toEqual({ problem: "empty" });
    const many = Array.from({ length: CODES_PER_UPLOAD + 1 }, (_, i) => `C${i}`).join("\n");
    expect(parseCodes(many)).toEqual({ problem: "tooMany" });
    const most = Array.from({ length: CODES_PER_UPLOAD }, (_, i) => `C${i}`).join("\n");
    expect(parseCodes(most)).toMatchObject({ codes: expect.any(Array) });
    expect(parseCodes("A".repeat(201))).toEqual({ problem: "badCode" });
    expect(parseCodes("A".repeat(200))).toMatchObject({ codes: ["A".repeat(200)] });
    expect(parseCodes("A\tB")).toEqual({ problem: "badCode" });
  });

  it("takes a CSV's first column, unquoting a quoted cell", () => {
    expect(firstColumn('CODE1,10 SAR\r\n"A,""B""",x\nPLAIN\n')).toBe('CODE1\nA,"B"\nPLAIN\n');
  });

  it("lists only the rewards whose codes run low", () => {
    const low = { ...VIEW, id: "r2", kind: "digital" as const, lowCodes: true };
    expect(lowCodeRewards([VIEW, low])).toEqual([low]);
  });
});
