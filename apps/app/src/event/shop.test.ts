import { DEFAULT_TERMS, readEventTerms } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import {
  acceptDeskSale,
  acceptHandover,
  cancelRedemption,
  countdown,
  declineDeskSale,
  declineHandover,
  fetchDeskItems,
  fetchShop,
  inSection,
  minutesLeft,
  readShop,
  sourceOf,
  reserveReward,
  rewardAction,
  sectionsOf,
  setGoal,
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
  communityLock: null,
};

const VIEW: ShopView = {
  shop: {
    state: "open",
    closesAt: null,
    pickupMinutes: 120,
    rules: null,
    firstRedemption: true,
    spendLowersRank: false,
    reservation: true,
    desk: {
      location: null,
      hours: null,
      state: "open",
      confirm: "collect_first",
      timeZone: "Asia/Riyadh",
      sells: false,
    },
  },
  balance: 300,
  goalRewardId: null,
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

const GEMS = { ar: { one: "جوهرة", many: "جواهر" }, en: { one: "gem", many: "gems" } };

describe("setGoal", () => {
  it("puts the goal, or null to clear it, and answers the API's words on a refusal", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 200, body: { goalRewardId: "r1" }, headers });
    expect(await setGoal(ok.session, "e1", "r1")).toMatchObject({ kind: "done" });
    await setGoal(ok.session, "e1", null);
    expect(ok.calls).toEqual([
      { method: "PUT", path: "/v1/events/e1/goal", body: { rewardId: "r1" } },
      { method: "PUT", path: "/v1/events/e1/goal", body: { rewardId: null } },
    ]);
    const gone = sessionAnswering({
      kind: "error",
      status: 404,
      code: "not_found",
      message: MESSAGE,
      details: {},
      headers,
    });
    expect(await setGoal(gone.session, "e1", "r1")).toEqual({ kind: "refused", problem: MESSAGE });
    expect(await setGoal(sessionAnswering({ kind: "network" }).session, "e1", null)).toEqual({
      kind: "network",
    });
  });
});

const closesAtOf = (closesAt: unknown) =>
  readShop({ shop: { state: "closed", closesAt }, rewards: [] })?.shop.closesAt;

