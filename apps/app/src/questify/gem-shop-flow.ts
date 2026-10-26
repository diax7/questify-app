import type { GemShop, GemShopItem, MessageKey, ProfileItem } from "@questify/shared";
import type { PurchaseOutcome } from "#src/questify/gem-shop-api.ts";

/** What the gem shop screen does with the answer to a purchase. */
export type PurchaseStep = Readonly<{
  /** The line to show, or null for none. */
  notice: MessageKey | null;
  /** The confirmation sheet closes (otherwise it stays open for another try or a new price). */
  closeSheet: boolean;
  /** The shop is read again (balance, prices, owned flags). */
  reread: boolean;
  /** The player is signed out: leave for the start screen. */
  leave: boolean;
  /** The item just bought, offered for "Equip now". */
  bought: ProfileItem | null;
}>;

const STEP: PurchaseStep = {
  notice: null,
  closeSheet: false,
  reread: false,
  leave: false,
  bought: null,
};

/**
 * Turns a purchase answer into screen changes (ADR-287, ADR-289). A changed price keeps the sheet open: the shop is read
 * again and the same sheet asks for the new price. A short balance closes it and says how gems are earned, never how
 * to buy them.
 */
export function stepAfter(outcome: PurchaseOutcome): PurchaseStep {
  switch (outcome.kind) {
    case "bought":
      return { ...STEP, closeSheet: true, reread: true, bought: outcome.item };
    case "conflict":
      return conflictStep(outcome.reason);
    case "gone":
      return { ...STEP, notice: "gemShop.gone", closeSheet: true, reread: true };
    case "busy":
      return { ...STEP, notice: "gemShop.busy" };
    case "limited":
      return { ...STEP, notice: "gemShop.limited" };
    case "failed":
      return { ...STEP, notice: "error.generic" };
    case "network":
      return { ...STEP, notice: "gemShop.networkFailed" };
    case "signed_out":
      return { ...STEP, leave: true };
  }
}

function conflictStep(reason: "owned" | "price_changed" | "too_few_gems"): PurchaseStep {
  switch (reason) {
    case "owned":
      return { ...STEP, notice: "gemShop.alreadyOwned", closeSheet: true, reread: true };
    case "price_changed":
      return { ...STEP, notice: "gemShop.priceChanged", reread: true };
    case "too_few_gems":
      return { ...STEP, notice: "gemShop.tooFew", closeSheet: true, reread: true };
  }
}

/** The item as the shop lists it now, or undefined when it left the shop. */
export const offerNow = (shop: GemShop | null, itemId: string): GemShopItem | undefined =>
  shop?.items.find((item) => item.id === itemId);

/** After a price change and a fresh read: the item to ask about again, else the line saying it left the shop. */
export function afterPriceChange(
  fresh: GemShop | null,
  itemId: string,
): Readonly<{ item: GemShopItem }> | Readonly<{ notice: MessageKey }> {
  const item = offerNow(fresh, itemId);
  if (item === undefined || item.owned) {
    return { notice: item === undefined ? "gemShop.gone" : "gemShop.alreadyOwned" };
  }
  return { item };
}

/** Sections of the shop in the order the screen shows them, each with its items; empty sections are left out. */
export function sectionsOf(
  items: readonly GemShopItem[],
): ReadonlyArray<Readonly<{ kind: GemShopItem["kind"]; items: readonly GemShopItem[] }>> {
  return (["frame", "title", "character"] as const)
    .map((kind) => ({ kind, items: items.filter((item) => item.kind === kind) }))
    .filter((section) => section.items.length > 0);
}

/** The profile field that equips an item. */
export const equipFieldOf = (kind: ProfileItem["kind"]) => `${kind}Id` as const;
