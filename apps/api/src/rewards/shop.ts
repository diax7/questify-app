import type { Pool } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Bilingual } from "#src/quests/store";

export type ShopDeps = Readonly<{ pool: Pool }>;

export type ShopView = Readonly<{
  shop: Readonly<{
    state: "open" | "not_open" | "closed";
    closesAt: string | null;
    pickupMinutes: number;
    rules: Bilingual | null;
    firstRedemption: boolean;
  }>;
  balance: number;
  rewards: ReadonlyArray<Readonly<Record<string, unknown>>>;
  redemptions: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

export type Reservation = Readonly<{
  redemption: Readonly<{ id: string; status: string; price: number; reservedUntil?: string }>;
  balance: number;
  stockLeft: number;
  replayed: boolean;
}>;

export type ReserveResult =
  | Readonly<{ kind: "done"; value: Reservation }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "shop_closed"; reason: string }>
  | Readonly<{ kind: "reward_not_open"; reason: string }>
  | Readonly<{ kind: "sold_out" }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "not_enough_balance" }>
  | Readonly<{ kind: "reservation_ended"; status: string }>;

/** The SQLSTATEs of `reserve_reward` and `cancel_redemption` (migration 0024). */
const REFUSALS: Readonly<Record<string, (detail: string) => ReserveResult>> = {
  RN404: () => ({ kind: "not_found" }),
  RK422: () => ({ kind: "key_reused" }),
  RA403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  RS403: (detail) => ({ kind: "shop_closed", reason: detail }),
  RW403: (detail) => ({ kind: "reward_not_open", reason: detail }),
  RO409: () => ({ kind: "sold_out" }),
  RL409: (detail) => ({ kind: "limit_reached", limit: Number(detail) }),
  RB422: () => ({ kind: "not_enough_balance" }),
  RE409: (detail) => ({ kind: "reservation_ended", status: detail }),
};

/** Runs one shop call as the player; a refusal the database raises becomes its result, anything else is thrown. */
async function asPlayer(
  deps: ShopDeps,
  playerId: string,
  work: (
    query: (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>,
  ) => Promise<ReserveResult>,
): Promise<ReserveResult> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId }, () =>
        work(async (sql, values) => (await client.query(sql, values)).rows),
      ),
    );
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    if (refusal === undefined) {
      throw error;
    }
    return refusal(pg.detail ?? "");
  }
}

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const text = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});

/** Takes the price and one unit at once (FR-506); a retry with the same key answers the first reservation. */
export function reserveReward(
  deps: ShopDeps,
  request: Readonly<{ playerId: string; rewardId: string; idempotencyKey: string }>,
): Promise<ReserveResult> {
  return asPlayer(deps, request.playerId, async (query) => {
    const [row] = await query("SELECT * FROM reserve_reward($1, $2)", [
      request.rewardId,
      request.idempotencyKey,
    ]);
    return {
      kind: "done",
      value: {
        redemption: {
          id: String(row?.["redemption_id"]),
          status: String(row?.["status"]),
          price: Number(row?.["price"]),
          reservedUntil: iso(row?.["reserved_until"]) ?? "",
        },
        balance: Number(row?.["balance"]),
        stockLeft: Number(row?.["stock_left"]),
        replayed: row?.["replayed"] === true,
      },
    };
  });
}

/** The player gives a reservation back before pickup: the price and the unit return (FR-513, FR-1603). */
export function cancelRedemption(
  deps: ShopDeps,
  request: Readonly<{ playerId: string; redemptionId: string }>,
): Promise<ReserveResult> {
  return asPlayer(deps, request.playerId, async (query) => {
    const [row] = await query("SELECT * FROM cancel_redemption($1)", [request.redemptionId]);
    return {
      kind: "done",
      value: {
        redemption: {
          id: String(row?.["redemption_id"]),
          status: String(row?.["status"]),
          price: Number(row?.["price"]),
        },
        balance: Number(row?.["balance"]),
        stockLeft: Number(row?.["stock_left"]),
        replayed: row?.["replayed"] === true,
      },
    };
  });
}

/** The event's shop for a member: undefined for anyone else (not found, never "forbidden"). */
export function readShop(
  deps: ShopDeps,
  request: Readonly<{ playerId: string; eventId: string }>,
): Promise<ShopView | undefined> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId: request.playerId }, async () => {
      const { rows: shops } = await client.query("SELECT * FROM event_shop($1)", [request.eventId]);
      const shop = shops[0];
      if (shop === undefined) {
        return undefined;
      }
      const { rows: rewards } = await client.query("SELECT * FROM shop_rewards($1)", [
        request.eventId,
      ]);
      const { rows: mine } = await client.query("SELECT * FROM my_redemptions($1)", [
        request.eventId,
      ]);
      const rules = text(shop["rules_ar"], shop["rules_en"]);
      return {
        shop: {
          state: shop["state"],
          closesAt: iso(shop["closes_at"]),
          pickupMinutes: shop["pickup_minutes"],
          rules: rules.ar === null && rules.en === null ? null : rules,
          firstRedemption: shop["first_redemption"] === true,
        },
        balance: Number(shop["balance"]),
        rewards: rewards.map((r) => ({
          id: r["id"],
          kind: r["kind"],
          name: text(r["name_ar"], r["name_en"]),
          description: text(r["description_ar"], r["description_en"]),
          price: r["price"],
          stockLeft: r["stock_left"],
          perPlayerLimit: r["per_player_limit"],
          heldByMe: r["held_by_me"],
          opensAt: iso(r["opens_at"]),
          closesAt: iso(r["closes_at"]),
          section: r["section"],
          tags: { new: r["tag_new"], limited: r["tag_limited"], popular: r["popular"] },
        })),
        redemptions: mine.map((d) => ({
          id: d["id"],
          rewardId: d["reward_id"],
          kind: d["kind"],
          name: text(d["name_ar"], d["name_en"]),
          price: d["price"],
          status: d["status"],
          reservedUntil: iso(d["reserved_until"]),
          createdAt: iso(d["created_at"]),
          endedAt: iso(d["ended_at"]),
        })),
      };
    }),
  );
}

/** How many due reservations one tick may return at most; the rest wait for the next tick. */
export const EXPIRY_BATCH = 200;

/**
 * Returns uncollected reservations whose pickup time passed (FR-508), one per transaction (migration 0024: no call
 * holds more than one player's locks). Stops when nothing is due or after `EXPIRY_BATCH`; returns how many expired.
 */
export async function expireReservations(pool: Pool): Promise<number> {
  let expired = 0;
  for (let i = 0; i < EXPIRY_BATCH; i += 1) {
    const outcome = await withConnection(pool, (client) =>
      withRequestContext(client, {}, async () => {
        const { rows } = await client.query<{ outcome: string | null }>(
          "SELECT expire_one_reservation() AS outcome",
        );
        return rows[0]?.outcome ?? null;
      }),
    );
    if (outcome === null) {
      break;
    }
    if (outcome === "expired") {
      expired += 1;
    }
  }
  return expired;
}
