import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  abilityOff,
  deskBusy,
  deskClosed,
  enrollmentInactive,
  featureOff,
  heldAtDesk,
  idempotencyKeyReused,
  notDeskReward,
  notEnoughBalance,
  notFound,
  notOperator,
  pausedAtDesk,
  priceChanged,
  redeemPaused,
  reservationOn,
  rewardLimitReached,
  rewardNotOpen,
  saleGone,
  selfHandover,
  shopClosed,
  soldOut,
  unauthenticated,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { DeskDeps } from "#src/desk/desk";
import type { HttpError } from "#src/http-error";
import type { Bilingual } from "#src/quests/store";
import { verifyMyCode } from "#src/quests/qr";

/** Who is told why: the player paying, or the desk waiting (a flag hold tells the player nothing, ADR-154). */
type Seat = "player" | "desk";

/** A scan the desk shows as a result, as the lookup does: never an error. */
export type ScanReason = "invalid_code" | "old_code" | "not_in_event" | "self_scan" | "ability_off";

const SCAN_REASONS: Readonly<Record<string, ScanReason>> = {
  OM422: "old_code",
  QC404: "not_in_event",
  OY409: "self_scan",
  OA403: "ability_off",
};

const statusOf = (detail: string) => (detail === "paused" ? "paused" : "held");

/**
 * Every refusal of the sale's doors and of a Pay's stored `refusal` (migration 0107) as the HTTP error it answers. A
 * Pay's refusal reads as the reserve route's (sold out 409, too few points 422, ...).
 */
const ERRORS: Readonly<Record<string, (detail: string, seat: Seat) => HttpError>> = {
  RN404: () => notFound(),
  OP403: () => notOperator(),
  OA403: () => abilityOff(),
  OY409: () => selfHandover(),
  RK422: () => idempotencyKeyReused(),
  RA403: (detail) => enrollmentInactive({ reason: detail }),
  RP403: () => redeemPaused(),
  QP403: () => enrollmentInactive({ reason: "operator_not_playing" }),
  RH409: (detail, seat) => {
    if (seat === "desk") {
      return statusOf(detail) === "paused" ? pausedAtDesk() : heldAtDesk();
    }
    return statusOf(detail) === "paused" ? redeemPaused() : saleGone();
  },
  RW403: (detail) => rewardNotOpen({ reason: detail }),
  RS403: (detail) => {
    if (detail === "feature_off") {
      return featureOff();
    }
    return detail === "desk_closed" ? deskClosed() : shopClosed({ reason: detail });
  },
  DS409: (detail) => {
    if (detail === "desk_busy") {
      return deskBusy();
    }
    return detail === "price_changed" ? priceChanged() : reservationOn();
  },
  DS410: () => saleGone(),
  DS422: () => notDeskReward(),
  RO409: () => soldOut(),
  RL409: (detail) => rewardLimitReached({ limit: Number(detail) }),
  RB422: () => notEnoughBalance(),
};

/** A stored refusal (`RO409`, `RW403:ended`) as its HTTP error. */
export function refusalError(refusal: string, seat: Seat): HttpError {
  const [code = "", ...rest] = refusal.split(":");
  const toError = ERRORS[code] ?? (() => saleGone());
  return toError(rest.join(":"), seat);
}

type Scanned<T> =
  | Readonly<{ kind: "done"; value: T }>
  | Readonly<{ kind: "refused"; reason: ScanReason }>;

/**
 * Runs one call as `playerId`. A refusal the database raises becomes its HTTP error (thrown), or for a scan its result;
 * anything else is thrown as it came.
 */
async function run<T>(
  deps: DeskDeps,
  playerId: string,
  options: Readonly<{ seat: Seat; scan: boolean }>,
  work: (client: PoolClient) => Promise<T>,
): Promise<Scanned<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId }, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const reason = options.scan && pg.code !== undefined ? SCAN_REASONS[pg.code] : undefined;
    if (reason !== undefined) {
      return { kind: "refused", reason };
    }
    const toError = pg.code === undefined ? undefined : ERRORS[pg.code];
    if (toError === undefined) {
      throw error;
    }
    throw toError(pg.detail ?? "", options.seat);
  }
}

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const text = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});
const unwrap = <T>(result: Scanned<T>): T => {
  // Stryker disable next-line ConditionalExpression: only a scan answers a refused result
  if (result.kind !== "done") {
    throw notFound();
  }
  return result.value;
};

export type SaleReward = Readonly<{
  id: string;
  kind: "item" | "experience";
  name: Bilingual;
  price: number;
  stockLeft: number;
  /** Whether the player can buy it now; never their balance. */
  can: "ok" | "too_few_points" | "limit" | "sold_out" | "not_open";
}>;

