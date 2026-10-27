import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";
import { lockNoteOf, type CommunityLock } from "#src/event/unlock.ts";
import { deskInfoOf, type DeskInfo } from "#src/operator/desk.ts";

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
  /** The community goal still locking it (T-306c); null when open or from an older API. */
  communityLock: CommunityLock | null;
}>;

export type MyRedemption = Readonly<{
  id: string;
  kind: string;
  name: Bilingual;
  price: number;
  status: string;
  reservedUntil: string | null;
  /** The player's live Collect (collect first), or null. */
  collectUntil: string | null;
  /** A delivered digital reward's code (FR-511); null for anything else, or when the server could not open it. */
  code: string | null;
  codeUnavailable: boolean;
  /** A rehearsal's test code (T-211): never a real one. */
  testCode: boolean;
  /** The winner's place for a rank prize (T-214): no price, no Cancel; null for a shop item. */
  rank: number | null;
  /** Where it comes from (T-304d): the shop, a rank prize or a quest; only a shop item is the player's to cancel. */
  source: RedemptionSource;
}>;

export type RedemptionSource = "shop" | "rank" | "quest";

/** A redemption's source as sent; an older API sends none: a rank prize then has its place. */
export function sourceOf(value: unknown, rank: number | null): RedemptionSource {
  if (value === "shop" || value === "rank" || value === "quest") {
    return value;
  }
  return rank === null ? "shop" : "rank";
}

export type ShopView = Readonly<{
  shop: Readonly<{
    state: string;
    /** When the shop closes (the event's end and its days after); null without an end, and from an older API. */
    closesAt: string | null;
    pickupMinutes: number;
    rules: Bilingual | null;
    firstRedemption: boolean;
    /** A purchase now also lowers the ranking (FR-1847). */
    spendLowersRank: boolean;
    /** The prize desk, shown on every reservation (FR-1716). */
    desk: DeskInfo;
  }>;
  balance: number;
  /** The reward pinned as the player's goal (FR-517, T-213), or null. */
  goalRewardId: string | null;
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
    communityLock: lockNoteOf(value["communityLock"]),
  };
}

function redemptionOf(value: unknown): MyRedemption | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["status"] !== "string") {
    return undefined;
  }
  return {
    id: value["id"],
    kind: typeof value["kind"] === "string" ? value["kind"] : "item",
    name: textOf(value["name"]),
    price: numberOf(value["price"]),
    status: value["status"],
    reservedUntil: stringOr(value["reservedUntil"]),
    collectUntil: stringOr(value["collectUntil"]),
    code: stringOr(value["code"]),
    codeUnavailable: value["codeUnavailable"] === true,
    testCode: value["testCode"] === true,
    rank: typeof value["rank"] === "number" ? value["rank"] : null,
    source: sourceOf(value["source"], typeof value["rank"] === "number" ? value["rank"] : null),
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
      closesAt: stringOr(shop["closesAt"]),
      pickupMinutes: numberOf(shop["pickupMinutes"], 120),
      rules,
      firstRedemption: shop["firstRedemption"] === true,
      spendLowersRank: shop["spendLowersRank"] === true,
      desk: deskInfoOf(shop["desk"]) ?? {
        location: null,
        hours: null,
        state: "closed",
        confirm: "collect_first",
        timeZone: "Asia/Riyadh",
      },
    },
    balance: numberOf(body["balance"]),
    goalRewardId: stringOr(body["goalRewardId"]),
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
  | "shop_closed"
  | "desk_finished"
  /** A community goal still locks it (T-306c): the card names the goal; Redeem would answer reward_not_open. */
  | "community_locked";