describe("readShop", () => {
  it("reads the shop, keeping a newer server's unknown kind and leaving bad rows out", () => {
    const view = readShop({
      shop: {
        state: "open",
        closesAt: "2030-01-04T10:00:00.000Z",
        pickupMinutes: 90,
        rules: { ar: "قاعدة", en: null },
        firstRedemption: false,
        spendLowersRank: true,
        desk: { location: { ar: "القاعة ب", en: null }, hours: null, state: "open" },
      },
      balance: 40,
      goalRewardId: "r1",
      rewards: [{ ...REWARD, kind: "mystery_box", tags: { popular: true } }, { name: "no id" }],
      redemptions: [
        {
          id: "d1",
          status: "reserved",
          price: 200,
          reservedUntil: "2030-01-01T12:00:00Z",
          collectUntil: "2030-01-01T10:05:00Z",
          rank: 2,
        },
        {},
        { id: "d2", kind: "digital", status: "delivered", code: "GIFT-1", reservedUntil: null },
        { id: "d3", kind: "digital", status: "delivered", codeUnavailable: true },
        { id: "d4", kind: "digital", status: "delivered", code: "TEST-1A2B3C4D", testCode: true },
      ],
    });
    expect(view?.shop).toEqual({
      state: "open",
      closesAt: "2030-01-04T10:00:00.000Z",
      pickupMinutes: 90,
      rules: { ar: "قاعدة", en: null },
      firstRedemption: false,
      spendLowersRank: true,
      reservation: true,
      desk: {
        location: { ar: "القاعة ب", en: null },
        hours: null,
        state: "open",
        confirm: "collect_first",
        timeZone: "Asia/Riyadh",
        sells: false,
      },
    });
    expect(readShop({ shop: { reservation: false }, rewards: [] })?.shop.reservation).toBe(false);
    expect(view?.goalRewardId).toBe("r1");
    expect(readShop({ shop: {}, rewards: [] })?.goalRewardId).toBeNull();
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
        testCode: false,
        rank: 2,
        source: "rank",
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
        testCode: false,
        rank: null,
        source: "shop",
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
        testCode: false,
        rank: null,
        source: "shop",
      },
      {
        id: "d4",
        kind: "digital",
        name: { ar: null, en: null },
        price: 0,
        status: "delivered",
        reservedUntil: null,
        collectUntil: null,
        code: "TEST-1A2B3C4D",
        codeUnavailable: false,
        testCode: true,
        rank: null,
        source: "shop",
      },
    ]);
  });

  it("reads a redemption's source, from its place when an older API sends none (T-304d)", () => {
    expect(sourceOf("quest", null)).toBe("quest");
    expect(sourceOf("shop", 2)).toBe("shop");
    expect(sourceOf(undefined, 2)).toBe("rank");
    expect(sourceOf("lottery", null)).toBe("shop");
  });

  it("refuses what is not a shop", () => {
    expect(readShop(undefined)).toBeUndefined();
    expect(readShop({ shop: {} })).toBeUndefined();
  });

  it("reads when the shop closes, and null for an older API or a value that is not text (T-410b)", () => {
    expect(closesAtOf("2030-01-04T10:00:00.000Z")).toBe("2030-01-04T10:00:00.000Z");
    expect(closesAtOf(undefined)).toBeNull();
    expect(closesAtOf(null)).toBeNull();
    expect(closesAtOf(1893492000000)).toBeNull();
  });

  it("reads a missing desk as closed, so nothing looks collectable on a guess", () => {
    expect(readShop({ shop: { state: "open" }, rewards: [] })?.shop.desk).toEqual({
      location: null,
      hours: null,
      state: "closed",
      confirm: "collect_first",
      timeZone: "Asia/Riyadh",
      sells: false,
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
    ["at_desk", REWARD, { ...VIEW, shop: { ...VIEW.shop, reservation: false } }],
    [
      "at_desk",
      { ...REWARD, kind: "experience", stockLeft: 0 },
      { ...VIEW, shop: { ...VIEW.shop, reservation: false } },
    ],
    [
      "redeem",
      { ...REWARD, kind: "digital" },
      { ...VIEW, shop: { ...VIEW.shop, reservation: false } },
    ],
    [
      "desk_finished",
      REWARD,
      { ...VIEW, shop: { ...VIEW.shop, reservation: false, desk: FINISHED } },
    ],
  ] as const)("offers %s", (action, reward, view) => {
    expect(rewardAction(reward, view, NOW)).toBe(action);
  });

  it("lets the exact balance redeem, and a reward that opened already", () => {
    expect(
      rewardAction({ ...REWARD, price: 300, opensAt: "2030-01-01T10:00:00Z" }, VIEW, NOW),
    ).toBe("redeem");
  });
});

const SECOND = 1000;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const viewWith = (
  shop: Partial<ShopView["shop"]> = {},
  balance = 300,
  desk: Partial<ShopView["shop"]["desk"]> = {},
): ShopView => ({
  ...VIEW,
  balance,
  shop: { ...VIEW.shop, ...shop, desk: { ...VIEW.shop.desk, ...desk } },
});
const action = (reward: Partial<ShopReward>, view: ShopView = VIEW) =>
  rewardAction({ ...REWARD, ...reward }, view, NOW);

