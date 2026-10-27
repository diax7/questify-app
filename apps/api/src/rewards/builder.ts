import { toInstant, type ShopState } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, bilingual, changes, NO_TEXT } from "#src/quests/builder";
import { lockBuilderEvent, type Bilingual, type BuilderEvent } from "#src/quests/store";
import { markCode, normalizeCode, sealCode, type RewardCodeKey } from "#src/rewards/codes";
import { windowRefusal, windowRefusalOf, type WindowRefusal } from "#src/rewards/shop-window";

/** At most this many rewards per event (removed ones not counted). */
export const REWARD_LIMIT = 100;

type Text = Readonly<{ ar?: string | undefined; en?: string | undefined }>;

export const REWARD_KINDS = ["item", "experience", "digital"] as const;
export const SECTIONS = ["featured", "merch", "food", "experiences"] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];
export type Section = (typeof SECTIONS)[number];

export type RewardInput = Readonly<{
  name?: Text | undefined;
  description?: Text | undefined;
  price?: number | undefined;
  stock?: number | undefined;
  perPlayerLimit?: number | null | undefined;
  opensAt?: string | null | undefined;
  closesAt?: string | null | undefined;
  section?: Section | null | undefined;
  tags?: Readonly<{ new?: boolean | undefined; limited?: boolean | undefined }> | undefined;
}>;

export type RewardRecord = Readonly<{
  id: string;
  kind: RewardKind;
  name: Bilingual;
  description: Bilingual;
  price: number;
  stock: number;
  unitsOut: number;
  perPlayerLimit: number | null;
  opensAt: Date | null;
  closesAt: Date | null;
  section: Section | null;
  tags: Readonly<{ new: boolean; limited: boolean }>;
  position: number;
}>;

/** How the player confirms a handover in their own app (ADR-137, ADR-150). */
export const HANDOVER_CONFIRM = ["collect_first", "desk_offer"] as const;
export type HandoverConfirm = (typeof HANDOVER_CONFIRM)[number];

/** At most this many opening windows for the desk (ADR-150). */
export const DESK_WINDOWS = 14;

export type DeskPin = Readonly<{ lat: number; lng: number }>;
/** One opening window, as instants. */
export type DeskWindow = Readonly<{ opensAt: string; closesAt: string }>;

/** The event's one prize desk (FR-1716): its place, an optional pin, and its hours (null: open the whole time). */
export type DeskSettings = Readonly<{
  location: Bilingual;
  pin: DeskPin | null;
  hours: readonly DeskWindow[] | null;
}>;

export type DeskInput = Readonly<{
  location?: Text | undefined;
  pin?: DeskPin | null | undefined;
  /** Times in the event's zone; null or empty turns the hours off. */
  hours?: ReadonlyArray<Readonly<{ opensAt: string; closesAt: string }>> | null | undefined;
}>;

export type ShopSettings = Readonly<{
  pickupMinutes: number;
  daysAfter: number;
  rules: Bilingual;
  /** Purchases also lower the ranking score while the event is live (FR-1847, ADR-134, ADR-135). */
  spendLowersRank: boolean;
  desk: DeskSettings;
  handoverConfirm: HandoverConfirm;
}>;

/**
 * The shop's window as the dashboard reads it (T-410, ADR-338): the state `shop_state` gives now and when it closes
 * (`ends_at` + the days after; null while the event has no end).
 */
export type ShopWindowView = Readonly<{ state: ShopState; closesAt: string | null }>;

/** The shop settings with the window they make. */
export type ShopView = ShopSettings & ShopWindowView;

export type ShopInput = Readonly<{
  pickupMinutes?: number | undefined;
  daysAfter?: number | undefined;
  rules?: Text | undefined;
  spendLowersRank?: boolean | undefined;
  desk?: DeskInput | undefined;
  handoverConfirm?: HandoverConfirm | undefined;
}>;

export type RewardField =
  | "name"
  | "opensAt"
  | "closesAt"
  | "kind"
  | "stock"
  | "codes"
  | "deskHours";

