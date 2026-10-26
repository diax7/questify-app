import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { buyGemItem, createPurchaser, fetchGemShop } from "#src/questify/gem-shop-api.ts";

const ring = {
  id: "shop-desert-ring",
  kind: "frame" as const,
  name: { ar: "حلقة الصحراء", en: "Desert ring" },
  visualKey: "frame-18",
};
const offer = { ...ring, price: 120, owned: false };

const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const refused = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details,
  headers: new Headers(),
});
const conflict = (reason: string, gems: number) =>
  refused(409, "gem_shop_conflict", { reason, gems });

const sessionOf = (...answers: AuthedResult[]) => {
  const request = vi.fn();
  for (const answer of answers) request.mockResolvedValueOnce(answer);
  return { request };
};
const keysSent = (session: ReturnType<typeof sessionOf>): string[] =>
  session.request.mock.calls.map((call) => call[0].headers["idempotency-key"] as string);

describe("fetchGemShop", () => {
  it("reads the balance and the items", async () => {
    const session = sessionOf(ok({ gems: 130, items: [offer] }));
    expect(await fetchGemShop(session)).toEqual({ gems: 130, items: [offer] });
    expect(session.request).toHaveBeenCalledWith({ method: "GET", path: "/v1/me/gem-shop" });
  });

  it("gives null for an odd answer or a failure, never an empty shop", async () => {
    expect(await fetchGemShop(sessionOf(ok({ gems: -1, items: [] })))).toBeNull();
    expect(await fetchGemShop(sessionOf(ok({ items: [] })))).toBeNull();
    expect(await fetchGemShop(sessionOf({ kind: "network" }))).toBeNull();
  });
});

describe("buyGemItem", () => {
  const purchase = { itemId: ring.id, price: 120 };

  it("sends the item and the seen price with the key, and reads the new balance", async () => {
    const session = sessionOf(ok({ itemId: ring.id, gems: 10, item: ring }));
    expect(await buyGemItem(session, purchase, "key-1")).toEqual({
      kind: "bought",
      gems: 10,
      item: ring,
    });
    expect(session.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/me/gem-shop/purchases",
      body: { itemId: ring.id, price: 120 },
      headers: { "idempotency-key": "key-1" },
    });
  });

  it.each([
    ["owned", conflict("owned", 130), { kind: "conflict", reason: "owned", gems: 130 }],
    [
      "price changed",
      conflict("price_changed", 130),
      { kind: "conflict", reason: "price_changed", gems: 130 },
    ],
    [
      "too few gems",
      conflict("too_few_gems", 20),
      { kind: "conflict", reason: "too_few_gems", gems: 20 },
    ],
    ["an item that left the shop", refused(404, "gem_item_not_found"), { kind: "gone" }],
    ["the same request still running", refused(409, "request_in_progress"), { kind: "busy" }],
    ["a busy server", refused(503, "busy"), { kind: "busy" }],
    ["a rate limit", refused(429, "rate_limited"), { kind: "limited" }],
    ["a bad request", refused(400, "invalid_request"), { kind: "failed" }],
    ["a conflict with an odd reason", conflict("other", 5), { kind: "failed" }],
    ["an odd success", ok({ gems: "many" }), { kind: "failed" }],
    ["no network", { kind: "network" } as AuthedResult, { kind: "network" }],
    ["an ended session", { kind: "signed_out" } as AuthedResult, { kind: "signed_out" }],
  ] as const)("answers %s", async (_name, answer, outcome) => {
    expect(await buyGemItem(sessionOf(answer), purchase, "key-1")).toEqual(outcome);
  });
});

const counter = () => {
  let n = 0;
  return () => `key-${(n += 1)}`;
};

describe("createPurchaser: a key for each confirmation", () => {
  it("sends the same key again after a lost answer, so a retry cannot charge twice", async () => {
    const session = sessionOf({ kind: "network" }, ok({ itemId: ring.id, gems: 10, item: ring }));
    const buy = createPurchaser(session, counter());
    expect((await buy(ring.id, 120)).kind).toBe("network");
    expect((await buy(ring.id, 120)).kind).toBe("bought");
    expect(keysSent(session)).toEqual(["key-1", "key-1"]);
  });

  it("keeps the key while the server is busy or the request is still running", async () => {
    const session = sessionOf(
      refused(409, "request_in_progress"),
      refused(503, "busy"),
      ok({ itemId: ring.id, gems: 10, item: ring }),
    );
    const buy = createPurchaser(session, counter());
    await buy(ring.id, 120);
    await buy(ring.id, 120);
    await buy(ring.id, 120);
    expect(keysSent(session)).toEqual(["key-1", "key-1", "key-1"]);
  });

  it.each([
    ["a 409 too_few_gems", conflict("too_few_gems", 20)],
    ["a 409 price_changed", conflict("price_changed", 130)],
    ["a 409 owned", conflict("owned", 130)],
    ["a 429", refused(429, "rate_limited")],
    ["a 404", refused(404, "gem_item_not_found")],
    ["a 400", refused(400, "invalid_request")],
  ])("takes a new key for the next confirmation after %s", async (_name, answer) => {
    const session = sessionOf(answer, ok({ itemId: ring.id, gems: 10, item: ring }));
    const buy = createPurchaser(session, counter());
    await buy(ring.id, 120);
    await buy(ring.id, 120);
    expect(keysSent(session)).toEqual(["key-1", "key-2"]);
  });

  it("takes a new key after a purchase, and for another item or another price", async () => {
    const session = sessionOf(
      ok({ itemId: ring.id, gems: 10, item: ring }),
      { kind: "network" },
      { kind: "network" },
      { kind: "network" },
    );
    const buy = createPurchaser(session, counter());
    await buy(ring.id, 120);
    await buy(ring.id, 120);
    await buy("shop-moon-ring", 150);
    await buy("shop-moon-ring", 160);
    expect(keysSent(session)).toEqual(["key-1", "key-2", "key-3", "key-4"]);
  });
});
