import type { GemPurchase, GemPurchaseBody, GemShop, GemShopRefusal } from "@questify/shared";
import { GEM_SHOP_REFUSALS } from "@questify/shared";
import type { PoolClient } from "pg";
import {
  gemItemNotFound,
  gemShopConflict,
  idempotencyKeyReused,
  unauthenticated,
} from "#src/auth/http-errors";

/**
 * The Questify gem shop's player doors (T-404, migration 0067, ADR-287): `gem_shop` and `gem_buy` bind the caller from
 * the request context and re-check an active player, so no door can name another player.
 */

const isRefusal = (reason: string | undefined): reason is GemShopRefusal =>
  (GEM_SHOP_REFUSALS as readonly string[]).includes(reason ?? "");

/** A purchase refusal as an HTTP answer, worded by SQLSTATE and DETAIL; anything else is a server fault. */
export function gemRefusal(error: unknown): never {
  const { code, detail, hint } = error as { code?: string; detail?: string; hint?: string };
  if (code === "PI401") throw unauthenticated();
  if (code === "GS404") throw gemItemNotFound();
  if (code === "GS409" && isRefusal(detail)) {
    throw gemShopConflict({ reason: detail, gems: Number(hint) });
  }
  if (code === "GS422") throw idempotencyKeyReused();
  throw error;
}

/** The caller's balance and the active items with their prices and owned flags; an inactive caller has none (401). */
export async function readGemShop(client: PoolClient): Promise<GemShop> {
  const { rows } = await client.query<{ shop: GemShop | null }>("SELECT gem_shop() AS shop");
  const shop = rows[0]?.shop;
  if (shop === null || shop === undefined) throw unauthenticated();
  return shop;
}

/** Gets one item for the price the player saw, once per request key; a replay answers the current balance. */
export async function buyGemItem(
  client: PoolClient,
  purchase: Readonly<GemPurchaseBody & { requestKey: string }>,
): Promise<GemPurchase> {
  try {
    const { rows } = await client.query<{ result: GemPurchase & { replayed: boolean } }>(
      "SELECT gem_buy($1, $2, $3) AS result",
      [purchase.itemId, purchase.price, purchase.requestKey],
    );
    // Stryker disable next-line OptionalChaining: gem_buy always answers one row or raises
    const result = rows[0]?.result as GemPurchase;
    return { itemId: result.itemId, gems: result.gems, item: result.item };
  } catch (error) {
    return gemRefusal(error);
  }
}
