import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { buyGemItem, gemRefusal, readGemShop } from "#src/questify/gems";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

type Seen = { sql: string; values: readonly unknown[] };
const KEY = "44444444-4444-4444-8444-444444444444";
const ITEM = {
  id: "shop-dune-ring",
  kind: "frame",
  name: { ar: "حلقة الكثبان", en: "Dune ring" },
  visualKey: "frame-15",
};

async function clientAnswering(answer: (sql: string, values: readonly unknown[]) => FakeAnswer) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return answer(sql, values);
  });
  return { client: (await pool.connect()) as PoolClient, seen };
}

const answerOf = (error: unknown) => {
  try {
    gemRefusal(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("gemRefusal returned");
};

describe("the gem shop's refusals (T-404)", () => {
  it.each([
    [{ code: "PI401" }, 401, "unauthenticated", {}],
    [{ code: "GS404" }, 404, "gem_item_not_found", {}],
    [
      { code: "GS409", detail: "owned", hint: "12" },
      409,
      "gem_shop_conflict",
      { reason: "owned", gems: 12 },
    ],
    [
      { code: "GS409", detail: "price_changed", hint: "0" },
      409,
      "gem_shop_conflict",
      { reason: "price_changed", gems: 0 },
    ],
    [
      { code: "GS409", detail: "too_few_gems", hint: "39" },
      409,
      "gem_shop_conflict",
      { reason: "too_few_gems", gems: 39 },
    ],
    [{ code: "GS422", detail: "key_reused" }, 422, "idempotency_key_reused", {}],
  ])("answers %o as %i %s", (error, status, code, details) => {
    const answer = answerOf(error);
    expect(answer).toBeInstanceOf(HttpError);
    expect(answer).toMatchObject({ status, envelope: { code, details } });
  });

  it.each([
    { code: "GS409", detail: "shop_item_locked" },
    { code: "GS409" },
    { code: "40P01" },
    { code: "42501" },
    {},
  ])("rethrows %o unchanged as a server fault", (fields) => {
    const fault = pgError(fields);
    expect(answerOf(fault)).toBe(fault);
  });
});

describe("readGemShop", () => {
  it("answers the shop the database built for the caller", async () => {
    const shop = { gems: 30, items: [{ ...ITEM, price: 80, owned: false }] };
    const { client, seen } = await clientAnswering(() => ({ rows: [{ shop }] }));
    await expect(readGemShop(client)).resolves.toEqual(shop);
    expect(seen.map((one) => one.sql)).toEqual(["SELECT gem_shop() AS shop"]);
  });

  it.each([
    ["a null shop", [{ shop: null }]],
    ["no row", []],
  ])("answers 401 for %s, an inactive caller", async (_label, rows) => {
    const { client } = await clientAnswering(() => ({ rows }));
    await expect(readGemShop(client)).rejects.toMatchObject({ status: 401 });
  });
});

describe("buyGemItem", () => {
  it("sends the item, the seen price and the key, and answers without the replay flag", async () => {
    const { client, seen } = await clientAnswering(() => ({
      rows: [{ result: { itemId: ITEM.id, gems: 30, item: ITEM, replayed: true } }],
    }));
    await expect(
      buyGemItem(client, { itemId: ITEM.id, price: 80, requestKey: KEY }),
    ).resolves.toEqual({
      itemId: ITEM.id,
      gems: 30,
      item: ITEM,
    });
    expect(seen).toEqual([
      { sql: "SELECT gem_buy($1, $2, $3) AS result", values: [ITEM.id, 80, KEY] },
    ]);
  });

  it("answers a refusal as its HTTP error", async () => {
    const { client } = await clientAnswering(() => {
      throw pgError({ code: "GS409", detail: "too_few_gems", hint: "5" });
    });
    await expect(
      buyGemItem(client, { itemId: ITEM.id, price: 80, requestKey: KEY }),
    ).rejects.toMatchObject({
      status: 409,
      envelope: { code: "gem_shop_conflict", details: { reason: "too_few_gems", gems: 5 } },
    });
  });
});