/** At most this many codes in one upload (FR-510). */
export const CODES_PER_UPLOAD = 5000;

export type RewardDone<T> =
  | Readonly<{ kind: "done"; value: T }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_archived" }>
  | Readonly<{ kind: "invalid"; field: RewardField }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "stock_below_reserved"; unitsOut: number }>
  | Readonly<{ kind: "stock_from_codes" }>
  | Readonly<{ kind: "not_digital" }>
  | Readonly<{ kind: "too_many_codes"; room: number }>
  | Readonly<{ kind: "owner_only" }>
  | Readonly<{ kind: "setting_locked" }>
  | Readonly<{ kind: "desk_needed" }>
  /** The days after the end cannot change this way (ADR-336): the shop has closed, or the window would shrink. */
  | Readonly<{ kind: "shop_window_locked"; reason: WindowRefusal }>;

export type RewardDeps = Readonly<{ pool: Pool; codeKey: RewardCodeKey }>;

export type CodesAdded = Readonly<{
  added: number;
  duplicates: number;
  stock: number;
  stockLeft: number;
}>;

const done = <T>(value: T): RewardDone<T> => ({ kind: "done", value });

type RewardRow = {
  id: string;
  kind: RewardKind;
  name_ar: string | null;
  name_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  price: number;
  stock_total: number;
  units_out: number;
  per_player_limit: number | null;
  opens_at: Date | null;
  closes_at: Date | null;
  section: Section | null;
  tag_new: boolean;
  tag_limited: boolean;
  position: number;
};

const COLUMNS = `id, kind, name_ar, name_en, description_ar, description_en, price, stock_total, units_out,
  per_player_limit, opens_at, closes_at, section, tag_new, tag_limited, position`;

const recordOf = (row: RewardRow): RewardRecord => ({
  id: row.id,
  kind: row.kind,
  name: { ar: row.name_ar, en: row.name_en },
  description: { ar: row.description_ar, en: row.description_en },
  price: row.price,
  stock: row.stock_total,
  unitsOut: row.units_out,
  perPlayerLimit: row.per_player_limit,
  opensAt: row.opens_at,
  closesAt: row.closes_at,
  section: row.section,
  tags: { new: row.tag_new, limited: row.tag_limited },
  position: row.position,
});

/** What the audit log keeps of a reward: its settings, never who reserved it. */
const auditView = (reward: RewardRecord): Record<string, unknown> => ({
  kind: reward.kind,
  name: reward.name,
  description: reward.description,
  price: reward.price,
  stock: reward.stock,
  perPlayerLimit: reward.perPlayerLimit,
  opensAt: reward.opensAt?.toISOString() ?? null,
  closesAt: reward.closesAt?.toISOString() ?? null,
  section: reward.section,
  tags: reward.tags,
});

/** A time in the event's zone: undefined keeps the current one, null clears it, text that is not a time is refused. */
function timeOf(
  input: string | null | undefined,
  current: Date | null,
  timeZone: string,
): Date | null | "invalid" {
  if (input === undefined || input === null) {
    return input === null ? null : current;
  }
  try {
    return toInstant(input, timeZone);
  } catch {
    return "invalid";
  }
}

type Fields = Omit<RewardRecord, "id" | "kind" | "unitsOut" | "position">;

