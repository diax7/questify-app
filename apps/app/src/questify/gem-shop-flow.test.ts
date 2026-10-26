import { describe, expect, it } from "vitest";
import type { GemShop, GemShopItem } from "@questify/shared";
import {
  afterPriceChange,
  equipFieldOf,
  sectionsOf,
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
    ["failed", "error.generic"],
    ["network", "gemShop.networkFailed"],
  ] as const)("keeps the sheet open after %s so the player can try again", (kind, notice) => {
    expect(stepAfter({ kind })).toMatchObject({ notice, closeSheet: false, reread: false });
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
    expect(afterPriceChange(shop([title]), ring.id)).toEqual({ notice: "gemShop.gone" });
    expect(afterPriceChange(null, ring.id)).toEqual({ notice: "gemShop.gone" });
    expect(afterPriceChange(shop([{ ...ring, owned: true }]), ring.id)).toEqual({
      notice: "gemShop.alreadyOwned",
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
