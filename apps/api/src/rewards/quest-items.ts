import type { Pool, PoolClient } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, changes } from "#src/quests/builder";
import { lockBuilderEvent, type Bilingual } from "#src/quests/store";

export type QuestItemDeps = Readonly<{ pool: Pool }>;

/** At most this many active quest items per event. */
export const QUEST_ITEM_LIMIT = 100;
/** The most units one item may hold (migration 0047). */
export const QUEST_ITEM_STOCK_MAX = 100_000;

type Text = Readonly<{ ar?: string | null | undefined; en?: string | null | undefined }>;

export type QuestItemInput = Readonly<{
  name?: Text | undefined;
  description?: Text | undefined;
  stockTotal?: number | undefined;
}>;

type Named = Readonly<{ id: string; name: Bilingual }>;

/** An item as the dashboard sees it: its stock, what is out, who missed it and what gives it (FR-522, FR-1617). */
export type QuestItemRecord = Readonly<{
  id: string;
  name: Bilingual;
  description: Bilingual;
  stockTotal: number;
  unitsOut: number;
  stockLeft: number;
  missed: number;
  quests: readonly Named[];
  categories: readonly Named[];
}>;

/** One player who completed a source while the item was out (FR-1617): the team can make it up to them by hand. */
export type QuestItemMiss = Readonly<{
  username: string | null;
  avatar: string;
  at: string;
  source: "quest" | "category";
  sourceName: Bilingual;
  reason: "out_of_stock" | "claim_closed";
}>;

/** Why a quest item action was refused; each maps to one HTTP answer in the routes. */
export type QuestItemRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_archived" }>
  | Readonly<{ kind: "invalid"; field: "name" }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "desk_needed" }>
  | Readonly<{ kind: "item_in_use" }>
  | Readonly<{ kind: "stock_below_reserved"; unitsOut: number }>;

export type QuestItemDone<T> = Readonly<{ kind: "done"; value: T }> | QuestItemRefusal;

const done = <T>(value: T): QuestItemDone<T> => ({ kind: "done", value });

/** The SQLSTATEs of migration 0047 and the definers it reads through. */
export function refusalOf(code: string | undefined, detail: string): QuestItemRefusal | undefined {
  if (code === "AN404") {
    return { kind: "not_found" };
  }
  if (code === "DL409") {
    return { kind: "desk_needed" };
  }
  return code === "QI409" && detail === "item_in_use" ? { kind: "item_in_use" } : undefined;
}

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
async function asTeam<T>(
  deps: QuestItemDeps,
  actor: Actor,
  work: (client: PoolClient) => Promise<QuestItemDone<T>>,
): Promise<QuestItemDone<T>> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
        () => work(client),
      ),
    );
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = refusalOf(pg.code, pg.detail ?? "");
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

const textOf = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});
const blankToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === "" ? null : value.trim();

/** One text after an edit: undefined keeps a language, blank clears it. */
const pick = (text: Text | undefined, base: Bilingual): Bilingual =>
  text === undefined
    ? base
    : {
        ar: text.ar === undefined ? base.ar : blankToNull(text.ar),
        en: text.en === undefined ? base.en : blankToNull(text.en),
      };

type Row = Readonly<Record<string, unknown>>;

const namedOf = (value: unknown): Named[] =>
  ((value ?? []) as Row[]).map((entry) => ({
    id: String(entry["id"]),
    name: textOf(entry["ar"], entry["en"]),
  }));

export const itemOf = (row: Row): QuestItemRecord => ({
  id: String(row["id"]),
  name: textOf(row["name_ar"], row["name_en"]),
  description: textOf(row["description_ar"], row["description_en"]),
  stockTotal: Number(row["stock_total"]),
  unitsOut: Number(row["units_out"]),
  stockLeft: Number(row["stock_left"]),
  missed: Number(row["missed"]),
  quests: namedOf(row["quests"]),
  categories: namedOf(row["categories"]),
});

/** What the audit log keeps of an item: its names, descriptions and stock. */
const auditView = (item: QuestItemRecord): Record<string, unknown> => ({
  nameAr: item.name.ar,
  nameEn: item.name.en,
  descriptionAr: item.description.ar,
  descriptionEn: item.description.en,
  stockTotal: item.stockTotal,
});

async function readAll(client: PoolClient, eventId: string): Promise<QuestItemRecord[]> {
  const { rows } = await client.query<Row>("SELECT * FROM quest_items($1)", [eventId]);
  return rows.map(itemOf);
}

async function readOne(
  client: PoolClient,
  eventId: string,
  id: string,
): Promise<QuestItemRecord | undefined> {
  return (await readAll(client, eventId)).find((item) => item.id === id);
}

/** Opens the event for an item write: not found for a stranger, refused once archived. */
async function openEvent(
  client: PoolClient,
  actor: Actor,
  eventId: string,
): Promise<QuestItemRefusal | undefined> {
  const event = await lockBuilderEvent(client, actor.organizerId, eventId);
  if (event === undefined) {
    return { kind: "not_found" };
  }
  return event.statusNow === "archived" ? { kind: "event_archived" } : undefined;
}

