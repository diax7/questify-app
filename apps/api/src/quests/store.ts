import type { QuestType } from "@questify/shared";
import type { PoolClient } from "pg";
import type { EventStatus } from "#src/events/store";

export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

export type CategoryRecord = Readonly<{
  id: string;
  eventId: string;
  name: Bilingual;
  position: number;
}>;

export type QuestRecord = Readonly<{
  id: string;
  eventId: string;
  categoryId: string;
  type: QuestType;
  title: Bilingual;
  description: Bilingual;
  points: number;
  repeatCap: number;
  opensAt: Date | null;
  closesAt: Date | null;
  visible: boolean;
  position: number;
  config: Readonly<Record<string, unknown>>;
}>;

/** The fields the API writes on a quest (migration 0010's column grants), all known before a write. */
export type QuestFields = Readonly<{
  categoryId: string;
  title: Bilingual;
  description: Bilingual;
  points: number;
  repeatCap: number;
  opensAt: Date | null;
  closesAt: Date | null;
  visible: boolean;
  config: Readonly<Record<string, unknown>>;
}>;

/** The event as the builder needs it, read under a lock that serializes builder writes but never blocks joins. */
export type BuilderEvent = Readonly<{ id: string; timezone: string; statusNow: EventStatus }>;

type CategoryRow = {
  id: string;
  event_id: string;
  name_ar: string | null;
  name_en: string | null;
  position: number;
};
type QuestRow = {
  id: string;
  event_id: string;
  category_id: string;
  type: QuestType;
  title_ar: string | null;
  title_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  points: number;
  repeat_cap: number;
  opens_at: Date | null;
  closes_at: Date | null;
  visible: boolean;
  position: number;
  type_config: Record<string, unknown>;
};

const CATEGORY_COLUMNS = "id, event_id, name_ar, name_en, position";
const QUEST_COLUMNS = `id, event_id, category_id, type, title_ar, title_en, description_ar, description_en, points,
  repeat_cap, opens_at, closes_at, visible, position, type_config`;

const toCategory = (row: CategoryRow): CategoryRecord => ({
  id: row.id,
  eventId: row.event_id,
  name: { ar: row.name_ar, en: row.name_en },
  position: row.position,
});

const toQuest = (row: QuestRow): QuestRecord => ({
  id: row.id,
  eventId: row.event_id,
  categoryId: row.category_id,
  type: row.type,
  title: { ar: row.title_ar, en: row.title_en },
  description: { ar: row.description_ar, en: row.description_en },
  points: row.points,
  repeatCap: row.repeat_cap,
  opensAt: row.opens_at,
  closesAt: row.closes_at,
  visible: row.visible,
  position: row.position,
  config: row.type_config,
});

const lockClause = (lock: boolean) => (lock ? " FOR NO KEY UPDATE" : "");

/**
 * The event of the path, locked with `FOR NO KEY UPDATE`: builder writes on one event go one at a time (the caps and
 * positions stay right), while the foreign-key inserts a live event makes (joins, completions) are never blocked.
 */
export async function lockBuilderEvent(
  db: PoolClient,
  organizerId: string,
  eventId: string,
): Promise<BuilderEvent | undefined> {
  const { rows } = await db.query<{ id: string; timezone: string; status_now: EventStatus }>(
    `SELECT id, timezone, event_status_now(status, starts_at, ends_at) AS status_now
     FROM event WHERE organizer_id = $1 AND id = $2 FOR NO KEY UPDATE`,
    [organizerId, eventId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, timezone: row.timezone, statusNow: row.status_now };
}

export async function listCategories(db: PoolClient, eventId: string): Promise<CategoryRecord[]> {
  const { rows } = await db.query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM category WHERE event_id = $1 ORDER BY position, id`,
    [eventId],
  );
  return rows.map(toCategory);
}

export async function listQuests(db: PoolClient, eventId: string): Promise<QuestRecord[]> {
  const { rows } = await db.query<QuestRow>(
    `SELECT ${QUEST_COLUMNS} FROM quest WHERE event_id = $1 ORDER BY position, id`,
    [eventId],
  );
  return rows.map(toQuest);
}

/** A category of the path's event only: an id from another event is "not found", never a back door to it. */
export async function readCategory(
  db: PoolClient,
  eventId: string,
  id: string,
  lock = false,
): Promise<CategoryRecord | undefined> {
  const { rows } = await db.query<CategoryRow>(
    `SELECT ${CATEGORY_COLUMNS} FROM category WHERE event_id = $1 AND id = $2${lockClause(lock)}`,
    [eventId, id],
  );
  const row = rows[0];
  return row === undefined ? undefined : toCategory(row);
}

/** A quest of the path's event only, as `readCategory`. */
export async function readQuest(
  db: PoolClient,
  eventId: string,
  id: string,
  lock = false,
): Promise<QuestRecord | undefined> {
  const { rows } = await db.query<QuestRow>(
    `SELECT ${QUEST_COLUMNS} FROM quest WHERE event_id = $1 AND id = $2${lockClause(lock)}`,
    [eventId, id],
  );
  const row = rows[0];
  return row === undefined ? undefined : toQuest(row);
}

export async function countRows(
  db: PoolClient,
  table: "category" | "quest",
  eventId: string,
): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE event_id = $1`,
    [eventId],
  );
  return rows[0]?.count ?? 0;
}

