import type { MessageKey } from "@questify/shared";
import type { Bilingual } from "#src/i18n/text.ts";

/** The desk polls an offer this often while it waits for the player's accept (desk_offer). */
export const OFFER_POLL_MS = 2000;

export type DeskState = "open" | "closed" | "finished";
export type HandoverConfirm = "collect_first" | "desk_offer";
export type DeskWindow = Readonly<{ opensAt: string; closesAt: string }>;

/** The prize desk as `GET /v1/operator/events/{id}/desk` (and the shop) answer it (FR-1716, ADR-150). */
export type DeskInfo = Readonly<{
  location: Bilingual | null;
  hours: readonly DeskWindow[] | null;
  state: DeskState;
  confirm: HandoverConfirm;
  /** The event's zone, to show the hours in. */
  timeZone: string;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual | null =>
  isRecord(value)
    ? {
        ar: typeof value["ar"] === "string" ? value["ar"] : null,
        en: typeof value["en"] === "string" ? value["en"] : null,
      }
    : null;

const STATES: readonly string[] = ["open", "closed", "finished"];

function windowsOf(value: unknown): DeskWindow[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.flatMap((w: unknown): DeskWindow[] =>
    isRecord(w) && typeof w["opensAt"] === "string" && typeof w["closesAt"] === "string"
      ? [{ opensAt: w["opensAt"], closesAt: w["closesAt"] }]
      : [],
  );
}

/** Reads a desk; an unknown state reads as closed, so nothing is handed over on a guess. */
export function deskInfoOf(value: unknown): DeskInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const state = typeof value["state"] === "string" ? value["state"] : "";
  return {
    location: textOf(value["location"]),
    hours: windowsOf(value["hours"]),
    state: STATES.includes(state) ? (state as DeskState) : "closed",
    confirm: value["confirm"] === "desk_offer" ? "desk_offer" : "collect_first",
    timeZone: typeof value["timeZone"] === "string" ? value["timeZone"] : "Asia/Riyadh",
  };
}

/** The line under the desk's title. */
export function deskStateKey(desk: DeskInfo): MessageKey {
  if (desk.state === "open") {
    return desk.hours === null ? "operator.desk.alwaysOpen" : "operator.desk.open";
  }
  return desk.state === "closed" ? "operator.desk.closed" : "operator.desk.finished";
}

export type DeskItem = Readonly<{
  id: string;
  kind: "item" | "experience";
  name: Bilingual;
  /** When the pickup time runs out; null when the server sent none. */
  reservedUntil: string | null;
  /** The player tapped Collect and it is still live (collect_first). */
  ready: boolean;
  /** This desk's own offer is live (desk_offer). */
  offered: boolean;
  offerUntil: string | null;
}>;

export type ScannedPlayer = Readonly<{ username: string; avatar: string }>;

/**
 * Why nothing can be handed over now (FR-1604, FR-1747, FR-1815): `paused` by the owner, or `held` (a flag or a ban;
 * the desk is never told which).
 */
export type DeskHold = "held" | "paused";

export type Found = Readonly<{
  kind: "found";
  player: ScannedPlayer;
  /** False for a player who left or was removed. */
  active: boolean;
  hold: DeskHold | null;
  items: readonly DeskItem[];
}>;

export type Lookup = Found | Readonly<{ kind: "refused"; reason: MessageKey }>;

/** Why a scan at the desk found no one, in the station's own words where they are the same. */
const REFUSED: Readonly<Record<string, MessageKey>> = {
  invalid_code: "operator.red.invalidCode",
  old_code: "operator.red.oldCode",
  not_in_event: "operator.red.notInEvent",
  self_scan: "operator.red.selfScan",
  ability_off: "operator.desk.abilityOff",
};

function itemOf(value: unknown): DeskItem | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  return {
    id: value["id"],
    kind: value["kind"] === "experience" ? "experience" : "item",
    name: textOf(value["name"]) ?? { ar: null, en: null },
    reservedUntil: typeof value["reservedUntil"] === "string" ? value["reservedUntil"] : null,
    ready: value["ready"] === true,
    offered: value["offered"] === true,
    offerUntil: typeof value["offerUntil"] === "string" ? value["offerUntil"] : null,
  };
}

