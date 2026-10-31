import type { PoolClient } from "pg";

/** What a change set item does, and to which kind of thing (migration 0099). */
export type ItemOp = "add" | "edit" | "delete";
export type ItemTarget = "quest" | "category" | "reward";
export type ItemStatus = "pending" | "applied" | "failed" | "stale";
export type SetStatus = "open" | "applied" | "closed";

export type JsonObject = Record<string, unknown>;

/** An item as the reviewer proposed it, before the review. */
export type NewItem = Readonly<{
  op: ItemOp;
  target: ItemTarget;
  targetId: string | null;
  body: JsonObject;
  before: JsonObject | null;
}>;

export type ItemRecord = Readonly<{
  id: string;
  position: number;
  op: ItemOp;
  target: ItemTarget;
  targetId: string | null;
  body: JsonObject;
  before: JsonObject | null;
  status: ItemStatus;
  error: JsonObject | null;
  decidedAt: Date | null;
}>;

export type SetRecord = Readonly<{
  id: string;
  status: SetStatus;
  createdAt: Date;
  finishedAt: Date | null;
}>;

/** A set with how many items it holds and how many still wait for a decision. */
export type SetSummary = SetRecord & Readonly<{ items: number; pending: number }>;

type SetRow = { id: string; status: SetStatus; created_at: Date; finished_at: Date | null };
type SummaryRow = SetRow & { items: number; pending: number };
type ItemRow = {
  id: string;
  position: number;
  op: ItemOp;
  target: ItemTarget;
  target_id: string | null;
  body: JsonObject;
  before: JsonObject | null;
  status: ItemStatus;
  error: JsonObject | null;
  decided_at: Date | null;
};

const setOf = (row: SetRow): SetRecord => ({
  id: row.id,
  status: row.status,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

const ITEM_COLUMNS = "id, position, op, target, target_id, body, before, status, error, decided_at";

const itemOf = (row: ItemRow): ItemRecord => ({
  id: row.id,
  position: row.position,
  op: row.op,
  target: row.target,
  targetId: row.target_id,
  body: row.body,
  before: row.before,
  status: row.status,
  error: row.error,
  decidedAt: row.decided_at,
});

/** Writes a set with its items, in the order given, as one unit. */
export async function insertSet(
  client: PoolClient,
  owner: Readonly<{ organizerId: string; eventId: string; staffUserId: string }>,
  items: readonly NewItem[],
): Promise<SetRecord> {
  const { rows } = await client.query<SetRow>(
    `INSERT INTO change_set (organizer_id, event_id, created_by) VALUES ($1, $2, $3)
     RETURNING id, status, created_at, finished_at`,
    [owner.organizerId, owner.eventId, owner.staffUserId],
  );
  const made = setOf(rows[0] as SetRow);
  for (const [position, item] of items.entries()) {
    await client.query(
      `INSERT INTO change_set_item
         (change_set_id, organizer_id, event_id, position, op, target, target_id, body, before)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        made.id,
        owner.organizerId,
        owner.eventId,
        position,
        item.op,
        item.target,
        item.targetId,
        JSON.stringify(item.body),
        item.before === null ? null : JSON.stringify(item.before),
      ],
    );
  }
  return made;
}

/** The event's sets, newest first, with their item counts. */
export async function listSets(
  client: PoolClient,
  eventId: string,
  limit: number,
): Promise<SetSummary[]> {
  const { rows } = await client.query<SummaryRow>(
    `SELECT s.id, s.status, s.created_at, s.finished_at,
            count(i.id)::int AS items, (count(i.id) FILTER (WHERE i.status = 'pending'))::int AS pending
     FROM change_set s LEFT JOIN change_set_item i ON i.change_set_id = s.id
     WHERE s.event_id = $1
     GROUP BY s.id ORDER BY s.created_at DESC, s.id DESC LIMIT $2`,
    [eventId, limit],
  );
  return rows.map((row) => ({ ...setOf(row), items: row.items, pending: row.pending }));
}

/** One set of the event, or undefined; locked while the caller finishes it. */
export async function readSet(
  client: PoolClient,
  eventId: string,
  setId: string,
  lock = false,
): Promise<SetRecord | undefined> {
  const { rows } = await client.query<SetRow>(
    `SELECT id, status, created_at, finished_at FROM change_set WHERE event_id = $1 AND id = $2${
      lock ? " FOR UPDATE" : ""
    }`,
    [eventId, setId],
  );
  return rows[0] === undefined ? undefined : setOf(rows[0]);
}

/** A set's items in their order. */
export async function readItems(client: PoolClient, setId: string): Promise<ItemRecord[]> {
  const { rows } = await client.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM change_set_item WHERE change_set_id = $1 ORDER BY position`,
    [setId],
  );
  return rows.map(itemOf);
}

/** Records what happened to a pending item; returns false when it was already decided. */
export async function decideItem(
  client: PoolClient,
  itemId: string,
  decision: Readonly<{ status: Exclude<ItemStatus, "pending">; error: JsonObject | null }>,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE change_set_item SET status = $2, error = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [itemId, decision.status, decision.error === null ? null : JSON.stringify(decision.error)],
  );
  return rowCount === 1;
}

/** Finishes an open set as applied or closed. */
export async function finishSet(
  client: PoolClient,
  setId: string,
  status: "applied" | "closed",
): Promise<void> {
  await client.query(
    "UPDATE change_set SET status = $2, finished_at = now() WHERE id = $1 AND status = 'open'",
    [setId, status],
  );
}