/** The reward's fields after this input, from what is stored (or nothing, for a new reward), checked as one whole. */
export function mergeReward(
  current: RewardRecord | undefined,
  input: RewardInput,
  timeZone: string,
): Fields | Readonly<{ kind: "invalid"; field: RewardField }> {
  const name = bilingual(input.name, current?.name ?? NO_TEXT);
  if (name.ar === null && name.en === null) {
    return { kind: "invalid", field: "name" };
  }
  const opensAt = timeOf(input.opensAt, current?.opensAt ?? null, timeZone);
  const closesAt = timeOf(input.closesAt, current?.closesAt ?? null, timeZone);
  if (opensAt === "invalid") {
    return { kind: "invalid", field: "opensAt" };
  }
  if (closesAt === "invalid" || (opensAt !== null && closesAt !== null && closesAt <= opensAt)) {
    return { kind: "invalid", field: "closesAt" };
  }
  return {
    name,
    description: bilingual(input.description, current?.description ?? NO_TEXT),
    // The route requires price and stock for a new reward; the zeros below are never stored.
    price: input.price ?? current?.price ?? 0,
    stock: input.stock ?? current?.stock ?? 0,
    perPlayerLimit:
      input.perPlayerLimit === undefined ? (current?.perPlayerLimit ?? null) : input.perPlayerLimit,
    opensAt,
    closesAt,
    section: input.section === undefined ? (current?.section ?? null) : input.section,
    tags: {
      new: input.tags?.new ?? current?.tags.new ?? false,
      limited: input.tags?.limited ?? current?.tags.limited ?? false,
    },
  };
}

const isInvalid = (
  fields: Fields | Readonly<{ kind: "invalid"; field: RewardField }>,
): fields is Readonly<{ kind: "invalid"; field: RewardField }> => "kind" in fields;

type Work<T> = (client: PoolClient, event: BuilderEvent) => Promise<RewardDone<T>>;

/**
 * One reward action on the path's event, locked: not found outside the caller's reach, refused once archived. Unlike
 * quests, an ended event's rewards still change: its shop stays open for days after the end (ADR-048) and the
 * organizer may add stock.
 */
function withRewardEvent<T>(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
  work: Work<T>,
): Promise<RewardDone<T>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const event = await lockBuilderEvent(client, actor.organizerId, eventId);
        if (event === undefined) {
          return { kind: "not_found" } as const;
        }
        if (event.statusNow === "archived") {
          return { kind: "event_archived" } as const;
        }
        return work(client, event);
      },
    ),
  );
}

async function readReward(
  client: PoolClient,
  eventId: string,
  id: string,
): Promise<RewardRecord | undefined> {
  const { rows } = await client.query<RewardRow>(
    `SELECT ${COLUMNS} FROM reward WHERE event_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
    [eventId, id],
  );
  return rows[0] === undefined ? undefined : recordOf(rows[0]);
}

const values = (fields: Fields) => [
  fields.name.ar,
  fields.name.en,
  fields.description.ar,
  fields.description.en,
  fields.price,
  fields.stock,
  fields.perPlayerLimit,
  fields.opensAt,
  fields.closesAt,
  fields.section,
  fields.tags.new,
  fields.tags.limited,
];

/** Adds a reward to the event's shop, at the end (FR-504, FR-505). */
export function createReward(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
  input: RewardInput & Readonly<{ kind: RewardKind }>,
  caller: Caller,
): Promise<RewardDone<RewardRecord>> {
  return withRewardEvent(deps, actor, eventId, async (client, event) => {
    const digital = input.kind === "digital";
    if (digital ? input.stock !== undefined && input.stock !== 0 : input.stock === undefined) {
      return digital ? { kind: "stock_from_codes" } : { kind: "invalid", field: "stock" };
    }
    const fields = mergeReward(undefined, input, event.timezone);
    if (isInvalid(fields)) {
      return fields;
    }
    const { rows: counted } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reward WHERE event_id = $1 AND status = 'active'",
      [eventId],
    );
    const count = counted[0]?.n ?? 0;
    if (count >= REWARD_LIMIT) {
      return { kind: "limit_reached", limit: REWARD_LIMIT };
    }
    // FR-1716; the database's guard backs this against a desk cleared at the same moment.
    if (input.kind === "item" && !(await hasDeskPlace(client, eventId))) {
      return { kind: "desk_needed" };
    }
    const { rows } = await client.query<RewardRow>(
      `INSERT INTO reward (event_id, kind, name_ar, name_en, description_ar, description_en, price, stock_total,
                           per_player_limit, opens_at, closes_at, section, tag_new, tag_limited, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING ${COLUMNS}`,
      [eventId, input.kind, ...values(fields), count],
    );
    const made = recordOf(rows[0] as RewardRow);
    await audit(client, actor, caller, {
      action: "reward.create",
      eventId,
      target: { type: "reward", id: made.id },
      after: auditView(made),
    });
    return done(made);
  });
}

/** Changes a reward (FR-504): raising the stock of a sold-out reward puts it back in the shop at once. */
export function updateReward(
  deps: RewardDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  input: RewardInput,
  caller: Caller,
): Promise<RewardDone<RewardRecord>> {
  return withRewardEvent(deps, actor, target.eventId, async (client, event) => {
    const current = await readReward(client, target.eventId, target.id);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    if (current.kind === "digital" && input.stock !== undefined && input.stock !== current.stock) {
      return { kind: "stock_from_codes" };
    }
    const fields = mergeReward(current, input, event.timezone);
    if (isInvalid(fields)) {
      return fields;
    }
    // The reward is locked, so no reservation can move the units out before this write (the CHECK backs it).
    if (fields.stock < current.unitsOut) {
      return { kind: "stock_below_reserved", unitsOut: current.unitsOut };
    }
    const { rows } = await client.query<RewardRow>(
      `UPDATE reward SET name_ar = $3, name_en = $4, description_ar = $5, description_en = $6, price = $7,
              stock_total = $8, per_player_limit = $9, opens_at = $10, closes_at = $11, section = $12, tag_new = $13,
              tag_limited = $14
       WHERE event_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [target.eventId, target.id, ...values(fields)],
    );
    const after = recordOf(rows[0] as RewardRow);
    const diff = changes(auditView(current), auditView(after));
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "reward.update",
        eventId: target.eventId,
        target: { type: "reward", id: target.id },
        ...diff,
      });
    }
    return done(after);
  });
}

