import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  EXPIRY_BATCH,
  cancelRedemption,
  expireReservations,
  readShop,
  reserveReward,
  setGoal,
} from "#src/rewards/shop";
import { createRewardCodeKey, sealCode } from "#src/rewards/codes";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const REWARD = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2030-01-01T10:00:00Z");
const LATER = new Date("2030-01-02T10:00:00Z");

type Answer = (sql: string) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each function call through `answer`; the transaction statements answer nothing. */
function fakePool(answer: Answer) {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      const rows = answer(sql);
      if (rows instanceof Error) {
        throw rows;
      }
      return { rows };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const pgError = (code: string, detail?: string) =>
  Object.assign(new Error("refused"), detail === undefined ? { code } : { code, detail });

const KEY = createRewardCodeKey("r".repeat(32));
const logged: Record<string, unknown>[] = [];
const deps = (pool: Pool) => ({
  pool,
  codeKey: KEY,
  log: (fields: Record<string, unknown>) => logged.push(fields),
});

const RESERVE = { playerId: PLAYER, rewardId: REWARD, idempotencyKey: "key-1" };

describe("reserveReward and cancelRedemption", () => {
  it("answers the reservation the database made", async () => {
    const { pool, statements } = fakePool(() => [
      {
        redemption_id: "d1",
        kind: "item",
        status: "reserved",
        price: 200,
        reserved_until: AT,
        balance: "100",
        stock_left: 4,
        replayed: true,
        code_cipher: null,
      },
    ]);
    expect(await reserveReward(deps(pool), RESERVE)).toEqual({
      kind: "done",
      value: {
        redemption: {
          id: "d1",
          kind: "item",
          status: "reserved",
          price: 200,
          reservedUntil: "2030-01-01T10:00:00.000Z",
        },
        balance: 100,
        stockLeft: 4,
        replayed: true,
      },
    });
    expect(statements).toContain("SELECT * FROM reserve_reward($1, $2)");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("answers a cancel, and a first answer is not a replay", async () => {
    const { pool } = fakePool(() => [
      {
        redemption_id: "d1",
        status: "cancelled",
        price: 200,
        balance: 300,
        stock_left: 5,
        replayed: false,
      },
    ]);
    expect(await cancelRedemption(deps(pool), { playerId: PLAYER, redemptionId: "d1" })).toEqual({
      kind: "done",
      value: {
        redemption: { id: "d1", status: "cancelled", price: 200 },
        balance: 300,
        stockLeft: 5,
        replayed: false,
      },
    });
  });

  it("reads a replay only from a true flag, and no time as null", async () => {
    const { pool } = fakePool(() => [{ redemption_id: "d1", replayed: "true" }]);
    const result = await reserveReward(deps(pool), RESERVE);
    expect(result).toMatchObject({
      value: { replayed: false, redemption: { reservedUntil: null } },
    });
    const none = fakePool(() => []);
    expect(await reserveReward(deps(none.pool), RESERVE)).toMatchObject({
      value: { redemption: { id: "undefined", reservedUntil: null }, replayed: false },
    });
    const replayed = fakePool(() => [{ redemption_id: "d1", status: "cancelled", replayed: true }]);
    expect(
      await cancelRedemption(deps(replayed.pool), { playerId: PLAYER, redemptionId: "d1" }),
    ).toMatchObject({ value: { replayed: true } });
    const empty = fakePool(() => []);
    expect(
      await cancelRedemption(deps(empty.pool), { playerId: PLAYER, redemptionId: "d1" }),
    ).toMatchObject({ value: { replayed: false, redemption: { id: "undefined" } } });
  });

  it.each([
    ["RN404", undefined, { kind: "not_found" }],
    ["RK422", undefined, { kind: "key_reused" }],
    ["RA403", "banned", { kind: "enrollment_inactive", reason: "banned" }],
    ["RS403", "closed", { kind: "shop_closed", reason: "closed" }],
    ["RS403", "feature_off", { kind: "feature_off" }],
    ["RW403", "ended", { kind: "reward_not_open", reason: "ended" }],
    ["RO409", undefined, { kind: "sold_out" }],
    ["RL409", "2", { kind: "limit_reached", limit: 2 }],
    ["RB422", undefined, { kind: "not_enough_balance" }],
    ["RP403", undefined, { kind: "redeem_paused" }],
    ["RE409", "expired", { kind: "reservation_ended", status: "expired" }],
    ["RS403", undefined, { kind: "shop_closed", reason: "" }],
  ])("turns %s (%s) into its refusal and rolls back", async (code, detail, expected) => {
    const { pool, statements } = fakePool(() => pgError(code, detail));
    expect(await reserveReward(deps(pool), RESERVE)).toEqual(expected);
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("throws any other failure", async () => {
    const other = pgError("23505");
    await expect(reserveReward(deps(fakePool(() => other).pool), RESERVE)).rejects.toBe(other);
    const plain = new Error("connection lost");
    await expect(
      cancelRedemption(deps(fakePool(() => plain).pool), { playerId: PLAYER, redemptionId: "d" }),
    ).rejects.toBe(plain);
  });
});

describe("digital codes (FR-511)", () => {
  const sealed = sealCode(KEY, REWARD, "GIFT-2030");
  const delivered = {
    redemption_id: "d9",
    kind: "digital",
    status: "delivered",
    price: 50,
    reserved_until: null,
    balance: "50",
    stock_left: 0,
    replayed: false,
    code_cipher: sealed,
  };

  it("opens the code for the player who redeemed it", async () => {
    const { pool } = fakePool(() => [delivered]);
    expect(await reserveReward(deps(pool), RESERVE)).toMatchObject({
      value: { redemption: { status: "delivered", reservedUntil: null, code: "GIFT-2030" } },
    });
  });

  it("answers without the code, never failing, when it does not open, and logs ids only", async () => {
    logged.length = 0;
    const { pool } = fakePool(() => [{ ...delivered, code_cipher: Buffer.alloc(40) }]);
    const result = await reserveReward(deps(pool), RESERVE);
    expect(result).toMatchObject({ value: { redemption: { codeUnavailable: true } } });
    expect(result).not.toHaveProperty("value.redemption.code");
    expect(logged).toEqual([
      { event: "reward.code_unreadable", redemptionId: "d9", rewardId: REWARD },
    ]);
  });

  it("does not open a code sealed for another reward", async () => {
    const { pool } = fakePool(() => [{ ...delivered, code_cipher: sealCode(KEY, EVENT, "X") }]);
    expect(await reserveReward(deps(pool), RESERVE)).toMatchObject({
      value: { redemption: { codeUnavailable: true } },
    });
  });

  it("shows the code in the player's history", async () => {
    const { pool } = fakePool((sql) => {
      if (sql.includes("event_shop")) {
        return [{ state: "open", balance: "0", pickup_minutes: 60 }];
      }
      if (sql.includes("shop_rewards")) {
        return [];
      }
      return [
        { id: "d9", reward_id: REWARD, kind: "digital", status: "delivered", code_cipher: sealed },
      ];
    });
    const view = await readShop(deps(pool), { playerId: PLAYER, eventId: EVENT });
    expect(view?.redemptions[0]).toMatchObject({ code: "GIFT-2030", status: "delivered" });
    expect(view?.shop.spendLowersRank).toBe(false);
  });

  it("marks an unreadable code in history and logs its redemption", async () => {
    logged.length = 0;
    const { pool } = fakePool((sql) => {
      if (sql.includes("event_shop")) {
        return [{ state: "open", balance: "0", spend_lowers_rank: "yes" }];
      }
      return sql.includes("shop_rewards")
        ? []
        : [{ id: "d7", reward_id: REWARD, kind: "digital", code_cipher: Buffer.alloc(40) }];
    });
    const view = await readShop(deps(pool), { playerId: PLAYER, eventId: EVENT });
    expect(view?.redemptions[0]).toMatchObject({ codeUnavailable: true });
    expect(view?.shop.spendLowersRank).toBe(false);
    expect(logged).toEqual([
      { event: "reward.code_unreadable", redemptionId: "d7", rewardId: REWARD },
    ]);
  });
});

describe("readShop", () => {
  const SHOP = {
    state: "open",
    closes_at: AT,
    pickup_minutes: 90,
    rules_ar: null,
    rules_en: "One each",
    first_redemption: true,
    balance: "250",
    spend_lowers_rank: true,
    desk_location_ar: "القاعة ب",
    desk_location_en: null,
    desk_lat: "24.713600",
    desk_lng: "46.675300",
    desk_opens: [AT],
    desk_closes: [LATER],
    desk_state: "closed",
    handover_confirm: "desk_offer",
    timezone: "Asia/Riyadh",
  };
  const ROW = {
    id: "r1",
    kind: "item",
    name_ar: "هودي",
    name_en: null,
    description_ar: "دافئ",
    description_en: "Warm",
    price: 200,
    stock_left: 3,
    per_player_limit: 1,
    held_by_me: 0,
    opens_at: AT,
    closes_at: LATER,
    section: "merch",
    tag_new: true,
    tag_limited: false,
    popular: true,
  };
  const MINE = {
    id: "d1",
    reward_id: "r1",
    kind: "item",
    name_ar: "هودي",
    name_en: "Hoodie",
    price: 200,
    status: "reserved",
    reserved_until: AT,
    created_at: AT,
    ended_at: LATER,
    collect_until: AT,
    offer_until: null,
    source: "shop",
  };

  const shopPool = (shop: Record<string, unknown> | undefined) =>
    fakePool((sql) => {
      if (sql.includes("event_shop")) {
        return shop === undefined ? [] : [shop];
      }
      if (sql.includes("goal_reward_id")) {
        return [{ goal_reward_id: "r1" }];
      }
      return sql.includes("shop_rewards") ? [ROW] : [MINE];
    });

  it("shows a member the shop, its rewards and their reservations", async () => {
    const { pool, statements } = shopPool(SHOP);
    expect(await readShop(deps(pool), { playerId: PLAYER, eventId: EVENT })).toEqual({
      shop: {
        state: "open",
        closesAt: "2030-01-01T10:00:00.000Z",
        pickupMinutes: 90,
        rules: { ar: null, en: "One each" },
        firstRedemption: true,
        spendLowersRank: true,
        desk: {
          location: { ar: "القاعة ب", en: null },
          pin: { lat: 24.7136, lng: 46.6753 },
          hours: [{ opensAt: "2030-01-01T10:00:00.000Z", closesAt: "2030-01-02T10:00:00.000Z" }],
          state: "closed",
          confirm: "desk_offer",
          timeZone: "Asia/Riyadh",
        },
      },
      balance: 250,
      goalRewardId: "r1",
      rewards: [
        {
          id: "r1",
          kind: "item",
          name: { ar: "هودي", en: null },
          description: { ar: "دافئ", en: "Warm" },
          price: 200,
          stockLeft: 3,
          perPlayerLimit: 1,
          heldByMe: 0,
          opensAt: "2030-01-01T10:00:00.000Z",
          closesAt: "2030-01-02T10:00:00.000Z",
          section: "merch",
          tags: { new: true, limited: false, popular: true },
          communityLock: null,
        },
      ],
      redemptions: [
        {
          id: "d1",
          rewardId: "r1",
          kind: "item",
          name: { ar: "هودي", en: "Hoodie" },
          price: 200,
          status: "reserved",
          reservedUntil: "2030-01-01T10:00:00.000Z",
          createdAt: "2030-01-01T10:00:00.000Z",
          endedAt: "2030-01-02T10:00:00.000Z",
          collectUntil: "2030-01-01T10:00:00.000Z",
          offerUntil: null,
          rank: null,
          source: "shop",
        },
      ],
    });
    expect(statements).toEqual(
      expect.arrayContaining([
        "SELECT * FROM event_shop($1)",
        "SELECT * FROM shop_rewards($1)",
        "SELECT * FROM my_redemptions($1)",
      ]),
    );
  });

  it("gives no rules when neither language has any, and Arabic alone when only it has", async () => {
    const none = shopPool({ ...SHOP, rules_en: null, first_redemption: "yes" });
    expect(await readShop(deps(none.pool), { playerId: PLAYER, eventId: EVENT })).toMatchObject({
      shop: { rules: null, firstRedemption: false },
    });
    const arabic = shopPool({ ...SHOP, rules_ar: "واحدة", rules_en: 7 });
    expect(await readShop(deps(arabic.pool), { playerId: PLAYER, eventId: EVENT })).toMatchObject({
      shop: { rules: { ar: "واحدة", en: null } },
    });
    const english = shopPool({ ...SHOP, rules_ar: 7, rules_en: "One" });
    expect(await readShop(deps(english.pool), { playerId: PLAYER, eventId: EVENT })).toMatchObject({
      shop: { rules: { ar: null, en: "One" } },
    });
  });

  it("gives a non-member nothing", async () => {
    const { pool, statements } = shopPool(undefined);
    expect(await readShop(deps(pool), { playerId: PLAYER, eventId: EVENT })).toBeUndefined();
    expect(statements.some((sql) => sql.includes("shop_rewards"))).toBe(false);
  });
});

describe("setGoal", () => {
  it("sets the goal as the player and answers it", async () => {
    const { pool, statements } = fakePool(() => [{ goal: "r1" }]);
    expect(await setGoal({ pool }, { playerId: PLAYER, eventId: EVENT, rewardId: "r1" })).toEqual({
      kind: "done",
      goalRewardId: "r1",
    });
    expect(statements).toContain("SELECT set_goal($1, $2) AS goal");
    const cleared = fakePool(() => [{ goal: null }]);
    expect(
      await setGoal({ pool: cleared.pool }, { playerId: PLAYER, eventId: EVENT, rewardId: null }),
    ).toEqual({ kind: "done", goalRewardId: null });
    const empty = fakePool(() => []);
    expect(
      await setGoal({ pool: empty.pool }, { playerId: PLAYER, eventId: EVENT, rewardId: null }),
    ).toEqual({ kind: "done", goalRewardId: null });
  });

  it("answers not found on RN404 and throws anything else", async () => {
    const refused = fakePool(() => pgError("RN404"));
    expect(
      await setGoal({ pool: refused.pool }, { playerId: PLAYER, eventId: EVENT, rewardId: "r1" }),
    ).toEqual({ kind: "not_found" });
    const broken = fakePool(() => pgError("57014"));
    await expect(
      setGoal({ pool: broken.pool }, { playerId: PLAYER, eventId: EVENT, rewardId: "r1" }),
    ).rejects.toMatchObject({ code: "57014" });
  });
});

/** A pool whose expiry calls answer `outcomes` in turn, then no row. */
const expiring = (outcomes: (string | null | undefined)[]) =>
  fakePool(() => {
    const next = outcomes.shift();
    return next === undefined ? [] : [{ outcome: next }];
  });

describe("expireReservations", () => {
  it("returns reservations one call at a time until nothing is due, counting the expired", async () => {
    const { pool, statements } = expiring(["expired", "skipped", "expired", null]);
    expect(await expireReservations(pool)).toBe(2);
    expect(statements.filter((sql) => sql.includes("expire_one_reservation"))).toHaveLength(4);
  });

  it("stops when the call answers no row", async () => {
    const { pool, statements } = expiring(["expired"]);
    expect(await expireReservations(pool)).toBe(1);
    expect(statements.filter((sql) => sql.includes("expire_one_reservation"))).toHaveLength(2);
  });

  it("stops after a batch, leaving the rest for the next tick", async () => {
    const { pool, statements } = fakePool(() => [{ outcome: "expired" }]);
    expect(await expireReservations(pool)).toBe(EXPIRY_BATCH);
    expect(statements.filter((sql) => sql.includes("expire_one_reservation"))).toHaveLength(
      EXPIRY_BATCH,
    );
  });
});
