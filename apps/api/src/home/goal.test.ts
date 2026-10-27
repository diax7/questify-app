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
  communityLock: null,
  ...fields,
});

describe("pickGoal", () => {
  it("shows the pinned reward with what is left, never below zero", () => {
    const shop = [reward("cheap", 10), reward("hoodie", 500)];
    expect(pickGoal(shop, "hoodie", 380, NOW, "open")).toEqual({
      rewardId: "hoodie",
      name: { ar: "جائزة hoodie", en: "Reward hoodie" },
      price: 500,
      left: 120,
      pinned: true,
      soldOut: false,
      communityLock: null,
    });
    expect(pickGoal(shop, "hoodie", 600, NOW, "open")).toMatchObject({ left: 0, pinned: true });
    expect(pickGoal(shop, "hoodie", 500, NOW, "open")).toMatchObject({ left: 0 });
  });

  it("keeps a pinned reward that sold out, and says sold out", () => {
    const shop = [reward("a", 50, { stockLeft: 0 })];
    expect(pickGoal(shop, "a", 0, NOW, "open")).toMatchObject({
      rewardId: "a",
      soldOut: true,
      pinned: true,
    });
  });

  it("drops a pin at the player's limit for the next reachable reward", () => {
    const shop = [reward("a", 50, { perPlayerLimit: 1, heldByMe: 1 }), reward("b", 80)];
    expect(pickGoal(shop, "a", 0, NOW, "open")).toMatchObject({ rewardId: "b", pinned: false });
    const under = [reward("a", 50, { perPlayerLimit: 2, heldByMe: 1 })];
    expect(pickGoal(under, "a", 0, NOW, "open")).toMatchObject({ rewardId: "a", pinned: true });
  });

  it("drops a pin that has closed for the next reachable reward", () => {
    const shop = [reward("a", 50, { closesAt: NOW }), reward("b", 80)];
    expect(pickGoal(shop, "a", 0, NOW, "open")).toMatchObject({ rewardId: "b", pinned: false });
    expect(pickGoal([reward("a", 50, { closesAt: NOW })], "a", 0, NOW, "open")).toBeNull();
    const later = [reward("a", 50, { closesAt: new Date("2026-11-01T12:00:01Z") })];
    expect(pickGoal(later, "a", 0, NOW, "open")).toMatchObject({ rewardId: "a", pinned: true });
  });

  it("falls back to the next reward when the pin is not in the shop", () => {
    expect(pickGoal([reward("a", 50)], "removed", 0, NOW, "open")).toMatchObject({
      rewardId: "a",
      pinned: false,
    });
  });

  it("picks the cheapest reward the player cannot yet afford", () => {
    const shop = [reward("big", 500), reward("affordable", 100), reward("coffee", 150)];
    expect(pickGoal(shop, null, 120, NOW, "open")).toEqual({
      rewardId: "coffee",
      name: { ar: "جائزة coffee", en: "Reward coffee" },
      price: 150,
      left: 30,
      pinned: false,
      soldOut: false,
      communityLock: null,
    });
  });

  it("takes the first in shop order on a tie, and counts a price equal to the balance as affordable", () => {
    const shop = [reward("first", 200), reward("second", 200), reward("equal", 100)];
    expect(pickGoal(shop, null, 100, NOW, "open")?.rewardId).toBe("first");
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
    expect(pickGoal(shop, null, 0, NOW, "open")?.rewardId).toBe("open");
  });

  it("counts a reward that opens later", () => {
    expect(pickGoal([reward("later", 50)], null, 0, NOW, "open")?.rewardId).toBe("later");
  });

  it("shows nothing when every reward is affordable or the shop is empty", () => {
    expect(pickGoal([reward("a", 10), reward("b", 20)], null, 20, NOW, "open")).toBeNull();
    expect(pickGoal([], null, 0, NOW, "open")).toBeNull();
    expect(pickGoal([], "gone", 0, NOW, "open")).toBeNull();
  });
});

describe("pickGoal and the shop's state (T-410, ADR-337)", () => {
  const shop = [reward("cheap", 10), reward("hoodie", 500)];

  it("shows no goal once the shop has closed, pinned or not", () => {
    expect(pickGoal(shop, "hoodie", 380, NOW, "closed")).toBeNull();
    expect(pickGoal(shop, null, 0, NOW, "closed")).toBeNull();
  });

  it("keeps the goal before the shop opens and while it is open", () => {
    expect(pickGoal(shop, "hoodie", 380, NOW, "not_open")).toMatchObject({ rewardId: "hoodie" });
    expect(pickGoal(shop, null, 20, NOW, "open")).toMatchObject({ rewardId: "hoodie" });
  });
});

describe("pickGoal and a community lock (T-306c, CTO 8)", () => {
  const note = {
    goalId: "g",
    title: { ar: null, en: "Light the tower" },
    measure: "points" as const,
    threshold: 500,
    state: "waiting" as const,
    startsAt: NOW.toISOString(),
  };

  it("never picks a locked reward on its own, but keeps a pinned one with its note", () => {
    const shop = [reward("locked", 50, { communityLock: note }), reward("open", 80)];
    expect(pickGoal(shop, null, 10, NOW, "open")).toMatchObject({
      rewardId: "open",
      communityLock: null,
    });
    expect(pickGoal(shop, "locked", 10, NOW, "open")).toMatchObject({
      rewardId: "locked",
      pinned: true,
      communityLock: note,
    });
    expect(
      pickGoal([reward("locked", 50, { communityLock: note })], null, 10, NOW, "open"),
    ).toBeNull();
  });
});
