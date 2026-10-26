import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  GEM_PRICE_MAX,
  GEM_SHOP_REFUSALS,
  gemPurchaseBodySchema,
  gemPurchaseSchema,
  gemShopConflictSchema,
  gemShopSchema,
  syncGemsSchema,
} from "#src/questify/gems";

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const item = {
  id: "shop-dune-ring",
  kind: "frame",
  name: { ar: "حلقة الكثبان", en: "Dune ring" },
  visualKey: "frame-15",
};

describe("gemPurchaseBodySchema", () => {
  it("takes the item and a whole price from 1 to the cap", () => {
    for (const price of [1, 80, GEM_PRICE_MAX])
      expect(gemPurchaseBodySchema.parse({ itemId: item.id, price })).toEqual({
        itemId: item.id,
        price,
      });
    expect(GEM_PRICE_MAX).toBe(100000);
  });

  it("refuses a price that is not a whole number in range, a missing item and any other field", () => {
    for (const price of [0, -1, 40.5, GEM_PRICE_MAX + 1, "40", null, undefined])
      expect(accepts(gemPurchaseBodySchema, { itemId: item.id, price }), String(price)).toBe(false);
    for (const itemId of ["", "a".repeat(65), 7, undefined])
      expect(accepts(gemPurchaseBodySchema, { itemId, price: 40 })).toBe(false);
    expect(accepts(gemPurchaseBodySchema, { itemId: item.id, price: 40, playerId: "x" })).toBe(
      false,
    );
    expect(accepts(gemPurchaseBodySchema, { itemId: item.id, price: 40, to: "friend" })).toBe(
      false,
    );
  });
});

describe("gemShopSchema", () => {
  const shop = { gems: 30, items: [{ ...item, price: 80, owned: false }] };

  it("keeps the balance and each item with its price and owned flag", () => {
    expect(gemShopSchema.parse(shop)).toEqual(shop);
    expect(gemShopSchema.parse({ gems: 0, items: [] })).toEqual({ gems: 0, items: [] });
  });

  it("refuses a negative or fractional balance, an item with no price or owned flag", () => {
    for (const gems of [-1, 1.5, "3"])
      expect(accepts(gemShopSchema, { ...shop, gems })).toBe(false);
    for (const change of [
      { price: 0 },
      { price: 1.5 },
      { price: undefined },
      { owned: "no" },
      { owned: undefined },
    ])
      expect(
        accepts(gemShopSchema, {
          gems: 1,
          items: [{ ...item, price: 80, owned: false, ...change }],
        }),
      ).toBe(false);
  });
});

describe("gemPurchaseSchema and gemShopConflictSchema", () => {
  it("keeps the purchase answer: the item and the balance after it", () => {
    const answer = { itemId: item.id, gems: 0, item };
    expect(gemPurchaseSchema.parse(answer)).toEqual(answer);
    expect(accepts(gemPurchaseSchema, { ...answer, gems: -1 })).toBe(false);
    expect(accepts(gemPurchaseSchema, { itemId: item.id, gems: 3 })).toBe(false);
  });

  it("names the three refusals with the balance, and no other", () => {
    expect(GEM_SHOP_REFUSALS).toEqual(["owned", "price_changed", "too_few_gems"]);
    for (const reason of GEM_SHOP_REFUSALS)
      expect(gemShopConflictSchema.parse({ reason, gems: 4 })).toEqual({ reason, gems: 4 });
    for (const reason of ["shop_item_locked", "", undefined])
      expect(accepts(gemShopConflictSchema, { reason, gems: 4 })).toBe(false);
    expect(accepts(gemShopConflictSchema, { reason: "owned" })).toBe(false);
  });
});

describe("syncGemsSchema", () => {
  it("keeps what a sync paid and the balance, both whole numbers from 0", () => {
    expect(syncGemsSchema.parse({ earned: 0, balance: 0 })).toEqual({ earned: 0, balance: 0 });
    for (const gems of [{ earned: -1, balance: 0 }, { earned: 0, balance: 0.5 }, { earned: 1 }])
      expect(accepts(syncGemsSchema, gems)).toBe(false);
  });
});
