import type { QuestType, QuestVerification } from "@questify/shared";
import type { PoolClient } from "pg";
import type { EventStatus } from "#src/events/store";

export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

export type CategoryRecord = Readonly<
  {
    id: string;
    eventId: string;
    name: Bilingual;
    position: number;
  } & CategoryRuleFields
>;

/** A category's rules (T-304, migration 0044): its order, its opening time, its unlock and its completion bonus. */
export type CategoryRuleFields = Readonly<{
  orderMode: "any" | "in_order";
  opensAt: Date | null;
  unlockAfter: string | null;
  completionBonus: number;
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
  /** The version its printed QR carries (T-104); a regenerated code bumps it. */
  qrVersion: number;
  /** How it may be verified (FR-301): the printed QR, staff scanning My QR, or both. */
  verification: readonly QuestVerification[];
  /** A passport's steps in order (T-304b); none for every other type. */
  steps: readonly PassportStep[];
}>;

/** One step of a passport (T-304b): its name and the version its printed code carries. */
export type PassportStep = Readonly<{
  id: string;
  name: Bilingual;
  position: number;
  qrVersion: number;
}>;

/** A passport step as the builder writes it: an existing step by its id, or a new one without. */
export type StepInput = Readonly<{ id: string | undefined; name: Bilingual }>;

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
  verification: readonly QuestVerification[];
}>;

/** The event as the builder needs it, read under a lock that serializes builder writes but never blocks joins. */
export type BuilderEvent = Readonly<{ id: string; timezone: string; statusNow: EventStatus }>;

type CategoryRow = {
  id: string;
  event_id: string;
  name_ar: string | null;
  name_en: string | null;
  position: number;
  order_mode: "any" | "in_order";
  opens_at: Date | null;
  unlock_after: string | null;
  completion_bonus: number;
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
  qr_version: number;
  verification: QuestVerification[];
};

const CATEGORY_COLUMNS =
  "id, event_id, name_ar, name_en, position, order_mode, opens_at, unlock_after, completion_bonus";
const QUEST_COLUMNS = `id, event_id, category_id, type, title_ar, title_en, description_ar, description_en, points,
  repeat_cap, opens_at, closes_at, visible, position, type_config, qr_version, verification`;

const toCategory = (row: CategoryRow): CategoryRecord => ({
  id: row.id,
  eventId: row.event_id,
  name: { ar: row.name_ar, en: row.name_en },
  position: row.position,
  orderMode: row.order_mode,
  opensAt: row.opens_at,
  unlockAfter: row.unlock_after,
  completionBonus: row.completion_bonus,
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
  qrVersion: row.qr_version,
  verification: row.verification,
  steps: [],
});

type StepRow = {
  id: string;
  quest_id: string;
  name_ar: string | null;
  name_en: string | null;
  position: number;
  qr_version: number;
};

/** The quests with their passport steps read in one query (none for other types). */
async function withSteps(db: PoolClient, quests: QuestRecord[]): Promise<QuestRecord[]> {
  const passports = quests.filter((quest) => quest.type === "passport").map((quest) => quest.id);
  if (passports.length === 0) {
    return quests;
  }
  const { rows } = await db.query<StepRow>(
    `SELECT id, quest_id, name_ar, name_en, position, qr_version FROM passport_step
     WHERE quest_id = ANY ($1) ORDER BY position, id`,
    [passports],
  );
  return quests.map((quest) => ({
    ...quest,
    steps: rows
      .filter((row) => row.quest_id === quest.id)
      .map((row) => ({
        id: row.id,
        name: { ar: row.name_ar, en: row.name_en },
        position: row.position,
        qrVersion: row.qr_version,
      })),
  }));
}

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
  return withSteps(db, rows.map(toQuest));
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
  return row === undefined ? undefined : ((await withSteps(db, [toQuest(row)]))[0] as QuestRecord);
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

/** Writes a category's name and rules (migration 0044's column grants). */
export async function writeCategory(
  db: PoolClient,
  id: string,
  fields: Readonly<{ name: Bilingual }> & CategoryRuleFields,
): Promise<CategoryRecord> {
  const { rows } = await db.query<CategoryRow>(
    `UPDATE category SET name_ar = $2, name_en = $3, order_mode = $4, opens_at = $5, unlock_after = $6,
       completion_bonus = $7
     WHERE id = $1 RETURNING ${CATEGORY_COLUMNS}`,
    [
      id,
      fields.name.ar,
      fields.name.en,
      fields.orderMode,
      fields.opensAt,
      fields.unlockAfter,
      fields.completionBonus,
    ],
  );
  return toCategory(rows[0] as CategoryRow);
}