export function rewardAction(reward: ShopReward, view: ShopView, now: number): RewardAction {
  if (view.shop.state !== "open") {
    return "shop_closed";
  }
  if (reward.communityLock !== null) {
    return "community_locked";
  }
  // FR-1717, ADR-150: after the desk's last hours, only digital rewards stay redeemable.
  if (reward.kind !== "digital" && view.shop.desk.state === "finished") {
    return "desk_finished";
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
  | Readonly<{
      kind: "done";
      balance: number;
      /** The code a digital redemption gave, when it gave one the server could open. */
      code: string | null;
      /** A rehearsal's test code (T-211). */
      testCode: boolean;
    }>
  | Readonly<{ kind: "refused"; problem: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

function callAnswer(answer: AuthedResult): ShopCallAnswer {
  if (answer.kind === "ok") {
    const body = isRecord(answer.body) ? answer.body : {};
    const redemption = isRecord(body["redemption"]) ? body["redemption"] : {};
    return {
      kind: "done",
      balance: numberOf(body["balance"]),
      code: stringOr(redemption["code"]),
      testCode: redemption["testCode"] === true,
    };
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

/** Pins a reward as the goal, or clears it with null (FR-517). Sending it again sets the same goal. */
export async function setGoal(
  session: Pick<Session, "request">,
  eventId: string,
  rewardId: string | null,
): Promise<ShopCallAnswer> {
  return callAnswer(
    await session.request({
      method: "PUT",
      path: `/v1/events/${eventId}/goal`,
      body: { rewardId },
    }),
  );
}

/** What My QR shows (T-206): rewards ready at a desk or offered by one now, and whether to keep asking. */
export type DeskItemNow = Readonly<{
  id: string;
  kind: string;
  name: Bilingual;
  state: "collecting" | "offered";
  until: string | null;
}>;

export async function fetchDeskItems(
  session: Pick<Session, "request">,
): Promise<
  | Readonly<{ kind: "items"; items: readonly DeskItemNow[]; watch: boolean }>
  | Readonly<{ kind: "network" }>
> {
  const answer = await session.request({ method: "GET", path: "/v1/me/desk-items" });
  if (answer.kind !== "ok" || !isRecord(answer.body) || !Array.isArray(answer.body["items"])) {
    return { kind: "network" };
  }
  const items = answer.body["items"].flatMap((row: unknown): DeskItemNow[] =>
    isRecord(row) && typeof row["id"] === "string"
      ? [
          {
            id: row["id"],
            kind: typeof row["kind"] === "string" ? row["kind"] : "item",
            name: textOf(row["name"]),
            state: row["state"] === "offered" ? "offered" : "collecting",
            until: stringOr(row["until"]),
          },
        ]
      : [],
  );
  return { kind: "items", items, watch: answer.body["watch"] === true };
}

export type DeskCallAnswer =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "refused"; problem: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

function deskAnswer(answer: AuthedResult): DeskCallAnswer {
  if (answer.kind === "ok") {
    return { kind: "done" };
  }
  if (answer.kind === "error") {
    return { kind: "refused", problem: answer.message };
  }
  return answer.kind === "signed_out" ? { kind: "signed_out" } : { kind: "network" };
}

/** Collect (collect first): the reward is ready at the desk for 5 minutes. */
export async function startCollect(
  session: Pick<Session, "request">,
  redemptionId: string,
): Promise<DeskCallAnswer> {
  return deskAnswer(
    await session.request({ method: "POST", path: `/v1/redemptions/${redemptionId}/collect` }),
  );
}

/** Accept the desk's offer (desk offer): the handover is final. The key is the tap's. */
export async function acceptHandover(
  session: Pick<Session, "request">,
  redemptionId: string,
  key: string,
): Promise<DeskCallAnswer> {
  return deskAnswer(
    await session.request({
      method: "POST",
      path: `/v1/redemptions/${redemptionId}/accept`,
      headers: { "idempotency-key": key },
    }),
  );
}

/** Not now: the offer goes, the reservation stays. */
export async function declineHandover(
  session: Pick<Session, "request">,
  redemptionId: string,
): Promise<DeskCallAnswer> {
  return deskAnswer(
    await session.request({ method: "POST", path: `/v1/redemptions/${redemptionId}/decline` }),
  );
}

/** Minutes and seconds left, never below zero, for My QR's countdown ("4:05"). */
export function countdown(until: string | null, now: number): string {
  const seconds = until === null ? 0 : Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