/** Takes a reward out of the shop (FR-504). Its reservations stay collectible until their own deadline. */
export function removeReward(
  deps: RewardDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  caller: Caller,
): Promise<RewardDone<null>> {
  return withRewardEvent(deps, actor, target.eventId, async (client) => {
    const current = await readReward(client, target.eventId, target.id);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    await client.query("UPDATE reward SET status = 'removed' WHERE id = $1", [target.id]);
    await audit(client, actor, caller, {
      action: "reward.remove",
      eventId: target.eventId,
      target: { type: "reward", id: target.id },
      before: auditView(current),
    });
    return done(null);
  });
}

type ShopRow = {
  pickup_minutes: number;
  shop_days_after: number;
  shop_rules_ar: string | null;
  shop_rules_en: string | null;
  spend_lowers_rank: boolean;
  desk_location_ar: string | null;
  desk_location_en: string | null;
  desk_lat: string | null;
  desk_lng: string | null;
  desk_opens: Date[] | null;
  desk_closes: Date[] | null;
  handover_confirm: HandoverConfirm;
  state: ShopState;
  closes_at: Date | null;
};

/** The desk's windows from the two sorted arrays the database answers, or null when the hours are off. */
export function windowsOf(
  opens: readonly Date[] | null,
  closes: readonly Date[] | null,
): DeskWindow[] | null {
  if (opens === null || closes === null) {
    return null;
  }
  return opens.map((opensAt, index) => ({
    opensAt: opensAt.toISOString(),
    closesAt: (closes[index] as Date).toISOString(),
  }));
}

/** The pin from the database's two numeric columns (both or neither). */
export const pinOf = (lat: string | null, lng: string | null): DeskPin | null =>
  lat === null || lng === null ? null : { lat: Number(lat), lng: Number(lng) };

const shopOf = (row: ShopRow): ShopSettings => ({
  pickupMinutes: row.pickup_minutes,
  daysAfter: row.shop_days_after,
  rules: { ar: row.shop_rules_ar, en: row.shop_rules_en },
  spendLowersRank: row.spend_lowers_rank,
  desk: {
    location: { ar: row.desk_location_ar, en: row.desk_location_en },
    pin: pinOf(row.desk_lat, row.desk_lng),
    hours: windowsOf(row.desk_opens, row.desk_closes),
  },
  handoverConfirm: row.handover_confirm,
});

