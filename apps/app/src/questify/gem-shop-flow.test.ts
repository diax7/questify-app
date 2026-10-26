import { describe, expect, it, vi } from "vitest";
import type { PurchaseOutcome } from "#src/questify/gem-shop-api.ts";
import type { GemShop, GemShopItem } from "@questify/shared";
import {
  afterPriceChange,
  equipFieldOf,
  sectionsOf,
  settlePurchase,
  stepAfter,
} from "#src/questify/gem-shop-flow.ts";

const ring: GemShopItem = {
  id: "shop-desert-ring",
  kind: "frame",
  name: { ar: "حلقة الصحراء", en: "Desert ring" },
  visualKey: "frame-18",
  price: 120,
  owned: false,
};
const title: GemShopItem = {
  id: "shop-map-reader",
  kind: "title",
  name: { ar: "قارئ الخرائط", en: "Map reader" },
  visualKey: null,
  price: 40,
  owned: false,
};

describe("stepAfter", () => {
  it("closes the sheet on a purchase, reads the shop again and offers Equip now", () => {
    expect(stepAfter({ kind: "bought", gems: 10, item: ring })).toEqual({
      notice: null,
      closeSheet: true,
      reread: true,
      leave: false,
      bought: ring,
    });
  });

  it("tells a player with too few gems how gems are earned, and closes the sheet", () => {
    expect(stepAfter({ kind: "conflict", reason: "too_few_gems", gems: 20 })).toMatchObject({
      notice: "gemShop.tooFew",
      closeSheet: true,
      reread: true,
      bought: null,
    });
  });

  it("keeps the sheet open on a changed price so it asks again with the new price", () => {
    expect(stepAfter({ kind: "conflict", reason: "price_changed", gems: 200 })).toMatchObject({
      notice: "gemShop.priceChanged",
      closeSheet: false,
      reread: true,
    });
  });

  it("refreshes an item the player already owns", () => {
    expect(stepAfter({ kind: "conflict", reason: "owned", gems: 200 })).toMatchObject({
      notice: "gemShop.alreadyOwned",
      closeSheet: true,
      reread: true,
    });
  });

  it("says an item that left the shop is gone and refreshes", () => {
    expect(stepAfter({ kind: "gone" })).toMatchObject({
      notice: "gemShop.gone",
      closeSheet: true,
      reread: true,
    });
  });

  it.each([
    ["busy", "gemShop.busy"],
    ["limited", "gemShop.limited"],
    ["network", "gemShop.networkFailed"],
  ] as const)("keeps the sheet open after %s so the player can try again", (kind, notice) => {
    expect(stepAfter({ kind })).toMatchObject({ notice, closeSheet: false, reread: false });
  });

  it("reads the shop again after a 200 it could not read, since the item may have been bought", () => {
    expect(stepAfter({ kind: "failed" })).toMatchObject({
      notice: "error.generic",
      closeSheet: false,
      reread: true,
    });
  });

  it("leaves for the start screen when the session ended", () => {
    expect(stepAfter({ kind: "signed_out" })).toMatchObject({ leave: true });
  });
});

const shop = (items: GemShopItem[]): GemShop => ({ gems: 300, items });

describe("afterPriceChange", () => {
  it("asks again about the item at its new price", () => {
    expect(afterPriceChange(shop([{ ...ring, price: 150 }]), ring.id)).toEqual({
      item: { ...ring, price: 150 },
    });
  });

  it("says so when the item left the shop, was bought meanwhile, or the shop could not be read", () => {
    expect(afterPriceChange(shop([title]), ring.id)).toEqual({
      notice: "gemShop.gone",
      closeSheet: true,
    });
    expect(afterPriceChange(shop([{ ...ring, owned: true }]), ring.id)).toEqual({
      notice: "gemShop.alreadyOwned",
      closeSheet: true,
    });
  });

  it("keeps the sheet open with the load failure when the shop could not be read", () => {
    expect(afterPriceChange(null, ring.id)).toEqual({
      notice: "gemShop.failed",
      closeSheet: false,
    });
  });
});

describe("sectionsOf", () => {
  it("groups frames, then titles, then characters, leaving out empty groups", () => {
    expect(sectionsOf([title, ring]).map((section) => section.kind)).toEqual(["frame", "title"]);
    expect(sectionsOf([])).toEqual([]);
  });
});

describe("equipFieldOf", () => {
  it("names the profile field of each kind", () => {
    expect(equipFieldOf("frame")).toBe("frameId");
    expect(equipFieldOf("title")).toBe("titleId");
    expect(equipFieldOf("character")).toBe("characterId");
  });
});

const run = (outcome: PurchaseOutcome, fresh: GemShop | null) => {
  const load = vi.fn().mockResolvedValue(fresh);
  const reloadPlayer = vi.fn();
  const settled = settlePurchase({
    buy: () => Promise.resolve(outcome),
    load,
    reloadPlayer,
    itemId: ring.id,
  });
  return { settled, load, reloadPlayer };
};
const priceMoved: PurchaseOutcome = { kind: "conflict", reason: "price_changed", gems: 300 };

describe("settlePurchase", () => {
  it("keeps the sheet open at the new price after a price change, so it asks again", async () => {
    const { settled, load } = run(priceMoved, shop([{ ...ring, price: 150 }]));
    expect(await settled).toEqual({
      leave: false,
      notice: "gemShop.priceChanged",
      closeSheet: false,
      bought: null,
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("closes the sheet when the price change came with the item leaving the shop", async () => {
    expect(await run(priceMoved, shop([title])).settled).toMatchObject({
      notice: "gemShop.gone",
      closeSheet: true,
    });
  });

  it("keeps the sheet and shows the load failure when the read after a price change fails", async () => {
    expect(await run(priceMoved, null).settled).toMatchObject({
      notice: "gemShop.failed",
      closeSheet: false,
    });
  });

  it("reads the shop and the profile again after a purchase and closes the sheet", async () => {
    const { settled, load, reloadPlayer } = run({ kind: "bought", gems: 10, item: ring }, null);
    expect(await settled).toMatchObject({ closeSheet: true, bought: ring, notice: null });
    expect(load).toHaveBeenCalledTimes(1);
    expect(reloadPlayer).toHaveBeenCalledTimes(1);
  });

  it("reads the shop again after a 200 it could not read", async () => {
    const { settled, load } = run({ kind: "failed" }, shop([ring]));
    expect(await settled).toMatchObject({ notice: "error.generic", closeSheet: false });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reads nothing after a lost answer", async () => {
    const { settled, load } = run({ kind: "network" }, shop([ring]));
    expect(await settled).toMatchObject({ notice: "gemShop.networkFailed", closeSheet: false });
    expect(load).not.toHaveBeenCalled();
  });
});
