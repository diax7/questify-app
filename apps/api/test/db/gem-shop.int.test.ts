import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

type Item = {
  id: string;
  kind: string;
  name: { ar: string; en: string };
  visualKey: string | null;
};
type Shop = { gems: number; items: (Item & { price: number; owned: boolean })[] };
type Bought = { itemId: string; gems: number; item: Item; replayed: boolean };
type Refused = { code?: string; detail?: string; hint?: string };

const buyCall = (player: string, item: string, price: number, key = randomUUID()) => ({
  context: { playerId: player },
  sql: "SELECT gem_buy($1, $2, $3) AS r",
  values: [item, price, key],
});
const refusalOf = (error: unknown) => {
  const { code, detail, hint } = error as Refused;
  return { code, detail, hint };
};

/**
 * The gem shop (T-404, migration 0067, ADR-287): the seeded catalog, gem_shop and gem_buy (the seen price, one copy,
 * too few gems, the request-key replay), the locks a purchase shares with the sync, a scan and an erasure, and the
 * tombstone. After every test, each player's balance equals the sum of their gem entries.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("gems: the shop (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterEach(async () => {
    const drift = await f.owner(
      `SELECT x.player_id FROM player_xp x
       WHERE x.gems <> coalesce((SELECT sum(g.delta) FROM gem_entry g WHERE g.player_id = x.player_id), 0)`,
    );
    expect(drift).toEqual([]);
    await f.owner("DELETE FROM platform_setting WHERE key = 'gems'");
  });
  afterAll(async () => {
    await f.close();
  });

  const setAmounts = (value: object) =>
    f.owner(
      `INSERT INTO platform_setting (key, value) VALUES ('gems', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(value)],
    );
  const sync = (player: string) => f.asPlayer(player, "SELECT questify_sync()");
  /** A player at level 2 with `levelUp` + 10 gems (the level and the first event's bronze tier). */
  const funded = async (levelUp: number) => {
    await setAmounts({ levelUp });
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    await sync(player);
    return player;
  };
  const shop = async (player: string) =>
    (await f.asPlayer<{ s: Shop | null }>(player, "SELECT gem_shop() AS s"))[0]?.s;
  const buy = async (player: string, item: string, price: number, key = randomUUID()) =>
    (
      await f.asPlayer<{ r: Bought }>(player, "SELECT gem_buy($1, $2, $3) AS r", [item, price, key])
    )[0]?.r as Bought;
  const balanceOf = async (player: string) =>
    Number(
      (
        await f.owner<{ gems: string }>("SELECT gems FROM player_xp WHERE player_id = $1", [player])
      )[0]?.gems,
    );
  const record = async (player: string) => ({
    gems: await balanceOf(player),
    purchases: await f.owner(
      "SELECT item_id, price FROM gem_purchase WHERE player_id = $1 ORDER BY id",
      [player],
    ),
    spends: await f.owner(
      "SELECT delta FROM gem_entry WHERE player_id = $1 AND source = 'purchase' ORDER BY id",
      [player],
    ),
    shopItems: await f.owner(
      "SELECT item_id FROM player_item WHERE player_id = $1 AND source = 'shop' ORDER BY item_id",
      [player],
    ),
  });
  const xpOf = async (player: string) =>
    (await f.owner("SELECT xp, level FROM player_xp WHERE player_id = $1", [player]))[0];
  /** A live event the player joined with an enter-code quest, for a real scan through complete_quest. */
  const scannable = async (player: string) => {
    const event = await f.newEvent({ phase: "live" });
    await f.join(event, player);
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       SELECT $1, id, 'enter_code', 'Code', 10, '{"code":"ABC"}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [event],
    );
    return {
      context: { playerId: player },
      sql: "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)",
      values: [quest?.id, randomUUID()],
    };
  };

  it("seeds six titles and six frames on the new designs, cheapest first, none owned", async () => {
    const player = await f.newPlayer();
    const list = await shop(player);
    expect(list?.gems).toBe(0);
    expect(
      list?.items.map((item) => [item.id, item.kind, item.visualKey, item.price, item.owned]),
    ).toEqual([
      ["shop-map-reader", "title", null, 40, false],
      ["shop-dune-watcher", "title", null, 50, false],
      ["shop-oasis-warden", "title", null, 55, false],
      ["shop-pearl-diver", "title", null, 60, false],
      ["shop-desert-knight", "title", null, 70, false],
      ["shop-star-navigator", "title", null, 80, false],
      ["shop-dune-ring", "frame", "frame-15", 80, false],
      ["shop-compass-ring", "frame", "frame-16", 90, false],
      ["shop-falcon-ring", "frame", "frame-17", 110, false],
      ["shop-desert-ring", "frame", "frame-18", 120, false],
      ["shop-pearl-ring", "frame", "frame-19", 135, false],
      ["shop-moon-ring", "frame", "frame-20", 150, false],
    ]);
    expect(list?.items[9]?.name).toEqual({ ar: "حلقة الصحراء", en: "Desert ring" });
    const sources = await f.owner(
      `SELECT s.item_id FROM gem_shop_item s
       WHERE EXISTS (SELECT 1 FROM level_item l WHERE l.item_id = s.item_id)
          OR EXISTS (SELECT 1 FROM souvenir_rule r WHERE r.item_id = s.item_id)`,
    );
    expect(sources).toEqual([]);
  });

  it("gets an item: one purchase, one negative entry, one shop item; XP and other players untouched", async () => {
    const player = await funded(100);
    const bystander = await funded(100);
    const xp = await xpOf(player);
    const answer = await buy(player, "shop-dune-ring", 80);
    expect(answer).toEqual({
      itemId: "shop-dune-ring",
      gems: 30,
      item: {
        id: "shop-dune-ring",
        kind: "frame",
        name: { ar: "حلقة الكثبان", en: "Dune ring" },
        visualKey: "frame-15",
      },
      replayed: false,
    });
    expect(await record(player)).toEqual({
      gems: 30,
      purchases: [{ item_id: "shop-dune-ring", price: 80 }],
      spends: [{ delta: -80 }],
      shopItems: [{ item_id: "shop-dune-ring" }],
    });
    expect(await xpOf(player)).toEqual(xp);
    expect(await balanceOf(bystander)).toBe(110);
    expect((await shop(player))?.items.find((item) => item.id === "shop-dune-ring")?.owned).toBe(
      true,
    );
    expect((await shop(bystander))?.items.find((item) => item.id === "shop-dune-ring")?.owned).toBe(
      false,
    );
    const [locker] = await f.asPlayer<{ source: string; source_level: number | null }>(
      player,
      "SELECT source, source_level FROM own_locker(NULL, NULL, 10) WHERE item->>'id' = 'shop-dune-ring'",
    );
    expect(locker).toEqual({ source: "shop", source_level: null });
  });

  it("equips a bought frame, and keeps a retired item owned and equippable while it leaves the shop", async () => {
    const player = await funded(100);
    await buy(player, "shop-compass-ring", 90);
    await f.owner(
      "UPDATE gem_shop_item SET status = 'retired' WHERE item_id = 'shop-compass-ring'",
    );
    try {
      await f.asPlayer(player, "SELECT equip_player($1)", [
        JSON.stringify({ frameId: "shop-compass-ring" }),
      ]);
      const [own] = await f.asPlayer<{ equipment: { frame: Item | null } }>(
        player,
        "SELECT equipment FROM own_equipment()",
      );
      expect(own?.equipment.frame?.id).toBe("shop-compass-ring");
      expect((await shop(player))?.items.map((item) => item.id)).not.toContain("shop-compass-ring");
      const other = await funded(100);
      await expect(buy(other, "shop-compass-ring", 90)).rejects.toMatchObject({ code: "GS404" });
    } finally {
      await f.owner(
        "UPDATE gem_shop_item SET status = 'active' WHERE item_id = 'shop-compass-ring'",
      );
    }
  });

  it("refuses an unknown, owned or re-priced item and too few gems, writing nothing", async () => {
    const player = await funded(30);
    await buy(player, "shop-map-reader", 40);
    const before = await record(player);
    for (const [item, price, expected] of [
      ["no-such-item", 40, { code: "GS404", detail: undefined, hint: undefined }],
      ["shop-map-reader", 40, { code: "GS409", detail: "owned", hint: "0" }],
      ["shop-dune-watcher", 49, { code: "GS409", detail: "price_changed", hint: "0" }],
      ["shop-dune-watcher", 50, { code: "GS409", detail: "too_few_gems", hint: "0" }],
    ] as const) {
      const error = await buy(player, item, price).catch((caught: unknown) => caught);
      expect(refusalOf(error), item).toEqual(expected);
    }
    expect(await record(player)).toEqual(before);
    const poorer = await f.newPlayer();
    await f.play(await f.newEvent(), poorer);
    await sync(poorer);
    const error = await buy(poorer, "shop-map-reader", 40).catch((caught: unknown) => caught);
    expect(refusalOf(error)).toEqual({ code: "GS409", detail: "too_few_gems", hint: "10" });
    expect(await record(poorer)).toMatchObject({ gems: 10, purchases: [], spends: [] });
  });

  it("replays a request key with the current balance and refuses it for another item", async () => {
    const player = await funded(100);
    const key = randomUUID();
    expect((await buy(player, "shop-oasis-warden", 55, key)).gems).toBe(55);
    await setAmounts({ levelUp: 100 });
    await f.play(await f.newEvent(), player, 3);
    await sync(player);
    expect(await balanceOf(player)).toBe(155);
    expect(await buy(player, "shop-oasis-warden", 55, key)).toEqual(
      expect.objectContaining({ itemId: "shop-oasis-warden", gems: 155, replayed: true }),
    );
    await expect(buy(player, "shop-pearl-diver", 60, key)).rejects.toMatchObject({
      code: "GS422",
      detail: "key_reused",
    });
    expect((await record(player)).purchases).toEqual([{ item_id: "shop-oasis-warden", price: 55 }]);
  });

  it("serializes two purchases one balance covers: one is got, the other refused", async () => {
    const player = await funded(100);
    const outcome = await f.crossed(
      buyCall(player, "shop-dune-ring", 80),
      buyCall(player, "shop-star-navigator", 80),
    );
    expect(outcome.waited).toBe(true);
    expect((outcome.first as { r: Bought }).r.gems).toBe(30);
    expect(refusalOf(outcome.second)).toEqual({
      code: "GS409",
      detail: "too_few_gems",
      hint: "30",
    });
    expect((await record(player)).purchases).toEqual([{ item_id: "shop-dune-ring", price: 80 }]);
  });

  it("charges once when the same item is got twice at once, with two keys or one", async () => {
    const twoKeys = await funded(1000);
    const crossed = await f.crossed(
      buyCall(twoKeys, "shop-moon-ring", 150),
      buyCall(twoKeys, "shop-moon-ring", 150),
    );
    expect(refusalOf(crossed.second)).toMatchObject({ code: "GS409", detail: "owned" });
    expect(await record(twoKeys)).toMatchObject({ gems: 860, spends: [{ delta: -150 }] });
    const oneKey = await funded(1000);
    const key = randomUUID();
    const replayed = await f.crossed(
      buyCall(oneKey, "shop-moon-ring", 150, key),
      buyCall(oneKey, "shop-moon-ring", 150, key),
    );
    expect((replayed.second as { r: Bought }).r).toMatchObject({ replayed: true, gems: 860 });
    expect(await record(oneKey)).toMatchObject({ gems: 860, spends: [{ delta: -150 }] });
  });

  it("crosses a paying sync in both orders without a deadlock", async () => {
    for (const purchaseFirst of [true, false]) {
      const player = await funded(100);
      await f.play(await f.newEvent(), player, 3);
      const purchase = buyCall(player, "shop-falcon-ring", 110);
      const paying = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const outcome = purchaseFirst
        ? await f.crossed(purchase, paying)
        : await f.crossed(paying, purchase);
      expect(outcome.waited).toBe(true);
      expect(outcome.first).not.toBeInstanceOf(Error);
      expect(outcome.second).not.toBeInstanceOf(Error);
      // 110 + level 3 (100) - 110.
      expect(await balanceOf(player)).toBe(100);
    }
  });

  it("crosses a scan that reaches a level and grants its item, in both orders", async () => {
    for (const purchaseFirst of [true, false]) {
      await setAmounts({ bronze: 1000 });
      const player = await f.newPlayer();
      await f.play(await f.newEvent(), player);
      await sync(player);
      const scan = await scannable(player);
      const purchase = buyCall(player, "shop-desert-ring", 120);
      const outcome = purchaseFirst
        ? await f.crossed(purchase, scan)
        : await f.crossed(scan, purchase);
      expect(outcome.waited).toBe(true);
      expect(outcome.first).not.toBeInstanceOf(Error);
      expect(outcome.second).not.toBeInstanceOf(Error);
      const owned = await f.owner<{ item_id: string; source: string }>(
        "SELECT item_id, source FROM player_item WHERE player_id = $1 ORDER BY item_id",
        [player],
      );
      expect(owned).toEqual([
        { item_id: "level-2", source: "level" },
        { item_id: "shop-desert-ring", source: "shop" },
      ]);
      expect(await balanceOf(player)).toBe(880);
    }
  });

  it("crosses an erasure in both orders; nothing is got after it commits and a tombstone can neither sync nor buy", async () => {
    for (const purchaseFirst of [true, false]) {
      const player = await funded(100);
      const erase = {
        context: {},
        sql: "SELECT * FROM erase_player($1, true, $2)",
        values: [await f.deletionToken(player), randomUUID()],
      };
      const purchase = buyCall(player, "shop-dune-ring", 80);
      const outcome = purchaseFirst
        ? await f.crossed(purchase, erase)
        : await f.crossed(erase, purchase);
      expect(outcome.waited).toBe(true);
      const bought = purchaseFirst ? outcome.first : outcome.second;
      if (purchaseFirst) {
        expect((bought as { r: Bought }).r.gems).toBe(30);
        expect((await record(player)).purchases).toEqual([
          { item_id: "shop-dune-ring", price: 80 },
        ]);
      } else {
        expect(refusalOf(bought)).toMatchObject({ code: "PI401" });
        expect((await record(player)).purchases).toEqual([]);
      }
      expect((await record(player)).shopItems).toEqual([]);
      await expect(sync(player)).rejects.toMatchObject({ code: "PI401" });
      await expect(buy(player, "shop-map-reader", 40)).rejects.toMatchObject({ code: "PI401" });
      expect(await shop(player)).toBeNull();
    }
  });

  it("refuses a banned player at the shop door", async () => {
    const player = await funded(100);
    await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [player]);
    await expect(buy(player, "shop-map-reader", 40)).rejects.toMatchObject({ code: "PI401" });
    expect(await shop(player)).toBeNull();
    expect((await record(player)).purchases).toEqual([]);
  });
});