type ShopRead = Readonly<{ settings: ShopSettings; window: ShopWindowView }>;

/** The settings and the window, both on the database's clock (`now()`, this transaction's start). */
async function readShop(client: PoolClient, eventId: string): Promise<ShopRead> {
  const { rows } = await client.query<ShopRow>(
    `SELECT pickup_minutes, shop_days_after, shop_rules_ar, shop_rules_en, spend_lowers_rank, desk_location_ar,
            desk_location_en, desk_lat, desk_lng, handover_confirm,
            (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(desk_hours) w) AS desk_opens,
            (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(desk_hours) w) AS desk_closes,
            shop_state(status, starts_at, ends_at, shop_days_after) AS state,
            ends_at + make_interval(days => shop_days_after) AS closes_at
     FROM event WHERE id = $1`,
    [eventId],
  );
  const row = rows[0] as ShopRow;
  return {
    settings: shopOf(row),
    window: { state: row.state, closesAt: row.closes_at?.toISOString() ?? null },
  };
}

const viewOf = (read: ShopRead): ShopView => ({ ...read.settings, ...read.window });

const hasPlace = (desk: DeskSettings): boolean =>
  desk.location.ar !== null || desk.location.en !== null;

async function hasDeskPlace(client: PoolClient, eventId: string): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT 1 FROM event WHERE id = $1 AND (desk_location_ar IS NOT NULL OR desk_location_en IS NOT NULL)",
    [eventId],
  );
  return rows.length > 0;
}

async function hasActiveItems(client: PoolClient, eventId: string): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT 1 FROM reward WHERE event_id = $1 AND kind = 'item' AND status = 'active' LIMIT 1",
    [eventId],
  );
  return rows.length > 0;
}

/**
 * The desk after this input (ADR-150): undefined keeps a part, null or no windows turns the hours off. Windows are
 * times in the event's zone and must be sorted, each closing after it opens and none overlapping the next.
 */
export function mergeDesk(
  current: DeskSettings,
  input: DeskInput | undefined,
  timeZone: string,
): DeskSettings | "invalid_hours" {
  if (input === undefined) {
    return current;
  }
  const hours = input.hours === undefined ? current.hours : windowsIn(input.hours, timeZone);
  if (hours === "invalid_hours") {
    return hours;
  }
  return {
    location: bilingual(input.location, current.location),
    pin: input.pin === undefined ? current.pin : input.pin,
    hours,
  };
}

function windowsIn(
  input: ReadonlyArray<Readonly<{ opensAt: string; closesAt: string }>> | null,
  timeZone: string,
): DeskWindow[] | null | "invalid_hours" {
  if (input === null || input.length === 0) {
    return null;
  }
  const windows: DeskWindow[] = [];
  let previousCloses: Date | undefined;
  for (const window of input) {
    const opens = timeOf(window.opensAt, null, timeZone);
    const closes = timeOf(window.closesAt, null, timeZone);
    if (!(opens instanceof Date) || !(closes instanceof Date) || closes <= opens) {
      return "invalid_hours";
    }
    if (previousCloses !== undefined && opens < previousCloses) {
      return "invalid_hours";
    }
    previousCloses = closes;
    windows.push({ opensAt: opens.toISOString(), closesAt: closes.toISOString() });
  }
  return windows;
}

/** The event's shop settings and its active rewards, in order, for the dashboard. */
export function listRewards(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
): Promise<RewardDone<Readonly<{ shop: ShopView; rewards: RewardRecord[] }>>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const { rows: found } = await client.query(
          "SELECT 1 FROM event WHERE organizer_id = $1 AND id = $2",
          [actor.organizerId, eventId],
        );
        if (found.length === 0) {
          return { kind: "not_found" } as const;
        }
        const { rows } = await client.query<RewardRow>(
          `SELECT ${COLUMNS} FROM reward WHERE event_id = $1 AND status = 'active' ORDER BY position, id`,
          [eventId],
        );
        return done({ shop: viewOf(await readShop(client, eventId)), rewards: rows.map(recordOf) });
      },
    ),
  );
}

