import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

/** A reward as `GET /v1/events/{id}/shop` gives it (T-201). A newer server's unknown kind or section shows as is. */
export type ShopReward = Readonly<{
  id: string;
  kind: string;
  name: Bilingual;
  description: Bilingual;
  price: number;
  stockLeft: number;
  perPlayerLimit: number | null;
  heldByMe: number;
  opensAt: string | null;
  closesAt: string | null;
  section: string | null;
  tags: Readonly<{ new: boolean; limited: boolean; popular: boolean }>;
}>;

export type MyRedemption = Readonly<{
  id: string;
  name: Bilingual;
  price: number;
  status: string;
  reservedUntil: string | null;
}>;

export type ShopView = Readonly<{
  shop: Readonly<{
    state: string;
    pickupMinutes: number;
    rules: Bilingual | null;
    firstRedemption: boolean;
  }>;
  balance: number;
  rewards: readonly ShopReward[];
  redemptions: readonly MyRedemption[];
}>;

export type ShopAnswer =
  | Readonly<{ kind: "shop"; view: ShopView }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual =>
  isRecord(value)
    ? {
        ar: typeof value["ar"] === "string" ? value["ar"] : null,
        en: typeof value["en"] === "string" ? value["en"] : null,
      }
    : { ar: null, en: null };

const numberOf = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringOr = (value: unknown): string | null => (typeof value === "string" ? value : null);

function rewardOf(value: unknown): ShopReward | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  const tags = isRecord(value["tags"]) ? value["tags"] : {};
  return {
    id: value["id"],
    kind: typeof value["kind"] === "string" ? value["kind"] : "item",
    name: textOf(value["name"]),
    description: textOf(value["description"]),
    price: numberOf(value["price"]),
    stockLeft: numberOf(value["stockLeft"]),
    perPlayerLimit: typeof value["perPlayerLimit"] === "number" ? value["perPlayerLimit"] : null,
    heldByMe: numberOf(value["heldByMe"]),
    opensAt: stringOr(value["opensAt"]),
    closesAt: stringOr(value["closesAt"]),
    section: stringOr(value["section"]),
    tags: {
      new: tags["new"] === true,
      limited: tags["limited"] === true,
      popular: tags["popular"] === true,
    },
  };
}

function redemptionOf(value: unknown): MyRedemption | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["status"] !== "string") {
    return undefined;
  }
  return {
    id: value["id"],
    name: textOf(value["name"]),
    price: numberOf(value["price"]),
    status: value["status"],
    reservedUntil: stringOr(value["reservedUntil"]),
  };
}

/** Reads the shop answer; undefined when it is not one (a proxy page, a broken body). Bad rows are left out. */
export function readShop(body: unknown): ShopView | undefined {
  if (!isRecord(body) || !isRecord(body["shop"]) || !Array.isArray(body["rewards"])) {
    return undefined;
  }
  const shop = body["shop"];
  const rules = shop["rules"] === null ? null : textOf(shop["rules"]);
  return {
    shop: {
      state: typeof shop["state"] === "string" ? shop["state"] : "closed",
      pickupMinutes: numberOf(shop["pickupMinutes"], 120),
      rules,
      firstRedemption: shop["firstRedemption"] === true,
    },
    balance: numberOf(body["balance"]),
    rewards: body["rewards"].map(rewardOf).filter((r): r is ShopReward => r !== undefined),
    redemptions: (Array.isArray(body["redemptions"]) ? body["redemptions"] : [])
      .map(redemptionOf)
      .filter((r): r is MyRedemption => r !== undefined),
  };
}

export async function fetchShop(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<ShopAnswer> {
  const answer = await session.request({ method: "GET", path: `/v1/events/${eventId}/shop` });
  if (answer.kind === "ok") {
    const view = readShop(answer.body);
    return view === undefined ? { kind: "network" } : { kind: "shop", view };
  }
  if (answer.kind === "signed_out") {
    return { kind: "signed_out" };
  }
  return answer.kind === "error" && answer.status === 404 ? { kind: "gone" } : { kind: "network" };
}

/** What a reward's button offers this player now. The server decides again on Redeem; this only explains. */
export type RewardAction =
  | "redeem"
  | "sold_out"
  | "not_yet"
  | "ended"
  | "limit"
  | "too_dear"
  | "shop_closed";

export function rewardAction(reward: ShopReward, view: ShopView, now: number): RewardAction {
  if (view.shop.state !== "open") {
    return "shop_closed";
  }
  if (reward.stockLeft <= 0) {
    return "sold_out";
  }
  if (reward.opensAt !== null && Date.parse(reward.opensAt) > now) {
    return "not_yet";
  }
  if (reward.closesAt !== null && Date.parse(reward.closesAt) <= now) {
    return "ended";
  }
  if (reward.perPlayerLimit !== null && reward.heldByMe >= reward.perPlayerLimit) {
    return "limit";
  }
  return view.balance < reward.price ? "too_dear" : "redeem";
}

/** The sections that have at least one reward, in the shop's own order (FR-516). */
export function sectionsOf(rewards: readonly ShopReward[]): string[] {
  const order = ["featured", "merch", "food", "experiences"];
  const present = new Set(rewards.map((r) => r.section).filter((s): s is string => s !== null));
  return [
    ...order.filter((s) => present.has(s)),
    ...[...present].filter((s) => !order.includes(s)),
  ];
}

/** The rewards in a section, or all of them. */
export function inSection(rewards: readonly ShopReward[], section: string | null): ShopReward[] {
  return section === null ? [...rewards] : rewards.filter((r) => r.section === section);
}

/** Whole minutes left to pick up, never below zero (the server returns it once the time passes). */
export function minutesLeft(reservedUntil: string | null, now: number): number {
  return reservedUntil === null
    ? 0
    : Math.max(0, Math.ceil((Date.parse(reservedUntil) - now) / 60_000));
}

export type ShopCallAnswer =
  | Readonly<{ kind: "done"; balance: number }>
  | Readonly<{ kind: "refused"; problem: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

function callAnswer(answer: AuthedResult): ShopCallAnswer {
  if (answer.kind === "ok") {
    return { kind: "done", balance: isRecord(answer.body) ? numberOf(answer.body["balance"]) : 0 };
  }
  if (answer.kind === "error") {
    return { kind: "refused", problem: answer.message };
  }
  return answer.kind === "signed_out" ? { kind: "signed_out" } : { kind: "network" };
}

/**
 * Reserves a reward (FR-506). The key is the tap's: a dropped connection retries with the same key and gets the first
 * answer; a new tap makes a new one, because the convention replays any answer, refusals too, for its key.
 */
export async function reserveReward(
  session: Pick<Session, "request">,
  rewardId: string,
  key: string,
): Promise<ShopCallAnswer> {
  return callAnswer(
    await session.request({
      method: "POST",
      path: `/v1/rewards/${rewardId}/reserve`,
      headers: { "idempotency-key": key },
    }),
  );
}

/** Gives a reservation back before pickup (FR-513); cancelling twice is harmless. */
export async function cancelRedemption(
  session: Pick<Session, "request">,
  redemptionId: string,
): Promise<ShopCallAnswer> {
  return callAnswer(
    await session.request({ method: "POST", path: `/v1/redemptions/${redemptionId}/cancel` }),
  );
}
