import { describe, expect, it } from "vitest";
import { pickGoal, type GoalReward } from "#src/home/goal";

const NOW = new Date("2026-11-01T12:00:00Z");

const reward = (id: string, price: number, fields: Partial<GoalReward> = {}): GoalReward => ({
  id,
  name: { ar: `جائزة ${id}`, en: `Reward ${id}` },
  price,
  stockLeft: 5,
  perPlayerLimit: null,
  heldByMe: 0,
  closesAt: null,
  ...fields,
});

describe("pickGoal", () => {
  it("shows the pinned reward with what is left, never below zero", () => {
    const shop = [reward("cheap", 10), reward("hoodie", 500)];
    expect(pickGoal(shop, "hoodie", 380, NOW)).toEqual({
      rewardId: "hoodie",
      name: { ar: "جائزة hoodie", en: "Reward hoodie" },
      price: 500,
      left: 120,
      pinned: true,
      soldOut: false,
    });
    expect(pickGoal(shop, "hoodie", 600, NOW)).toMatchObject({ left: 0, pinned: true });
    expect(pickGoal(shop, "hoodie", 500, NOW)).toMatchObject({ left: 0 });
  });

  it("keeps a pinned reward that sold out, and says sold out", () => {
    const shop = [reward("a", 50, { stockLeft: 0 })];
    expect(pickGoal(shop, "a", 0, NOW)).toMatchObject({
      rewardId: "a",
      soldOut: true,
      pinned: true,
    });
  });

  it("drops a pin at the player's limit for the next reachable reward", () => {
    const shop = [reward("a", 50, { perPlayerLimit: 1, heldByMe: 1 }), reward("b", 80)];
    expect(pickGoal(shop, "a", 0, NOW)).toMatchObject({ rewardId: "b", pinned: false });
    const under = [reward("a", 50, { perPlayerLimit: 2, heldByMe: 1 })];
    expect(pickGoal(under, "a", 0, NOW)).toMatchObject({ rewardId: "a", pinned: true });
  });

  it("drops a pin that has closed for the next reachable reward", () => {
    const shop = [reward("a", 50, { closesAt: NOW }), reward("b", 80)];
    expect(pickGoal(shop, "a", 0, NOW)).toMatchObject({ rewardId: "b", pinned: false });
    expect(pickGoal([reward("a", 50, { closesAt: NOW })], "a", 0, NOW)).toBeNull();
    const later = [reward("a", 50, { closesAt: new Date("2026-11-01T12:00:01Z") })];
    expect(pickGoal(later, "a", 0, NOW)).toMatchObject({ rewardId: "a", pinned: true });
  });

  it("falls back to the next reward when the pin is not in the shop", () => {
    expect(pickGoal([reward("a", 50)], "removed", 0, NOW)).toMatchObject({
      rewardId: "a",
      pinned: false,
    });
  });

  it("picks the cheapest reward the player cannot yet afford", () => {
    const shop = [reward("big", 500), reward("affordable", 100), reward("coffee", 150)];
    expect(pickGoal(shop, null, 120, NOW)).toEqual({
      rewardId: "coffee",
      name: { ar: "جائزة coffee", en: "Reward coffee" },
      price: 150,
      left: 30,
      pinned: false,
      soldOut: false,
    });
  });

  it("takes the first in shop order on a tie, and counts a price equal to the balance as affordable", () => {
    const shop = [reward("first", 200), reward("second", 200), reward("equal", 100)];
    expect(pickGoal(shop, null, 100, NOW)?.rewardId).toBe("first");
  });

  it("skips rewards that are sold out, closed or at the player's limit", () => {
    const shop = [
      reward("sold", 20, { stockLeft: 0 }),
      reward("closed", 30, { closesAt: NOW }),
      reward("limit", 40, { perPlayerLimit: 1, heldByMe: 1 }),
      reward("open", 60, {
        closesAt: new Date("2026-11-01T12:00:01Z"),
        perPlayerLimit: 2,
        heldByMe: 1,
      }),
    ];
    expect(pickGoal(shop, null, 0, NOW)?.rewardId).toBe("open");
  });

  it("counts a reward that opens later", () => {
    expect(pickGoal([reward("later", 50)], null, 0, NOW)?.rewardId).toBe("later");
  });

  it("shows nothing when every reward is affordable or the shop is empty", () => {
    expect(pickGoal([reward("a", 10), reward("b", 20)], null, 20, NOW)).toBeNull();
    expect(pickGoal([], null, 0, NOW)).toBeNull();
    expect(pickGoal([], "gone", 0, NOW)).toBeNull();
  });
});