/** The position after the last one, so a new or moved row goes to the end. */
async function nextPosition(db: PoolClient, sql: string, id: string): Promise<number> {
  const { rows } = await db.query<{ next: number }>(sql, [id]);
  return rows[0]?.next ?? 0;
}

export async function insertCategory(
  db: PoolClient,
  eventId: string,
  name: Bilingual,
): Promise<CategoryRecord> {
  const position = await nextPosition(
    db,
    "SELECT coalesce(max(position) + 1, 0) AS next FROM category WHERE event_id = $1",
    eventId,
  );
  const { rows } = await db.query<CategoryRow>(
    `INSERT INTO category (event_id, name_ar, name_en, position) VALUES ($1, $2, $3, $4)
     RETURNING ${CATEGORY_COLUMNS}`,
    [eventId, name.ar, name.en, position],
  );
  return toCategory(rows[0] as CategoryRow);
}

export async function renameCategory(
  db: PoolClient,
  id: string,
  name: Bilingual,
): Promise<CategoryRecord> {
  const { rows } = await db.query<CategoryRow>(
    `UPDATE category SET name_ar = $2, name_en = $3 WHERE id = $1 RETURNING ${CATEGORY_COLUMNS}`,
    [id, name.ar, name.en],
  );
  return toCategory(rows[0] as CategoryRow);
}

/** Moves every quest of one category to the end of another, keeping their order. Returns how many moved. */
export async function moveQuests(db: PoolClient, from: string, to: string): Promise<number> {
  const start = await nextPosition(
    db,
    "SELECT coalesce(max(position) + 1, 0) AS next FROM quest WHERE category_id = $1",
    to,
  );
  const { rowCount } = await db.query(
    `UPDATE quest q SET category_id = $2, position = $3 + ordered.n - 1
     FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM quest WHERE category_id = $1) ordered
     WHERE q.id = ordered.id`,
    [from, to, start],
  );
  return rowCount ?? 0;
}

/** Deletes every quest of a category. Returns their ids, for the audit entry. */
export async function deleteQuestsOf(db: PoolClient, categoryId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    "DELETE FROM quest WHERE category_id = $1 RETURNING id",
    [categoryId],
  );
  return rows.map((row) => row.id);
}

export async function deleteRow(
  db: PoolClient,
  table: "category" | "quest",
  id: string,
): Promise<void> {
  await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

export async function insertQuest(
  db: PoolClient,
  eventId: string,
  type: QuestType,
  fields: QuestFields,
): Promise<QuestRecord> {
  const position = await nextPosition(
    db,
    "SELECT coalesce(max(position) + 1, 0) AS next FROM quest WHERE category_id = $1",
    fields.categoryId,
  );
  const { rows } = await db.query<QuestRow>(
    `INSERT INTO quest (event_id, category_id, type, title_ar, title_en, description_ar, description_en, points,
                        repeat_cap, opens_at, closes_at, visible, position, type_config)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING ${QUEST_COLUMNS}`,
    [
      eventId,
      fields.categoryId,
      type,
      fields.title.ar,
      fields.title.en,
      fields.description.ar,
      fields.description.en,
      fields.points,
      fields.repeatCap,
      fields.opensAt,
      fields.closesAt,
      fields.visible,
      position,
      fields.config,
    ],
  );
  return toQuest(rows[0] as QuestRow);
}

/** Writes a quest's fields; a change of category puts it at the end of the new one. */
export async function updateQuest(
  db: PoolClient,
  current: QuestRecord,
  fields: QuestFields,
): Promise<QuestRecord> {
  const position =
    fields.categoryId === current.categoryId
      ? current.position
      : await nextPosition(
          db,
          "SELECT coalesce(max(position) + 1, 0) AS next FROM quest WHERE category_id = $1",
          fields.categoryId,
        );
  const { rows } = await db.query<QuestRow>(
    `UPDATE quest SET category_id = $2, title_ar = $3, title_en = $4, description_ar = $5, description_en = $6,
                      points = $7, repeat_cap = $8, opens_at = $9, closes_at = $10, visible = $11, position = $12,
                      type_config = $13
     WHERE id = $1 RETURNING ${QUEST_COLUMNS}`,
    [
      current.id,
      fields.categoryId,
      fields.title.ar,
      fields.title.en,
      fields.description.ar,
      fields.description.en,
      fields.points,
      fields.repeatCap,
      fields.opensAt,
      fields.closesAt,
      fields.visible,
      position,
      fields.config,
    ],
  );
  return toQuest(rows[0] as QuestRow);
}

/**
 * Writes a new order from the full list of ids. Returns false, changing nothing, when the list is not exactly the
 * current set (someone else added, moved or deleted one meanwhile).
 */
export async function reorder(
  db: PoolClient,
  table: "category" | "quest",
  scope: Readonly<{ column: "event_id" | "category_id"; id: string }>,
  ids: readonly string[],
): Promise<boolean> {
  const { rows } = await db.query<{ same: boolean }>(
    `SELECT coalesce(array_agg(id ORDER BY id), '{}') = (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM unnest($2::uuid[]) x) AS same
     FROM ${table} WHERE ${scope.column} = $1`,
    [scope.id, ids],
  );
  if (rows[0]?.same !== true) {
    return false;
  }
  await db.query(
    `UPDATE ${table} t SET position = ordered.n - 1
     FROM unnest($1::uuid[]) WITH ORDINALITY AS ordered(id, n)
     WHERE t.id = ordered.id`,
    [ids],
  );
  return true;
}
