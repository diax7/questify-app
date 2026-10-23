import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import {
  acceptHandover,
  cancelRedemption,
  countdown,
  declineHandover,
  fetchDeskItems,
  fetchShop,
  inSection,
  minutesLeft,
  readShop,
  reserveReward,
  rewardAction,
  sectionsOf,
  startCollect,
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
  shop: {
    state: "open",
    pickupMinutes: 120,
    rules: null,
    firstRedemption: true,
    spendLowersRank: false,
    desk: {
      location: null,
      hours: null,
      state: "open",
      confirm: "collect_first",
      timeZone: "Asia/Riyadh",
    },
  },
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
        spendLowersRank: true,
        desk: { location: { ar: "القاعة ب", en: null }, hours: null, state: "open" },
      },
      balance: 40,
      rewards: [{ ...REWARD, kind: "mystery_box", tags: { popular: true } }, { name: "no id" }],
      redemptions: [
        {
          id: "d1",
          status: "reserved",
          price: 200,
          reservedUntil: "2030-01-01T12:00:00Z",
          collectUntil: "2030-01-01T10:05:00Z",
        },
        {},
        { id: "d2", kind: "digital", status: "delivered", code: "GIFT-1", reservedUntil: null },
        { id: "d3", kind: "digital", status: "delivered", codeUnavailable: true },
      ],
    });
    expect(view?.shop).toEqual({
      state: "open",
      pickupMinutes: 90,
      rules: { ar: "قاعدة", en: null },
      firstRedemption: false,
      spendLowersRank: true,
      desk: {
        location: { ar: "القاعة ب", en: null },
        hours: null,
        state: "open",
        confirm: "collect_first",
        timeZone: "Asia/Riyadh",
      },
    });
    expect(view?.rewards).toHaveLength(1);
    expect(view?.rewards[0]).toMatchObject({
      kind: "mystery_box",
      tags: { new: false, popular: true },
    });
    expect(view?.redemptions).toEqual([
      {
        id: "d1",
        kind: "item",
        name: { ar: null, en: null },
        price: 200,
        status: "reserved",
        reservedUntil: "2030-01-01T12:00:00Z",
        collectUntil: "2030-01-01T10:05:00Z",
        code: null,
        codeUnavailable: false,
      },
      {
        id: "d2",
        kind: "digital",
        name: { ar: null, en: null },
        price: 0,
        status: "delivered",
        reservedUntil: null,
        collectUntil: null,
        code: "GIFT-1",
        codeUnavailable: false,
      },
      {
        id: "d3",
        kind: "digital",
        name: { ar: null, en: null },
        price: 0,
        status: "delivered",
        reservedUntil: null,
        collectUntil: null,
        code: null,
        codeUnavailable: true,
      },
    ]);
  });

  it("refuses what is not a shop", () => {
    expect(readShop(undefined)).toBeUndefined();
    expect(readShop({ shop: {} })).toBeUndefined();
  });

  it("reads a missing desk as closed, so nothing looks collectable on a guess", () => {
    expect(readShop({ shop: { state: "open" }, rewards: [] })?.shop.desk).toEqual({
      location: null,
      hours: null,
      state: "closed",
      confirm: "collect_first",
      timeZone: "Asia/Riyadh",
    });
  });
});

const FINISHED = { ...VIEW.shop.desk, state: "finished" } as const;

