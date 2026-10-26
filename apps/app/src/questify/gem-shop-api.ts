import {
  gemPurchaseSchema,
  gemShopConflictSchema,
  gemShopSchema,
  type GemShop,
  type GemShopRefusal,
  type ProfileItem,
} from "@questify/shared";
import { readOk, type Reader } from "#src/questify/questify-api.ts";

/** The caller's gems and the items on offer, or null when the answer is missing or odd (never shown as an empty shop). */
export function fetchGemShop(session: Reader): Promise<GemShop | null> {
  return readOk(session, "/v1/me/gem-shop", gemShopSchema);
}

/** What one purchase call came to (T-404, ADR-287, ADR-289). */
export type PurchaseOutcome =
  | Readonly<{ kind: "bought"; gems: number; item: ProfileItem }>
  /** The shop refused and wrote nothing: the item is owned, its price moved, or the balance is short. */
  | Readonly<{ kind: "conflict"; reason: GemShopRefusal; gems: number }>
  /** The item is not in the shop any more (unknown or retired). */
  | Readonly<{ kind: "gone" }>
  /** The same request is still running or the server was busy: ask again with the same key. */
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "limited" }>
  /** Any other refusal, such as a bad request: nothing was bought. */
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

type Seller = Pick<Reader, "request">;

/**
 * Gets one item for the price the player saw. The key is the confirmation's: the server replays every answer below 500
 * for its key (a refusal, a 409 or a 429 included), so each new confirmation needs a new key.
 */
export async function buyGemItem(
  session: Seller,
  purchase: Readonly<{ itemId: string; price: number }>,
  key: string,
): Promise<PurchaseOutcome> {
  const answer = await session.request({
    method: "POST",
    path: "/v1/me/gem-shop/purchases",
    body: { itemId: purchase.itemId, price: purchase.price },
    headers: { "idempotency-key": key },
  });
  if (answer.kind === "signed_out" || answer.kind === "network") return { kind: answer.kind };
  if (answer.kind === "ok") {
    const bought = gemPurchaseSchema.safeParse(answer.body);
    return bought.success
      ? { kind: "bought", gems: bought.data.gems, item: bought.data.item }
      : { kind: "failed" };
  }
  if (answer.status >= 500 || answer.code === "request_in_progress") return { kind: "busy" };
  if (answer.status === 429) return { kind: "limited" };
  if (answer.status === 404) return { kind: "gone" };
  const conflict =
    answer.code === "gem_shop_conflict" ? gemShopConflictSchema.safeParse(answer.details) : null;
  return conflict?.success === true
    ? { kind: "conflict", reason: conflict.data.reason, gems: conflict.data.gems }
    : { kind: "failed" };
}

/** Whether the server stored no answer for the key, so the same key may be sent again (a lost answer, a busy server). */
export const keepsKey = (outcome: PurchaseOutcome): boolean =>
  outcome.kind === "network" || outcome.kind === "busy";

/**
 * Buys with a key per confirmation. While a call's answer is lost or the server is busy, asking again for the same item
 * at the same price sends the same key, so the purchase cannot be charged twice; every other answer ends the
 * confirmation and the next one gets a new key.
 */
export function createPurchaser(session: Seller, makeKey: () => string) {
  let pending: Readonly<{ itemId: string; price: number; key: string }> | undefined;
  return async (itemId: string, price: number): Promise<PurchaseOutcome> => {
    if (pending?.itemId !== itemId || pending.price !== price) {
      pending = { itemId, price, key: makeKey() };
    }
    const outcome = await buyGemItem(session, { itemId, price }, pending.key);
    if (!keepsKey(outcome)) pending = undefined;
    return outcome;
  };
}