/** Reads `POST /v1/operator/desk/lookup`; undefined when the body is not one (a proxy page, a broken body). */
export function lookupOf(body: unknown): Lookup | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (body["result"] === "refused") {
    return {
      kind: "refused",
      reason: REFUSED[String(body["reason"])] ?? "operator.red.invalidCode",
    };
  }
  const player = body["player"];
  if (body["result"] !== "found" || !isRecord(player) || !Array.isArray(body["items"])) {
    return undefined;
  }
  const hold = body["hold"];
  return {
    kind: "found",
    player: { username: String(player["username"]), avatar: String(player["avatar"]) },
    active: body["active"] === true,
    // Anything but a known hold or none reads as held: nothing is handed over on a guess.
    hold: hold === null || hold === undefined ? null : hold === "paused" ? "paused" : "held",
    items: body["items"].map(itemOf).filter((item): item is DeskItem => item !== undefined),
  };
}

/** Reads `POST …/desk/find` (FR-1848): the same answer as a scan, or nobody by that name or number. */
export function findOf(body: unknown): Lookup | undefined {
  if (isRecord(body) && body["result"] === "none") {
    return { kind: "refused", reason: "operator.desk.noMatch" };
  }
  return lookupOf(body);
}

/** Whole minutes left of an item's pickup time, never below 0; null when unknown. */
export function pickupMinutesLeft(item: DeskItem, now: number): number | null {
  const until = item.reservedUntil === null ? Number.NaN : Date.parse(item.reservedUntil);
  return Number.isNaN(until) ? null : Math.max(0, Math.ceil((until - now) / 60_000));
}

/**
 * What a waiting item's row offers now. The server decides again on every tap; this only keeps the desk from offering
 * what it would refuse:
 * - `blocked`: the player left or was removed; `paused` and `held`: the owner must act first (Cancel stays);
 * - `closed`: outside the desk's hours (look-up still works);
 * - collect_first: `hand_over` once the player tapped Collect, else `not_ready`;
 * - desk_offer: `offer`, then `waiting` while this desk's offer is live.
 */
export type ItemAction =
  | "blocked"
  | "paused"
  | "held"
  | "closed"
  | "hand_over"
  | "not_ready"
  | "offer"
  | "waiting";

export function itemAction(
  item: DeskItem,
  desk: DeskInfo,
  found: Readonly<{ active: boolean; hold: DeskHold | null }>,
  now: number,
): ItemAction {
  if (!found.active) {
    return "blocked";
  }
  if (found.hold !== null) {
    return found.hold;
  }
  if (desk.state !== "open") {
    return "closed";
  }
  if (desk.confirm === "collect_first") {
    return item.ready ? "hand_over" : "not_ready";
  }
  return item.offered && item.offerUntil !== null && Date.parse(item.offerUntil) > now
    ? "waiting"
    : "offer";
}

/** The button's words: an experience is confirmed, an item handed over (FR-509). */
export function actionLabel(item: DeskItem, action: "hand_over" | "offer"): MessageKey {
  if (item.kind === "experience") {
    return "operator.confirm";
  }
  return action === "hand_over" ? "operator.desk.handedOver" : "operator.desk.handOver";
}

/** Where an offer stands after a poll: the player accepted, the desk keeps waiting, or it lapsed or ended. */
export type OfferOutcome = "accepted" | "waiting" | "lapsed" | "ended";

export function offerOutcome(
  poll: Readonly<{ status: string; offered: boolean; offerUntil: string | null }>,
  now: number,
): OfferOutcome {
  if (poll.status === "handed_over") {
    return "accepted";
  }
  if (poll.status !== "reserved") {
    return "ended";
  }
  return poll.offered && poll.offerUntil !== null && Date.parse(poll.offerUntil) > now
    ? "waiting"
    : "lapsed";
}
