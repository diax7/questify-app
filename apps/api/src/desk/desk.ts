import type { Pool, PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { DESK_FIND_LIMIT } from "#src/auth/limits";
import type { Caller } from "#src/auth/sign-in";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Bilingual } from "#src/quests/store";
import { verifyMyCode, type MyCodeKey } from "#src/quests/qr";
import { pinOf, windowsOf, type DeskPin, type DeskWindow } from "#src/rewards/builder";

export type DeskDeps = Readonly<{ pool: Pool; myKey: MyCodeKey; keys: AuthKeys }>;

/** What the desk is told about a player it may not serve now: never why (a flag and a ban read the same). */
export type DeskHold = "held" | "paused";

/** Why a desk or player call was refused; each maps to one HTTP answer in the routes. */
export type DeskRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "ability_off" }>
  | Readonly<{ kind: "reservation_ended"; status: string }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "self_handover" }>
  | Readonly<{ kind: "handover_mode" }>
  | Readonly<{ kind: "desk_closed" }>
  | Readonly<{ kind: "offer_gone" }>
  | Readonly<{ kind: "not_ready" }>
  | Readonly<{ kind: "old_code" }>
  | Readonly<{ kind: "not_in_event" }>
  | Readonly<{ kind: "held"; hold: DeskHold }>
  | Readonly<{ kind: "redeem_paused" }>;

export type DeskDone<T> = Readonly<{ kind: "done"; value: T }> | DeskRefusal;

/** The SQLSTATEs of the desk's definers (migration 0029). */
const REFUSALS: Readonly<Record<string, (detail: string) => DeskRefusal>> = {
  RN404: () => ({ kind: "not_found" }),
  OP403: () => ({ kind: "not_operator" }),
  OA403: () => ({ kind: "ability_off" }),
  RE409: (detail) => ({ kind: "reservation_ended", status: detail }),
  RA403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  OY409: () => ({ kind: "self_handover" }),
  RM409: () => ({ kind: "handover_mode" }),
  RS403: () => ({ kind: "desk_closed" }),
  RO410: () => ({ kind: "offer_gone" }),
  RC409: () => ({ kind: "not_ready" }),
  OM422: () => ({ kind: "old_code" }),
  QC404: () => ({ kind: "not_in_event" }),
  RH409: (detail) => ({ kind: "held", hold: detail === "paused" ? "paused" : "held" }),
  RP403: () => ({ kind: "redeem_paused" }),
};

/** Runs one call as `playerId`; a refusal the database raises becomes its result, anything else is thrown. */
async function as<T>(
  deps: DeskDeps,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<DeskDone<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId }, () => work(client)),
    );
    return { kind: "done", value };
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

export type DeskView = Readonly<{
  location: Bilingual | null;
  pin: DeskPin | null;
  hours: readonly DeskWindow[] | null;
  state: "open" | "closed" | "finished";
  confirm: "collect_first" | "desk_offer";
  /** The event's zone, to show the hours in. */
  timeZone: string;
}>;

/** The desk as the database answers it for an operator or a player (FR-1716). */
export function deskViewOf(row: Readonly<Record<string, unknown>>): DeskView {
  const place = text(row["desk_location_ar"], row["desk_location_en"]);
  return {
    location: place.ar === null && place.en === null ? null : place,
    pin: pinOf(
      (row["desk_lat"] ?? null) as string | null,
      (row["desk_lng"] ?? null) as string | null,
    ),
    hours: windowsOf(
      (row["desk_opens"] ?? null) as Date[] | null,
      (row["desk_closes"] ?? null) as Date[] | null,
    ),
    state: row["desk_state"] as DeskView["state"],
    confirm: row["handover_confirm"] as DeskView["confirm"],
    timeZone: String(row["timezone"]),
  };
}

/** The desk's header before any scan. */
export function operatorDesk(
  deps: DeskDeps,
  operatorId: string,
  eventId: string,
): Promise<DeskDone<DeskView>> {
  return as(deps, operatorId, async (client) => {
    const { rows } = await client.query("SELECT * FROM operator_desk($1)", [eventId]);
    return deskViewOf(rows[0] as Record<string, unknown>);
  });
}

export type DeskItem = Readonly<{
  id: string;
  kind: "item" | "experience";
  name: Bilingual;
  reservedAt: string | null;
  reservedUntil: string | null;
  /** The player tapped Collect (collect_first) and it is still live. */
  ready: boolean;
  /** This desk's own offer is live (desk_offer). */
  offered: boolean;
  offerUntil: string | null;
  /** The winner's place for a rank prize (T-214); null for a shop item. */
  rank: number | null;
  /** Where it comes from: the shop, a rank prize or a quest's reward (T-304d). */
  source: RedemptionSource;
}>;

/** Where a desk item comes from (migration 0047's redemption_source). */
export type RedemptionSource = "shop" | "rank" | "quest";