/** The event's quest items (FR-522), with stock left and misses (FR-1617). Owners and editors. */
export function listItems(
  deps: QuestItemDeps,
  actor: Actor,
  eventId: string,
): Promise<QuestItemDone<readonly QuestItemRecord[]>> {
  return asTeam(deps, actor, async (client) => done(await readAll(client, eventId)));
}

/** Adds a quest item; the database refuses it while the event has no prize desk (DL409). */
export function createItem(
  deps: QuestItemDeps,
  actor: Actor,
  eventId: string,
  input: QuestItemInput & Readonly<{ stockTotal: number }>,
  caller: Caller,
): Promise<QuestItemDone<QuestItemRecord>> {
  return asTeam(deps, actor, async (client) => {
    const closed = await openEvent(client, actor, eventId);
    if (closed !== undefined) {
      return closed;
    }
    const empty = { ar: null, en: null };
    const name = pick(input.name, empty);
    if (name.ar === null && name.en === null) {
      return { kind: "invalid", field: "name" };
    }
    const description = pick(input.description, empty);
    const { rows: counted } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM quest_item WHERE event_id = $1 AND status = 'active'",
      [eventId],
    );
    if ((counted[0]?.n ?? 0) >= QUEST_ITEM_LIMIT) {
      return { kind: "limit_reached", limit: QUEST_ITEM_LIMIT };
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO quest_item (event_id, name_ar, name_en, description_ar, description_en, stock_total)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [eventId, name.ar, name.en, description.ar, description.en, input.stockTotal],
    );
    const made = (await readOne(client, eventId, String(rows[0]?.id))) as QuestItemRecord;
    await audit(client, actor, caller, {
      action: "quest_item.create",
      eventId,
      target: { type: "quest_item", id: made.id },
      after: auditView(made),
    });
    return done(made);
  });
}

/** Edits an item's names, descriptions or stock; the stock never goes below the units already out. */
export function updateItem(
  deps: QuestItemDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  input: QuestItemInput,
  caller: Caller,
): Promise<QuestItemDone<QuestItemRecord>> {
  return asTeam(deps, actor, async (client) => {
    const closed = await openEvent(client, actor, target.eventId);
    if (closed !== undefined) {
      return closed;
    }
    const { rowCount } = await client.query(
      "SELECT 1 FROM quest_item WHERE event_id = $1 AND id = $2 AND status = 'active' FOR UPDATE",
      [target.eventId, target.id],
    );
    const current = rowCount === 1 ? await readOne(client, target.eventId, target.id) : undefined;
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const name = pick(input.name, current.name);
    if (name.ar === null && name.en === null) {
      return { kind: "invalid", field: "name" };
    }
    const stockTotal = input.stockTotal ?? current.stockTotal;
    if (stockTotal < current.unitsOut) {
      return { kind: "stock_below_reserved", unitsOut: current.unitsOut };
    }
    const description = pick(input.description, current.description);
    await client.query(
      `UPDATE quest_item SET name_ar = $2, name_en = $3, description_ar = $4, description_en = $5, stock_total = $6
       WHERE id = $1`,
      [target.id, name.ar, name.en, description.ar, description.en, stockTotal],
    );
    const after = (await readOne(client, target.eventId, target.id)) as QuestItemRecord;
    const diff = changes(auditView(current), auditView(after));
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "quest_item.update",
        eventId: target.eventId,
        target: { type: "quest_item", id: target.id },
        ...diff,
      });
    }
    return done(after);
  });
}

/** Removes an item no quest or category gives any more; what is reserved stays reserved (QI409 item_in_use). */
export function removeItem(
  deps: QuestItemDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  caller: Caller,
): Promise<QuestItemDone<null>> {
  return asTeam(deps, actor, async (client) => {
    const closed = await openEvent(client, actor, target.eventId);
    if (closed !== undefined) {
      return closed;
    }
    const current = await readOne(client, target.eventId, target.id);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    await client.query("UPDATE quest_item SET status = 'removed' WHERE id = $1", [target.id]);
    await audit(client, actor, caller, {
      action: "quest_item.remove",
      eventId: target.eventId,
      target: { type: "quest_item", id: target.id },
      before: auditView(current),
    });
    return done(null);
  });
}

/** Who missed an item, newest first, at most 200 (FR-1617). Owners and editors. */
export function itemMisses(
  deps: QuestItemDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
): Promise<QuestItemDone<readonly QuestItemMiss[]>> {
  return asTeam(deps, actor, async (client) => {
    if ((await readOne(client, target.eventId, target.id)) === undefined) {
      return { kind: "not_found" };
    }
    const { rows } = await client.query<Row>("SELECT * FROM quest_item_misses($1, $2)", [
      target.eventId,
      target.id,
    ]);
    return done(
      rows.map((row) => ({
        username: typeof row["username"] === "string" ? row["username"] : null,
        avatar: String(row["avatar"]),
        at: (row["at"] as Date).toISOString(),
        source: row["source"] === "category" ? "category" : "quest",
        sourceName: textOf(row["source_ar"], row["source_en"]),
        reason: row["reason"] === "claim_closed" ? "claim_closed" : "out_of_stock",
      })),
    );
  });
}