describe("rewardAction, branch by branch", () => {
  const LOCK = {
    goalId: "g",
    title: MESSAGE,
    measure: "points",
    threshold: 10,
    state: "waiting",
    startsAt: "2030-01-01T09:00:00Z",
  } as const;

  it("refuses a shop that is not open, whatever else holds", () => {
    expect(action({}, viewWith({ state: "closed" }))).toBe("shop_closed");
    expect(action({}, viewWith({ state: "paused" }))).toBe("shop_closed");
    expect(action({}, viewWith({ state: "" }))).toBe("shop_closed");
    const everything = { communityLock: LOCK, stockLeft: 0, price: 999 };
    expect(action(everything, viewWith({ state: "closed", reservation: false }))).toBe(
      "shop_closed",
    );
  });

  it("names the community goal before the desk and the stock", () => {
    const view = viewWith({ reservation: false }, 0, { state: "finished" });
    expect(action({ communityLock: LOCK, stockLeft: 0, price: 999 }, view)).toBe(
      "community_locked",
    );
    expect(action({ communityLock: LOCK, kind: "digital" })).toBe("community_locked");
  });

  it("puts the desk before the stock for an item or experience, never for a digital reward", () => {
    const finished = viewWith({ reservation: false }, 0, { state: "finished" });
    for (const kind of ["item", "experience"]) {
      expect(action({ kind, stockLeft: 0, price: 999 }, finished), kind).toBe("desk_finished");
      expect(action({ kind, stockLeft: 0 }, viewWith({ reservation: false })), kind).toBe(
        "at_desk",
      );
      expect(action({ kind, price: 999 }, viewWith({ reservation: false })), kind).toBe("at_desk");
    }
    expect(action({ kind: "digital", stockLeft: 0 }, finished)).toBe("sold_out");
    expect(action({ kind: "digital" }, finished)).toBe("too_dear");
    expect(action({ kind: "digital" }, { ...finished, balance: 300 })).toBe("redeem");
    expect(action({ kind: "digital" }, viewWith({ reservation: false }))).toBe("redeem");
    expect(action({}, viewWith({}, 300, { state: "closed" }))).toBe("redeem");
  });

  it("sells out at zero or below, and not at one", () => {
    expect(action({ stockLeft: 1 })).toBe("redeem");
    expect(action({ stockLeft: 0 })).toBe("sold_out");
    expect(action({ stockLeft: -1 })).toBe("sold_out");
  });

  it("opens at its time exactly, and not a second before", () => {
    expect(action({ opensAt: at(-SECOND) })).toBe("redeem");
    expect(action({ opensAt: at(0) })).toBe("redeem");
    expect(action({ opensAt: at(SECOND) })).toBe("not_yet");
  });

  it("ends at its time exactly, and not a second before", () => {
    expect(action({ closesAt: at(SECOND) })).toBe("redeem");
    expect(action({ closesAt: at(0) })).toBe("ended");
    expect(action({ closesAt: at(-SECOND) })).toBe("ended");
  });

  it("stops a player at the per-player limit, and not below it or without one", () => {
    expect(action({ perPlayerLimit: 2, heldByMe: 1 })).toBe("redeem");
    expect(action({ perPlayerLimit: 2, heldByMe: 2 })).toBe("limit");
    expect(action({ perPlayerLimit: 2, heldByMe: 3 })).toBe("limit");
    expect(action({ perPlayerLimit: 1, heldByMe: 0 })).toBe("redeem");
    expect(action({ perPlayerLimit: null, heldByMe: 99 })).toBe("redeem");
  });

  it("redeems at exactly the price, and is too dear one point under", () => {
    expect(action({ price: 200 }, viewWith({}, 200))).toBe("redeem");
    expect(action({ price: 200 }, viewWith({}, 199))).toBe("too_dear");
    expect(action({ price: 200 }, viewWith({}, 201))).toBe("redeem");
    expect(action({ price: 0 }, viewWith({}, 0))).toBe("redeem");
  });

  it("checks the stock, then the opening, the end, the limit and the price, in that order", () => {
    const all = {
      stockLeft: 0,
      opensAt: at(SECOND),
      closesAt: at(-SECOND),
      perPlayerLimit: 1,
      heldByMe: 1,
      price: 999,
    };
    expect(action(all)).toBe("sold_out");
    expect(action({ ...all, stockLeft: 1 })).toBe("not_yet");
    expect(action({ ...all, stockLeft: 1, opensAt: null })).toBe("ended");
    expect(action({ ...all, stockLeft: 1, opensAt: null, closesAt: null })).toBe("limit");
    expect(action({ ...all, stockLeft: 1, opensAt: null, closesAt: null, heldByMe: 0 })).toBe(
      "too_dear",
    );
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
      testCode: false,
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
      testCode: false,
    });
    const rehearsal = sessionAnswering({
      kind: "ok",
      status: 201,
      body: {
        balance: 45,
        redemption: { status: "delivered", code: "TEST-1A2B3C4D", testCode: true },
      },
      headers,
    });
    expect(await reserveReward(rehearsal.session, "r1", "key-5")).toMatchObject({
      code: "TEST-1A2B3C4D",
      testCode: true,
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
      testCode: false,
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
      sales: [],
      watch: true,
    });
    expect(ok.calls[0]).toEqual({ method: "GET", path: "/v1/me/desk-items" });
    const broken = sessionAnswering({ kind: "ok", status: 200, body: { items: "no" }, headers });
    expect(await fetchDeskItems(broken.session)).toEqual({ kind: "network" });
    expect(await fetchDeskItems(sessionAnswering({ kind: "network" }).session)).toEqual({
      kind: "network",
    });
  });

  it("reads the desk's offers to sell (T-612), leaving rows without an id out", async () => {
    const ok = sessionAnswering({
      kind: "ok",
      status: 200,
      body: {
        items: [],
        sales: [
          {
            id: "s1",
            name: { en: "Hoodie" },
            price: 300,
            offerUntil: "2030-01-01T10:02:00Z",
            balanceAfter: 40,
            desk: { ar: "القاعة ب", en: null },
            rules: { en: "One each" },
            justBought: true,
            currency: GEMS,
          },
          { id: "s2", name: {}, price: 5, offerUntil: null, balanceAfter: 0 },
          { name: "no id" },
          "row",
        ],
        watch: false,
      },
      headers,
    });
    expect(await fetchDeskItems(ok.session)).toEqual({
      kind: "items",
      items: [],
      sales: [
        {
          id: "s1",
          name: { ar: null, en: "Hoodie" },
          price: 300,
          until: "2030-01-01T10:02:00Z",
          balanceAfter: 40,
          desk: { ar: "القاعة ب", en: null },
          rules: { ar: null, en: "One each" },
          justBought: true,
          currency: readEventTerms({ currency: GEMS }).currency,
        },
        {
          id: "s2",
          name: { ar: null, en: null },
          price: 5,
          until: null,
          balanceAfter: 0,
          desk: null,
          rules: null,
          justBought: false,
          currency: DEFAULT_TERMS.currency,
        },
      ],
      watch: false,
    });
    const older = sessionAnswering({ kind: "ok", status: 200, body: { items: [] }, headers });
    expect(await fetchDeskItems(older.session)).toMatchObject({ kind: "items", sales: [] });
  });

  it("pays for the desk's offer with the tap's key, and declines it by the sale's id", async () => {
    const ok = sessionAnswering({ kind: "ok", status: 200, body: {}, headers });
    expect(await acceptDeskSale(ok.session, "s1", "key-7")).toEqual({ kind: "done" });
    expect(await declineDeskSale(ok.session, "s1")).toEqual({ kind: "done" });
    expect(ok.calls).toEqual([
      {
        method: "POST",
        path: "/v1/desk-sales/s1/accept",
        headers: { "idempotency-key": "key-7" },
      },
      { method: "POST", path: "/v1/desk-sales/s1/decline" },
    ]);
    const refused = sessionAnswering({
      kind: "error",
      status: 409,
      code: "sold_out",
      message: MESSAGE,
      details: {},
      headers,
    });
    expect(await acceptDeskSale(refused.session, "s1", "k")).toEqual({
      kind: "refused",
      problem: MESSAGE,
    });
    const offline = sessionAnswering({ kind: "network" });
    expect(await acceptDeskSale(offline.session, "s1", "k")).toEqual({ kind: "network" });
  });

  it("counts down in minutes and seconds, never below zero", () => {
    expect(countdown("2030-01-01T10:04:05Z", NOW)).toBe("4:05");
    expect(countdown("2030-01-01T10:00:00.500Z", NOW)).toBe("0:01");
    expect(countdown("2030-01-01T09:59:00Z", NOW)).toBe("0:00");
    expect(countdown(null, NOW)).toBe("0:00");
  });
});