/** "Sell from the shop": the scanned player's offerable rewards (FR-1834). Reads only. */
export function saleRewards(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; eventId: string; code: string }>,
): Promise<Scanned<readonly SaleReward[]>> {
  const opened = verifyMyCode(deps.myKey, request.code);
  if (opened.kind !== "valid") {
    return Promise.resolve({ kind: "refused", reason: "invalid_code" });
  }
  return run(deps, request.operatorId, { seat: "desk", scan: true }, async (client) => {
    const { rows } = await client.query("SELECT * FROM desk_sale_rewards($1, $2, $3)", [
      request.eventId,
      opened.playerId,
      opened.version,
    ]);
    return rows.map((row) => ({
      id: String(row["reward_id"]),
      kind: row["kind"] as SaleReward["kind"],
      name: text(row["name_ar"], row["name_en"]),
      price: Number(row["price"]),
      stockLeft: Number(row["stock_left"]),
      can: row["can"] as SaleReward["can"],
    }));
  });
}

export type Offer = Readonly<{
  id: string;
  status: string;
  price: number;
  offerUntil: string | null;
  replayed: boolean;
  /** The player paid for this reward at a desk in the last 2 minutes. */
  justBought: boolean;
}>;

/** The desk offers one reward to the scanned player for 2 minutes. No points move until the player's Pay. */
export async function offerSale(
  deps: DeskDeps,
  request: Readonly<{
    operatorId: string;
    eventId: string;
    code: string;
    rewardId: string;
    idempotencyKey: string;
  }>,
  caller: Caller,
): Promise<Scanned<Offer>> {
  const opened = verifyMyCode(deps.myKey, request.code);
  if (opened.kind !== "valid") {
    caller.log("desk.sale_refused", { reason: "invalid_code", problem: opened.kind });
    return { kind: "refused", reason: "invalid_code" };
  }
  const result = await run(
    deps,
    request.operatorId,
    { seat: "desk", scan: true },
    async (client) => {
      const { rows } = await client.query("SELECT * FROM desk_offer_sale($1, $2, $3, $4, $5)", [
        request.eventId,
        opened.playerId,
        opened.version,
        request.rewardId,
        request.idempotencyKey,
      ]);
      const row = rows[0] as Record<string, unknown>;
      return {
        id: String(row["sale_id"]),
        status: String(row["status"]),
        price: Number(row["price"]),
        offerUntil: iso(row["offer_until"]),
        replayed: row["replayed"] === true,
        justBought: row["just_bought"] === true,
      };
    },
  );
  if (result.kind === "done") {
    caller.log("desk.sale_offered", {
      saleId: result.value.id,
      replayed: String(result.value.replayed),
    });
  }
  return result;
}

export type SaleState = Readonly<{
  status: "offered" | "accepted" | "declined" | "withdrawn" | "refused" | "expired";
  price: number;
  offerUntil: string | null;
  /** Why the player's Pay was refused, as the error code the player saw; null otherwise. */
  reason: string | null;
}>;

/** The desk's poll while it waits for the player's Pay. */
export async function saleState(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; saleId: string }>,
): Promise<SaleState> {
  return unwrap(
    await run(deps, request.operatorId, { seat: "desk", scan: false }, async (client) => {
      const { rows } = await client.query("SELECT * FROM desk_sale_state($1)", [request.saleId]);
      const row = rows[0] as Record<string, unknown>;
      const refusal = row["refusal"];
      return {
        status: row["status"] as SaleState["status"],
        price: Number(row["price"]),
        offerUntil: iso(row["offer_until"]),
        reason: typeof refusal === "string" ? refusalError(refusal, "desk").envelope.code : null,
      };
    }),
  );
}

/** The desk takes its offer back (the offering operator or any with hand_over); false when it had already ended. */
export async function withdrawSale(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; saleId: string }>,
): Promise<boolean> {
  return unwrap(
    await run(deps, request.operatorId, { seat: "desk", scan: false }, async (client) => {
      const { rows } = await client.query<{ w: boolean }>("SELECT withdraw_desk_sale($1) AS w", [
        request.saleId,
      ]);
      return rows[0]?.w === true;
    }),
  );
}

export type Paid = Readonly<{
  status: "accepted";
  redemptionId: string;
  balance: number;
  replayed: boolean;
}>;

/**
 * The player's Pay (ADR-137): the price and the handover in one transaction. A refusal the database stored on the sale
 * is thrown after the commit as the reserve route's error, so a repeat Pay answers the same.
 */
export async function acceptSale(
  deps: DeskDeps,
  request: Readonly<{ playerId: string; saleId: string }>,
  caller: Caller,
): Promise<Paid> {
  const row = unwrap(
    await run(deps, request.playerId, { seat: "player", scan: false }, async (client) => {
      const { rows } = await client.query("SELECT * FROM accept_desk_sale($1)", [request.saleId]);
      return rows[0] as Record<string, unknown>;
    }),
  );
  caller.log("desk.sale_paid", {
    saleId: request.saleId,
    status: String(row["status"]),
    replayed: String(row["replayed"] === true),
  });
  if (row["status"] === "refused") {
    throw refusalError(String(row["refusal"]), "player");
  }
  if (row["status"] !== "accepted") {
    throw saleGone();
  }
  return {
    status: "accepted",
    redemptionId: String(row["redemption_id"]),
    balance: Number(row["balance"]),
    replayed: row["replayed"] === true,
  };
}