export const sourceOf = (value: unknown): RedemptionSource =>
  value === "rank" || value === "quest" ? value : "shop";

export type Found = Readonly<{
  kind: "found";
  player: Readonly<{ username: string; avatar: string }>;
  /** False for a player who left or was removed; true for a banned one, who reads as held. */
  active: boolean;
  /** Why nothing can be handed over now (FR-1604, FR-1747, FR-1815), or null. */
  hold: DeskHold | null;
  items: readonly DeskItem[];
}>;

export type Lookup = Found | Readonly<{ kind: "invalid_code" }>;

/** The player and their waiting items, as desk_lookup and desk_find answer them (one row even when none wait). */
export function foundOf(rows: readonly Readonly<Record<string, unknown>>[]): Found {
  const first = rows[0] ?? {};
  const hold = first["hold"];
  return {
    kind: "found",
    player: { username: String(first["username"]), avatar: String(first["avatar"]) },
    active: first["active"] === true,
    hold: hold === "held" || hold === "paused" ? hold : null,
    items: rows
      .filter((row) => row["redemption_id"] !== null)
      .map((row) => ({
        id: String(row["redemption_id"]),
        kind: row["kind"] as DeskItem["kind"],
        name: text(row["name_ar"], row["name_en"]),
        reservedAt: iso(row["reserved_at"]),
        reservedUntil: iso(row["reserved_until"]),
        ready: row["ready"] === true,
        offered: row["offered"] === true,
        offerUntil: iso(row["offer_until"]),
        rank: typeof row["rank"] === "number" ? row["rank"] : null,
        source: sourceOf(row["source"]),
      })),
  };
}

/**
 * The desk scans My QR (FR-925): the API opens the code, the database checks the operator and the code's version and
 * answers the player's reserved desk items. The price is not sent: the desk hands over, it never sells. Reads only;
 * nothing on the desk pays points (FR-926).
 */
export async function lookUp(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; eventId: string; code: string }>,
  caller: Caller,
): Promise<DeskDone<Lookup>> {
  const opened = verifyMyCode(deps.myKey, request.code);
  if (opened.kind !== "valid") {
    caller.log("desk.lookup_refused", { reason: "invalid_code", problem: opened.kind });
    return { kind: "done", value: { kind: "invalid_code" } };
  }
  return as(deps, request.operatorId, async (client) => {
    const { rows } = await client.query("SELECT * FROM desk_lookup($1, $2, $3)", [
      request.eventId,
      opened.playerId,
      opened.version,
    ]);
    return foundOf(rows);
  });
}

export type Throttled = Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

/**
 * The desk finds a member by exact username or exact Saudi mobile when My QR will not scan (FR-1848, ADR-156). Each
 * find can read a phone number's owner, so an operator has 30 in 10 minutes. Null when nobody matches. The username
 * and phone never reach a log line.
 */
export async function findAtDesk(
  deps: DeskDeps,
  request: Readonly<{
    operatorId: string;
    eventId: string;
    username: string | null;
    phone: string | null;
  }>,
): Promise<DeskDone<Found | null> | Throttled> {
  const key = deps.keys.playerKey(request.operatorId);
  const window = await withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, async () => {
      const recent = await countRecent(
        client,
        BUCKETS.deskFind,
        key,
        DESK_FIND_LIMIT.windowSeconds,
      );
      if (recent.count < DESK_FIND_LIMIT.max) {
        await record(client, BUCKETS.deskFind, key);
      }
      return recent;
    }),
  );
  if (window.count >= DESK_FIND_LIMIT.max) {
    return { kind: "throttled", retryAfterSeconds: window.retryAfterSeconds };
  }
  return as(deps, request.operatorId, async (client) => {
    const { rows } = await client.query("SELECT * FROM desk_find($1, $2, $3)", [
      request.eventId,
      request.username,
      request.phone,
    ]);
    return rows.length === 0 ? null : foundOf(rows);
  });
}

export type HandOver = Readonly<{
  status: "handed_over" | "offered";
  offerUntil: string | null;
  replayed: boolean;
}>;

/** Handed over (collect_first: final) or Hand over (desk_offer: an offer the player accepts) (FR-507, FR-509). */
export async function handOver(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; redemptionId: string }>,
  caller: Caller,
): Promise<DeskDone<HandOver>> {
  const result = await as(deps, request.operatorId, async (client) => {
    const { rows } = await client.query("SELECT * FROM desk_hand_over($1)", [request.redemptionId]);
    const row = rows[0] as Record<string, unknown>;
    return {
      status: row["status"] as HandOver["status"],
      offerUntil: iso(row["offer_until"]),
      replayed: row["replayed"] === true,
    };
  });
  if (result.kind === "done") {
    caller.log("desk.hand_over", {
      redemptionId: request.redemptionId,
      status: result.value.status,
      replayed: String(result.value.replayed),
    });
  }
  return result;
}

