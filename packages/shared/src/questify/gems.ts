import { z } from "zod";
import { itemSchema } from "#src/players/items";

/**
 * Gems (T-404, ADR-285 to ADR-289): earned only from Questify activity and spent only on cosmetic items in the gem
 * shop. Nothing here is money: no price in money, no transfer, no chance.
 */

/** The highest price an item may have (the table's CHECK). */
export const GEM_PRICE_MAX = 100000;
const balance = z.number().int().nonnegative();
const price = z.number().int().min(1).max(GEM_PRICE_MAX);

/** Why the shop refused a purchase that it could otherwise make (409 `gem_shop_conflict`). */
export const GEM_SHOP_REFUSALS = ["owned", "price_changed", "too_few_gems"] as const;
export type GemShopRefusal = (typeof GEM_SHOP_REFUSALS)[number];
/** The 409's details: the reason and the caller's balance now. */
export const gemShopConflictSchema = z.object({
  reason: z.enum(GEM_SHOP_REFUSALS),
  gems: balance,
});
export type GemShopConflict = z.infer<typeof gemShopConflictSchema>;

/** One item on offer, its price in gems and whether the caller owns it already (from any source). */
export const gemShopItemSchema = itemSchema.extend({ price, owned: z.boolean() });
export type GemShopItem = z.infer<typeof gemShopItemSchema>;

/** `GET /v1/me/gem-shop`: the caller's balance and the active items in shop order. */
export const gemShopSchema = z.object({ gems: balance, items: z.array(gemShopItemSchema) });
export type GemShop = z.infer<typeof gemShopSchema>;

/** `POST /v1/me/gem-shop/purchases`: the item and the price the player saw (a changed price is refused). */
export const gemPurchaseBodySchema = z.strictObject({
  itemId: z.string().min(1).max(64),
  price,
});
export type GemPurchaseBody = z.infer<typeof gemPurchaseBodySchema>;

/** A purchase's answer: the item, now in the locker, and the balance after it (the current one on a replay). */
export const gemPurchaseSchema = z.object({
  itemId: z.string().min(1).max(64),
  gems: balance,
  item: itemSchema,
});
export type GemPurchase = z.infer<typeof gemPurchaseSchema>;

/** What one sync paid in gems (0 when nothing) and the balance after it. */
export const syncGemsSchema = z.object({ earned: balance, balance });
export type SyncGems = z.infer<typeof syncGemsSchema>;