/** Not now: the offer ends; false when it had already ended. */
export async function declineSale(
  deps: DeskDeps,
  request: Readonly<{ playerId: string; saleId: string }>,
): Promise<boolean> {
  return unwrap(
    await run(deps, request.playerId, { seat: "player", scan: false }, async (client) => {
      const { rows } = await client.query<{ d: boolean }>("SELECT decline_desk_sale($1) AS d", [
        request.saleId,
      ]);
      return rows[0]?.d === true;
    }),
  );
}

export type MySale = Readonly<{
  id: string;
  eventId: string;
  event: Bilingual;
  kind: "item" | "experience";
  name: Bilingual;
  price: number;
  offerUntil: string | null;
  balanceAfter: number;
  /** The desk's place (Q-364). */
  desk: Bilingual | null;
  /** The shop's rules, shown before a first redemption only (FR-515). */
  rules: Bilingual | null;
  justBought: boolean;
}>;

/** The caller's live desk offers in every event, for My QR. */
export async function mySales(client: PoolClient): Promise<readonly MySale[]> {
  const { rows } = await client.query("SELECT * FROM my_desk_sales()");
  return rows.map((row) => {
    const desk = text(row["desk_location_ar"], row["desk_location_en"]);
    const rules = text(row["rules_ar"], row["rules_en"]);
    const showRules = row["first_redemption"] === true && (rules.ar !== null || rules.en !== null);
    return {
      id: String(row["sale_id"]),
      eventId: String(row["event_id"]),
      event: text(row["event_name_ar"], row["event_name_en"]),
      kind: row["kind"] as MySale["kind"],
      name: text(row["name_ar"], row["name_en"]),
      price: Number(row["price"]),
      offerUntil: iso(row["offer_until"]),
      balanceAfter: Number(row["balance_after"]),
      desk: desk.ar === null && desk.en === null ? null : desk,
      rules: showRules ? rules : null,
      justBought: row["just_bought"] === true,
    };
  });
}

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
const code = z.string().min(1).max(512);
const rewardsBody = z.strictObject({ eventId: z.uuid(), code });
const offerBody = z.strictObject({ eventId: z.uuid(), code, rewardId: z.uuid() });
const saleParams = z.object({ saleId: z.uuid() });

const playerIdOf = (request: { player?: { id: string } | undefined }): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

/**
 * The desk sale (T-612, FR-1834): the desk's list and offer after a My QR scan, its poll and Withdraw; the player's Pay
 * and Not now. A bad or earlier code is a result the desk shows (`{result: "refused", reason}`), as the lookup's.
 */
export function registerDeskSaleRoutes(app: FastifyInstance, deps: DeskDeps): void {
  app.post("/v1/operator/desk/sale-rewards", player, async (request) => {
    const body = parse(rewardsBody, request.body);
    const result = await saleRewards(deps, { operatorId: playerIdOf(request), ...body });
    return result.kind === "done"
      ? { result: "found", rewards: result.value }
      : { result: "refused", reason: result.reason };
  });

  app.post("/v1/operator/desk/sales", playerIdempotent, async (request, reply) => {
    const body = parse(offerBody, request.body);
    const key = String(request.headers["idempotency-key"]);
    const result = await offerSale(
      deps,
      { operatorId: playerIdOf(request), ...body, idempotencyKey: key },
      callerOf(request),
    );
    if (result.kind !== "done") {
      return { result: "refused", reason: result.reason };
    }
    return reply
      .code(result.value.replayed ? 200 : 201)
      .send({ result: "offered", sale: result.value });
  });

  app.get("/v1/operator/desk/sales/:saleId", player, async (request, reply) => {
    const { saleId } = parse(saleParams, request.params);
    reply.header("cache-control", "no-store");
    return saleState(deps, { operatorId: playerIdOf(request), saleId });
  });

  app.post("/v1/operator/desk/sales/:saleId/withdraw", player, async (request) => {
    const { saleId } = parse(saleParams, request.params);
    return { withdrawn: await withdrawSale(deps, { operatorId: playerIdOf(request), saleId }) };
  });

  app.post("/v1/desk-sales/:saleId/accept", playerIdempotent, async (request) => {
    const { saleId } = parse(saleParams, request.params);
    return acceptSale(deps, { playerId: playerIdOf(request), saleId }, callerOf(request));
  });

  app.post("/v1/desk-sales/:saleId/decline", player, async (request, reply) => {
    const { saleId } = parse(saleParams, request.params);
    await declineSale(deps, { playerId: playerIdOf(request), saleId });
    return reply.code(204).send();
  });
}