export type OfferState = Readonly<{ status: string; offered: boolean; offerUntil: string | null }>;

/** The desk's poll while it waits for the player's accept. */
export function offerState(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; redemptionId: string }>,
): Promise<DeskDone<OfferState>> {
  return as(deps, request.operatorId, async (client) => {
    const { rows } = await client.query("SELECT * FROM desk_redemption($1)", [
      request.redemptionId,
    ]);
    const row = rows[0] as Record<string, unknown>;
    return {
      status: String(row["status"]),
      offered: row["offered"] === true,
      offerUntil: iso(row["offer_until"]),
    };
  });
}

export type Cancelled = Readonly<{ id: string; status: string; replayed: boolean }>;

/** The operator's Cancel (FR-513, FR-1603): the points and the unit return; the player's balance is not shown. */
export async function cancelAtDesk(
  deps: DeskDeps,
  request: Readonly<{ operatorId: string; redemptionId: string }>,
  caller: Caller,
): Promise<DeskDone<Cancelled>> {
  const result = await as(deps, request.operatorId, async (client) => {
    const { rows } = await client.query("SELECT * FROM operator_cancel_redemption($1)", [
      request.redemptionId,
    ]);
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row["redemption_id"]),
      status: String(row["status"]),
      replayed: row["replayed"] === true,
    };
  });
  if (result.kind === "done") {
    caller.log("desk.cancel", {
      redemptionId: request.redemptionId,
      replayed: String(result.value.replayed),
    });
  }
  return result;
}

/** The player's Collect (collect_first): ready at the desk for 5 minutes. */
export function startCollect(
  deps: DeskDeps,
  request: Readonly<{ playerId: string; redemptionId: string }>,
): Promise<DeskDone<Readonly<{ collectUntil: string | null }>>> {
  return as(deps, request.playerId, async (client) => {
    const { rows } = await client.query<{ until: Date }>("SELECT start_collect($1) AS until", [
      request.redemptionId,
    ]);
    return { collectUntil: iso(rows[0]?.until) };
  });
}

/** The player accepts the desk's offer (desk_offer): the handover is final. */
export function acceptHandover(
  deps: DeskDeps,
  request: Readonly<{ playerId: string; redemptionId: string }>,
): Promise<DeskDone<Readonly<{ status: "handed_over"; replayed: boolean }>>> {
  return as(deps, request.playerId, async (client) => {
    const { rows } = await client.query<{ replayed: boolean }>(
      "SELECT replayed FROM accept_handover($1)",
      [request.redemptionId],
    );
    return { status: "handed_over" as const, replayed: rows[0]?.replayed === true };
  });
}

/** Not now: the offer goes, the reservation stays. */
export function declineHandover(
  deps: DeskDeps,
  request: Readonly<{ playerId: string; redemptionId: string }>,
): Promise<DeskDone<Readonly<{ declined: boolean }>>> {
  return as(deps, request.playerId, async (client) => {
    const { rows } = await client.query<{ declined: boolean }>(
      "SELECT decline_handover($1) AS declined",
      [request.redemptionId],
    );
    return { declined: rows[0]?.declined === true };
  });
}

export type MyDeskItem = Readonly<{
  id: string;
  eventId: string;
  event: Bilingual;
  kind: "item" | "experience";
  name: Bilingual;
  state: "collecting" | "offered";
  until: string | null;
  source: RedemptionSource;
}>;

/**
 * What My QR shows: the caller's rewards ready at a desk or offered by one now, and `watch`: whether to keep asking
 * (only while they hold a reserved desk reward in an event that uses desk offers).
 */
export async function myDeskItems(
  deps: DeskDeps,
  playerId: string,
): Promise<Readonly<{ items: readonly MyDeskItem[]; watch: boolean }>> {
  const result = await as(deps, playerId, async (client) => {
    const { rows } = await client.query("SELECT * FROM my_desk_items()");
    const { rows: watched } = await client.query<{ watch: boolean }>(
      "SELECT my_desk_watch() AS watch",
    );
    return {
      items: rows.map((row) => ({
        id: String(row["redemption_id"]),
        eventId: String(row["event_id"]),
        event: text(row["event_name_ar"], row["event_name_en"]),
        kind: row["kind"] as MyDeskItem["kind"],
        name: text(row["name_ar"], row["name_en"]),
        state: row["state"] as MyDeskItem["state"],
        until: iso(row["until"]),
        source: sourceOf(row["source"]),
      })),
      watch: watched[0]?.watch === true,
    };
  });
  // Stryker disable next-line ConditionalExpression: unreachable: these two reads raise nothing
  if (result.kind !== "done") {
    throw new Error(`my_desk_items refused: ${result.kind}`);
  }
  return result.value;
}