/** The categories of this event that unlock after this one (FR-235): it cannot be deleted while any does. */
export async function unlockedBy(db: PoolClient, categoryId: string): Promise<Bilingual[]> {
  const { rows } = await db.query<{ name_ar: string | null; name_en: string | null }>(
    "SELECT name_ar, name_en FROM category WHERE unlock_after = $1 ORDER BY position, id",
    [categoryId],
  );
  return rows.map((row) => ({ ar: row.name_ar, en: row.name_en }));
}

/** Whose bonus this category paid (T-304): `real`, `rehearsal` (only rehearsal accounts) or `none`. */
export async function bonusesOf(
  db: PoolClient,
  categoryId: string,
): Promise<"none" | "rehearsal" | "real"> {
  const { rows } = await db.query<{ real: boolean | null }>(
    `SELECT bool_or(n.joined_via IS DISTINCT FROM 'rehearsal') AS real
     FROM ledger_entry l JOIN enrollment n ON n.id = l.enrollment_id
     WHERE l.category_id = $1`,
    [categoryId],
  );
  const real = rows[0]?.real ?? null;
  return real === null ? "none" : real ? "real" : "rehearsal";
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

/** Deletes every quest of a category, passport steps first. Returns their ids, for the audit entry. */
export async function deleteQuestsOf(db: PoolClient, categoryId: string): Promise<string[]> {
  await db.query(
    "DELETE FROM passport_step WHERE quest_id IN (SELECT id FROM quest WHERE category_id = $1)",
    [categoryId],
  );
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
  if (table === "quest") {
    await db.query("DELETE FROM passport_step WHERE quest_id = $1", [id]);
  }
  await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
}

/** The steps of this passport a player stamped (stamped_steps, migration 0045): they cannot be deleted. */
export async function stampedSteps(db: PoolClient, questId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ step_id: string }>("SELECT step_id FROM stamped_steps($1)", [
    questId,
  ]);
  return new Set(rows.map((row) => row.step_id));
}

/**
 * Writes a passport's steps as the full list, in its order: steps left out are deleted, named ones renamed and moved,
 * new ones added. The caller checked that every id is one of this quest's and that no stamped step is left out.
 */
export async function writeSteps(
  db: PoolClient,
  quest: Readonly<{ id: string; eventId: string; steps: readonly PassportStep[] }>,
  steps: readonly StepInput[],
): Promise<void> {
  const kept = new Set(steps.map((step) => step.id));
  const gone = quest.steps.filter((step) => !kept.has(step.id)).map((step) => step.id);
  if (gone.length > 0) {
    await db.query("DELETE FROM passport_step WHERE id = ANY ($1)", [gone]);
  }
  for (const [position, step] of steps.entries()) {
    if (step.id === undefined) {
      await db.query(
        `INSERT INTO passport_step (event_id, quest_id, name_ar, name_en, position)
         VALUES ($1, $2, $3, $4, $5)`,
        [quest.eventId, quest.id, step.name.ar, step.name.en, position],
      );
    } else {
      await db.query(
        "UPDATE passport_step SET name_ar = $2, name_en = $3, position = $4 WHERE id = $1",
        [step.id, step.name.ar, step.name.en, position],
      );
    }
  }
}

/** Bumps a passport step's code version (FR-1711), as `bumpQrVersion` does a quest's. Undefined when not found. */
export async function bumpStepVersion(
  db: PoolClient,
  eventId: string,
  stepId: string,
): Promise<Readonly<{ questId: string; before: number; version: number }> | undefined> {
  const { rows } = await db.query<{ quest_id: string; qr_version: number }>(
    `UPDATE passport_step SET qr_version = qr_version + 1 WHERE event_id = $1 AND id = $2
     RETURNING quest_id, qr_version`,
    [eventId, stepId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { questId: row.quest_id, before: row.qr_version - 1, version: row.qr_version };
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
                        repeat_cap, opens_at, closes_at, visible, position, type_config, verification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      fields.verification,
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
                      type_config = $13, verification = $14
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
      fields.verification,
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

/** Bumps a quest's code version, so every code printed before stops working (FR-1711). Returns the new version. */
export async function bumpQrVersion(db: PoolClient, id: string): Promise<number> {
  const { rows } = await db.query<{ qr_version: number }>(
    "UPDATE quest SET qr_version = qr_version + 1 WHERE id = $1 RETURNING qr_version",
    [id],
  );
  // The caller read this quest with a lock in the same transaction, so the row is there.
  return (rows[0] as { qr_version: number }).qr_version;
}