describe("rewardAction", () => {
  it.each([
    ["redeem", REWARD, VIEW],
    ["shop_closed", REWARD, { ...VIEW, shop: { ...VIEW.shop, state: "closed" } }],
    ["sold_out", { ...REWARD, stockLeft: 0 }, VIEW],
    ["not_yet", { ...REWARD, opensAt: "2030-01-01T11:00:00Z" }, VIEW],
    ["ended", { ...REWARD, closesAt: "2030-01-01T10:00:00Z" }, VIEW],
    ["limit", { ...REWARD, perPlayerLimit: 1, heldByMe: 1 }, VIEW],
    ["too_dear", { ...REWARD, price: 301 }, VIEW],
    ["desk_finished", REWARD, { ...VIEW, shop: { ...VIEW.shop, desk: FINISHED } }],
    [
      "desk_finished",
      { ...REWARD, kind: "experience" },
      { ...VIEW, shop: { ...VIEW.shop, desk: FINISHED } },
    ],
    ["redeem", { ...REWARD, kind: "digital" }, { ...VIEW, shop: { ...VIEW.shop, desk: FINISHED } }],
    ["redeem", REWARD, { ...VIEW, shop: { ...VIEW.shop, desk: { ...FINISHED, state: "closed" } } }],
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
    expect(await reserveReward(ok.session, "r1", "key-1")).toEqual({
      kind: "done",
      balance: 100,
      code: null,
    });
    const digital = sessionAnswering({
      kind: "ok",
      status: 201,
      body: { balance: 50, redemption: { status: "delivered", code: "GIFT-9" } },
      headers,
    });
    expect(await reserveReward(digital.session, "r1", "key-3")).toEqual({
      kind: "done",
      balance: 50,
      code: "GIFT-9",
    });
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

  it("shows the server's words when the owner paused the player (FR-518), on reserve and on Collect", async () => {
    const paused = {
      kind: "error",
      status: 403,
      code: "redeem_paused",
      message: {
        ar: "الاستبدال موقوف لك في هذه الفعالية. تواصل مع فريق الفعالية.",
        en: "Redeeming is paused for you in this event. Ask the event team.",
      },
      details: {},
      headers,
    } as const;
    expect(await reserveReward(sessionAnswering(paused).session, "r1", "key-4")).toEqual({
      kind: "refused",
      problem: paused.message,
    });
    expect(await startCollect(sessionAnswering(paused).session, "d1")).toEqual({
      kind: "refused",
      problem: paused.message,
    });
  });

  it("cancels by the reservation's id", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 200, body: { balance: 300 }, headers });
    expect(await cancelRedemption(ok.session, "d1")).toEqual({
      kind: "done",
      balance: 300,
      code: null,
    });
    expect(ok.calls[0]).toEqual({ method: "POST", path: "/v1/redemptions/d1/cancel" });
    expect(await cancelRedemption(sessionAnswering({ kind: "network" }).session, "d1")).toEqual({
      kind: "network",
    });
  });
});

describe("the desk's calls (T-206)", () => {
  it("collects, accepts with the tap's key and declines by the reservation's id", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 200, body: {}, headers });
    expect(await startCollect(ok.session, "d1")).toEqual({ kind: "done" });
    expect(await acceptHandover(ok.session, "d1", "key-9")).toEqual({ kind: "done" });
    expect(await declineHandover(ok.session, "d1")).toEqual({ kind: "done" });
    expect(ok.calls).toEqual([
      { method: "POST", path: "/v1/redemptions/d1/collect" },
      {
        method: "POST",
        path: "/v1/redemptions/d1/accept",
        headers: { "idempotency-key": "key-9" },
      },
      { method: "POST", path: "/v1/redemptions/d1/decline" },
    ]);
    const refused = sessionAnswering({
      kind: "error",
      status: 409,
      code: "offer_gone",
      message: MESSAGE,
      details: {},
      headers,
    });
    expect(await acceptHandover(refused.session, "d1", "k")).toEqual({
      kind: "refused",
      problem: MESSAGE,
    });
    expect(await startCollect(sessionAnswering({ kind: "network" }).session, "d1")).toEqual({
      kind: "network",
    });
    expect(await declineHandover(sessionAnswering({ kind: "signed_out" }).session, "d1")).toEqual({
      kind: "signed_out",
    });
  });

  it("reads My QR's desk items and whether to keep asking", async () => {
    const ok = sessionAnswering({
      kind: "ok",
      status: 200,
      body: {
        items: [
          { id: "d1", kind: "experience", name: { en: "Lounge" }, state: "offered", until: "x" },
          { id: "d2", state: "?" },
          { name: "no id" },
        ],
        watch: true,
      },
      headers,
    });
    expect(await fetchDeskItems(ok.session)).toEqual({
      kind: "items",
      items: [
        {
          id: "d1",
          kind: "experience",
          name: { ar: null, en: "Lounge" },
          state: "offered",
          until: "x",
        },
        { id: "d2", kind: "item", name: { ar: null, en: null }, state: "collecting", until: null },
      ],
      watch: true,
    });
    expect(ok.calls[0]).toEqual({ method: "GET", path: "/v1/me/desk-items" });
    const broken = sessionAnswering({ kind: "ok", status: 200, body: { items: "no" }, headers });
    expect(await fetchDeskItems(broken.session)).toEqual({ kind: "network" });
    expect(await fetchDeskItems(sessionAnswering({ kind: "network" }).session)).toEqual({
      kind: "network",
    });
  });

  it("counts down in minutes and seconds, never below zero", () => {
    expect(countdown("2030-01-01T10:04:05Z", NOW)).toBe("4:05");
    expect(countdown("2030-01-01T10:00:00.500Z", NOW)).toBe("0:01");
    expect(countdown("2030-01-01T09:59:00Z", NOW)).toBe("0:00");
    expect(countdown(null, NOW)).toBe("0:00");
  });
});
