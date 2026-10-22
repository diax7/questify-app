import { toInstant } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, bilingual, changes, NO_TEXT } from "#src/quests/builder";
import { lockBuilderEvent, type Bilingual, type BuilderEvent } from "#src/quests/store";

/** At most this many rewards per event (removed ones not counted). */
export const REWARD_LIMIT = 100;

type Text = Readonly<{ ar?: string | undefined; en?: string | undefined }>;

export const REWARD_KINDS = ["item", "experience"] as const;
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

export type ShopSettings = Readonly<{
  pickupMinutes: number;
  daysAfter: number;
  rules: Bilingual;
}>;

export type ShopInput = Readonly<{
  pickupMinutes?: number | undefined;
  daysAfter?: number | undefined;
  rules?: Text | undefined;
}>;

export type RewardField = "name" | "opensAt" | "closesAt" | "kind";

export type RewardDone<T> =
  | Readonly<{ kind: "done"; value: T }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_archived" }>
  | Readonly<{ kind: "invalid"; field: RewardField }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "stock_below_reserved"; unitsOut: number }>;

export type RewardDeps = Readonly<{ pool: Pool }>;

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
};

const shopOf = (row: ShopRow): ShopSettings => ({
  pickupMinutes: row.pickup_minutes,
  daysAfter: row.shop_days_after,
  rules: { ar: row.shop_rules_ar, en: row.shop_rules_en },
});

async function readShop(client: PoolClient, eventId: string): Promise<ShopSettings> {
  const { rows } = await client.query<ShopRow>(
    "SELECT pickup_minutes, shop_days_after, shop_rules_ar, shop_rules_en FROM event WHERE id = $1",
    [eventId],
  );
  return shopOf(rows[0] as ShopRow);
}

/** The event's shop settings and its active rewards, in order, for the dashboard. */
export function listRewards(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
): Promise<RewardDone<Readonly<{ shop: ShopSettings; rewards: RewardRecord[] }>>> {
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
        return done({ shop: await readShop(client, eventId), rewards: rows.map(recordOf) });
      },
    ),
  );
}

/** Sets the pickup time, the days the shop stays open after the end, and the shop's rules (ADR-048, ADR-049, FR-515). */
export function updateShop(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
  input: ShopInput,
  caller: Caller,
): Promise<RewardDone<ShopSettings>> {
  return withRewardEvent(deps, actor, eventId, async (client) => {
    const before = await readShop(client, eventId);
    const after: ShopSettings = {
      pickupMinutes: input.pickupMinutes ?? before.pickupMinutes,
      daysAfter: input.daysAfter ?? before.daysAfter,
      rules: bilingual(input.rules, before.rules),
    };
    await client.query(
      `UPDATE event SET pickup_minutes = $2, shop_days_after = $3, shop_rules_ar = $4, shop_rules_en = $5
       WHERE id = $1`,
      [eventId, after.pickupMinutes, after.daysAfter, after.rules.ar, after.rules.en],
    );
    const diff = changes(before, after);
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "event.shop.update",
        eventId,
        target: { type: "event", id: eventId },
        ...diff,
      });
    }
    return done(after);
  });
}