/** The desk's pin and hours as the UPDATE takes them: the pin's numbers, then the windows' arrays; null when off. */
function deskColumns(
  desk: DeskSettings,
): [number | null, number | null, string[] | null, string[] | null] {
  const { pin, hours } = desk;
  return [
    pin === null ? null : pin.lat,
    pin === null ? null : pin.lng,
    hours === null ? null : hours.map((window) => window.opensAt),
    hours === null ? null : hours.map((window) => window.closesAt),
  ];
}

/**
 * Writes the settings. The window guard's refusal (SW409, judged on the database's own clock, so it wins at the
 * boundary) comes back as its reason with the write undone; anything else is thrown.
 */
async function writeShop(
  client: PoolClient,
  eventId: string,
  after: ShopSettings,
): Promise<WindowRefusal | undefined> {
  const { desk } = after;
  await client.query("SAVEPOINT shop_window");
  try {
    await client.query(
      `UPDATE event SET pickup_minutes = $2, shop_days_after = $3, shop_rules_ar = $4, shop_rules_en = $5,
              spend_lowers_rank = $6, desk_location_ar = $7, desk_location_en = $8, handover_confirm = $9,
              desk_lat = $10, desk_lng = $11,
              desk_hours = (SELECT range_agg(tstzrange(w.o, w.c))
                            FROM unnest($12::timestamptz[], $13::timestamptz[]) AS w(o, c))
       WHERE id = $1`,
      [
        eventId,
        after.pickupMinutes,
        after.daysAfter,
        after.rules.ar,
        after.rules.en,
        after.spendLowersRank,
        desk.location.ar,
        desk.location.en,
        after.handoverConfirm,
        ...deskColumns(desk),
      ],
    );
  } catch (error) {
    const refusal = windowRefusalOf(error);
    if (refusal === undefined) {
      throw error;
    }
    await client.query("ROLLBACK TO SAVEPOINT shop_window");
    return refusal;
  }
  await client.query("RELEASE SAVEPOINT shop_window");
  return undefined;
}

/**
 * Sets the pickup time, the days the shop stays open after the end, the shop's rules (ADR-048, ADR-049, FR-515) and
 * whether spending lowers the ranking (FR-1847): that one is the owner's, and only before the event is live. Sending
 * a current value is no change, so an editor saves the rest freely. After the end the days only grow, and once the
 * shop has closed they are frozen (ADR-336: `windowRefusal` on the database's clock, then the guard on its own).
 */
export function updateShop(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
  input: ShopInput,
  caller: Caller,
): Promise<RewardDone<ShopView>> {
  return withRewardEvent(deps, actor, eventId, async (client, event) => {
    const { settings: before, window } = await readShop(client, eventId);
    const desk = mergeDesk(before.desk, input.desk, event.timezone);
    if (desk === "invalid_hours") {
      return { kind: "invalid", field: "deskHours" };
    }
    const after: ShopSettings = {
      pickupMinutes: input.pickupMinutes ?? before.pickupMinutes,
      daysAfter: input.daysAfter ?? before.daysAfter,
      rules: bilingual(input.rules, before.rules),
      spendLowersRank: input.spendLowersRank ?? before.spendLowersRank,
      desk,
      handoverConfirm: input.handoverConfirm ?? before.handoverConfirm,
    };
    // FR-1716: only the move from a place to none is refused, so an older event without a desk still saves.
    if (hasPlace(before.desk) && !hasPlace(desk) && (await hasActiveItems(client, eventId))) {
      return { kind: "desk_needed" };
    }
    if (after.spendLowersRank !== before.spendLowersRank) {
      if (actor.organizer.role !== "owner") {
        return { kind: "owner_only" };
      }
      if (event.statusNow !== "draft" && event.statusNow !== "scheduled") {
        return { kind: "setting_locked" };
      }
    }
    const refused =
      windowRefusal({
        state: window.state,
        statusNow: event.statusNow,
        current: before.daysAfter,
        wanted: after.daysAfter,
      }) ?? (await writeShop(client, eventId, after));
    if (refused !== undefined) {
      return { kind: "shop_window_locked", reason: refused };
    }
    const diff = changes(before, after);
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "event.shop.update",
        eventId,
        target: { type: "event", id: eventId },
        ...diff,
      });
    }
    return done(viewOf(await readShop(client, eventId)));
  });
}

