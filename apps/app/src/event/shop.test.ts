import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import {
  cancelRedemption,
  fetchShop,
  inSection,
  minutesLeft,
  readShop,
  reserveReward,
  rewardAction,
  sectionsOf,
  type ShopReward,
  type ShopView,
} from "#src/event/shop-api.ts";

const headers = new Headers();
const MESSAGE = { ar: "رسالة", en: "Message" };
const NOW = Date.parse("2030-01-01T10:00:00Z");

const REWARD: ShopReward = {
  id: "r1",
  kind: "item",
  name: { ar: "هودي", en: "Hoodie" },
  description: { ar: null, en: null },
  price: 200,
  stockLeft: 3,
  perPlayerLimit: null,
  heldByMe: 0,
  opensAt: null,
  closesAt: null,
  section: "merch",
  tags: { new: false, limited: false, popular: false },
};

const VIEW: ShopView = {
  shop: { state: "open", pickupMinutes: 120, rules: null, firstRedemption: true },
  balance: 300,
  rewards: [REWARD],
  redemptions: [],
};

function sessionAnswering(answer: AuthedResult) {
  const calls: Omit<ApiRequest, "accessToken">[] = [];
  return {
    calls,
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        calls.push(request);
        return answer;
      },
    },
  };
}

describe("readShop", () => {
  it("reads the shop, keeping a newer server's unknown kind and leaving bad rows out", () => {
    const view = readShop({
      shop: {
        state: "open",
        pickupMinutes: 90,
        rules: { ar: "قاعدة", en: null },
        firstRedemption: false,
      },
      balance: 40,
      rewards: [{ ...REWARD, kind: "mystery_box", tags: { popular: true } }, { name: "no id" }],
      redemptions: [
        { id: "d1", status: "reserved", price: 200, reservedUntil: "2030-01-01T12:00:00Z" },
        {},
      ],
    });
    expect(view?.shop).toEqual({
      state: "open",
      pickupMinutes: 90,
      rules: { ar: "قاعدة", en: null },
      firstRedemption: false,
    });
    expect(view?.rewards).toHaveLength(1);
    expect(view?.rewards[0]).toMatchObject({
      kind: "mystery_box",
      tags: { new: false, popular: true },
    });
    expect(view?.redemptions).toEqual([
      {
        id: "d1",
        name: { ar: null, en: null },
        price: 200,
        status: "reserved",
        reservedUntil: "2030-01-01T12:00:00Z",
      },
    ]);
  });

  it("refuses what is not a shop", () => {
    expect(readShop(undefined)).toBeUndefined();
    expect(readShop({ shop: {} })).toBeUndefined();
  });
});

describe("rewardAction", () => {
  it.each([
    ["redeem", REWARD, VIEW],
    ["shop_closed", REWARD, { ...VIEW, shop: { ...VIEW.shop, state: "closed" } }],
    ["sold_out", { ...REWARD, stockLeft: 0 }, VIEW],
    ["not_yet", { ...REWARD, opensAt: "2030-01-01T11:00:00Z" }, VIEW],
    ["ended", { ...REWARD, closesAt: "2030-01-01T10:00:00Z" }, VIEW],
    ["limit", { ...REWARD, perPlayerLimit: 1, heldByMe: 1 }, VIEW],
    ["too_dear", { ...REWARD, price: 301 }, VIEW],
  ] as const)("offers %s", (action, reward, view) => {
    expect(rewardAction(reward, view, NOW)).toBe(action);
  });

  it("lets the exact balance redeem, and a reward that opened already", () => {
    expect(
      rewardAction({ ...REWARD, price: 300, opensAt: "2030-01-01T10:00:00Z" }, VIEW, NOW),
    ).toBe("redeem");
  });
});

describe("sections", () => {
  const rewards = [
    { ...REWARD, id: "a", section: "food" },
    { ...REWARD, id: "b", section: null },
    { ...REWARD, id: "c", section: "featured" },
    { ...REWARD, id: "d", section: "seasonal" },
  ];

  it("lists the sections present in the shop's order, unknown ones last", () => {
    expect(sectionsOf(rewards)).toEqual(["featured", "food", "seasonal"]);
  });

  it("filters by a section, or shows all", () => {
    expect(inSection(rewards, "food").map((r) => r.id)).toEqual(["a"]);
    expect(inSection(rewards, null)).toHaveLength(4);
  });
});

describe("minutesLeft", () => {
  it("rounds up and never goes below zero", () => {
    expect(minutesLeft("2030-01-01T10:00:30Z", NOW)).toBe(1);
    expect(minutesLeft("2030-01-01T09:00:00Z", NOW)).toBe(0);
    expect(minutesLeft(null, NOW)).toBe(0);
  });
});

describe("the calls", () => {
  it("reads the shop, and tells a stranger, an offline phone and an ended session apart", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 200, body: { ...VIEW }, headers });
    expect(await fetchShop(ok.session, "e1")).toMatchObject({ kind: "shop" });
    expect(ok.calls[0]).toEqual({ method: "GET", path: "/v1/events/e1/shop" });
    const gone = sessionAnswering({
      kind: "error",
      status: 404,
      code: "not_found",
      message: MESSAGE,
      details: {},
      headers,
    });
    expect(await fetchShop(gone.session, "e1")).toEqual({ kind: "gone" });
    expect(await fetchShop(sessionAnswering({ kind: "network" }).session, "e1")).toEqual({
      kind: "network",
    });
    expect(await fetchShop(sessionAnswering({ kind: "signed_out" }).session, "e1")).toEqual({
      kind: "signed_out",
    });
    const broken = sessionAnswering({ kind: "ok", status: 200, body: "<html>", headers });
    expect(await fetchShop(broken.session, "e1")).toEqual({ kind: "network" });
  });

  it("reserves with the tap's key and answers the new balance, or the API's words", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 201, body: { balance: 100 }, headers });
    expect(await reserveReward(ok.session, "r1", "key-1")).toEqual({ kind: "done", balance: 100 });
    expect(ok.calls[0]).toEqual({
      method: "POST",
      path: "/v1/rewards/r1/reserve",
      headers: { "idempotency-key": "key-1" },
    });
    const sold = sessionAnswering({
      kind: "error",
      status: 409,
      code: "sold_out",
      message: MESSAGE,
      details: {},
      headers,
    });
    expect(await reserveReward(sold.session, "r1", "key-2")).toEqual({
      kind: "refused",
      problem: MESSAGE,
    });
  });

  it("cancels by the reservation's id", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 200, body: { balance: 300 }, headers });
    expect(await cancelRedemption(ok.session, "d1")).toEqual({ kind: "done", balance: 300 });
    expect(ok.calls[0]).toEqual({ method: "POST", path: "/v1/redemptions/d1/cancel" });
    expect(await cancelRedemption(sessionAnswering({ kind: "network" }).session, "d1")).toEqual({
      kind: "network",
    });
  });
});