/**
 * Codes left at or below which a digital reward warns its organizer (FR-512): 10% of those uploaded, and never fewer
 * than 5. A new reward with no codes warns at once.
 */
export function codesRunLow(reward: Pick<RewardRecord, "kind" | "stock" | "unitsOut">): boolean {
  if (reward.kind !== "digital") {
    return false;
  }
  return reward.stock - reward.unitsOut <= Math.max(5, Math.ceil(reward.stock / 10));
}

/** The upload's codes, normalized and without repeats; undefined when any one is not a valid code. */
export function cleanCodes(raw: readonly string[]): string[] | undefined {
  const codes = new Set<string>();
  for (const line of raw) {
    const code = normalizeCode(line);
    if (code === undefined) {
      return undefined;
    }
    codes.add(code);
  }
  return [...codes];
}

type CodesRow = { added: number; duplicates: number; stock_total: number; stock_left: number };

const DIGITAL_REFUSALS: Readonly<Record<string, (detail: string) => RewardDone<never>>> = {
  // Stryker disable next-line ObjectLiteral,StringLiteral: unreachable in a test: the reward is locked as active just before the definer reads it
  RN404: () => ({ kind: "not_found" }),
  RD409: () => ({ kind: "not_digital" }),
  RC422: (detail) => ({ kind: "too_many_codes", room: Number(detail) }),
};

/**
 * Adds uploaded codes to a digital reward (FR-510): each is sealed and marked here, so the database never holds a code
 * it could read. A code already in the event, or repeated in the upload, is a duplicate; the stock rises by the codes
 * added. The audit keeps the counts, never a code.
 */
export function addRewardCodes(
  deps: RewardDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  raw: readonly string[],
  caller: Caller,
): Promise<RewardDone<CodesAdded>> {
  const codes = cleanCodes(raw);
  // Stryker disable next-line ConditionalExpression: equivalent: the route takes at least one line, and a line that cleans to nothing is refused as undefined
  if (codes === undefined || codes.length === 0) {
    return Promise.resolve({ kind: "invalid", field: "codes" });
  }
  return withRewardEvent(deps, actor, target.eventId, async (client) => {
    const current = await readReward(client, target.eventId, target.id);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    // The kind, a removal since the read and the 100 000 ceiling are the definer's to refuse (RD409, RN404, RC422).
    const sealed = codes.map((code) => sealCode(deps.codeKey, target.id, code));
    const marks = codes.map((code) => markCode(deps.codeKey, code));
    await client.query("SAVEPOINT add_codes");
    let row: CodesRow;
    try {
      const { rows } = await client.query<CodesRow>("SELECT * FROM add_reward_codes($1, $2, $3)", [
        target.id,
        sealed,
        marks,
      ]);
      row = rows[0] as CodesRow;
    } catch (error) {
      const pg = error as { code?: string; detail?: string };
      const refusal = pg.code === undefined ? undefined : DIGITAL_REFUSALS[pg.code];
      if (refusal === undefined) {
        throw error;
      }
      await client.query("ROLLBACK TO SAVEPOINT add_codes");
      return refusal(pg.detail ?? "");
    }
    const value: CodesAdded = {
      added: row.added,
      duplicates: row.duplicates + (raw.length - codes.length),
      stock: row.stock_total,
      stockLeft: row.stock_left,
    };
    await audit(client, actor, caller, {
      action: "reward.codes.add",
      eventId: target.eventId,
      target: { type: "reward", id: target.id },
      after: { added: value.added, duplicates: value.duplicates, stock: value.stock },
    });
    return done(value);
  });
}
