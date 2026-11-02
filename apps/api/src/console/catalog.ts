import {
  achievementAdminSchema,
  achievementDocSchema,
  gemShopDocSchema,
  gemShopItemAdminSchema,
  levelTitlesAdminSchema,
  levelTitlesDocSchema,
  templateAdminSchema,
  templateDocSchema,
  type CatalogKind,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import { invalidCatalog, nothingToRevert } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";

/** The audit target of the single document that holds every level title. */
const WHOLE_SET = "all";

type Answer = Readonly<Record<string, unknown>>;

/**
 * One catalog editor (T-709b): the shape of what an admin edits (`doc`), of a row as the console lists it (`row`), the
 * audit target, and its two database doors (migration 0119). A level-title set is one document, so it has no id.
 */
type Editor = Readonly<{
  targetType: string;
  doc: z.ZodType;
  row: z.ZodType;
  /** The row's id field in the list door's answer; undefined for a single document. */
  idField: "key" | "id" | "itemId" | undefined;
  list: (client: PoolClient) => Promise<unknown>;
  save: (
    client: PoolClient,
    id: string,
    doc: unknown,
    revertOf: string | null,
    requestId: string,
  ) => Promise<unknown>;
}>;

async function answerOf(client: PoolClient, sql: string, values: unknown[] = []): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

const EDITORS: Readonly<Record<CatalogKind, Editor>> = {
  template: {
    targetType: "event_template",
    doc: templateDocSchema,
    row: templateAdminSchema,
    idField: "key",
    list: (client) => answerOf(client, "SELECT admin_templates() AS r"),
    save: (client, id, doc, revertOf, requestId) =>
      answerOf(client, "SELECT admin_template_save($1, $2, $3, $4) AS r", [
        id,
        doc,
        revertOf,
        requestId,
      ]),
  },
  achievement: {
    targetType: "achievement",
    doc: achievementDocSchema,
    row: achievementAdminSchema,
    idField: "id",
    list: (client) => answerOf(client, "SELECT admin_achievements() AS r"),
    save: (client, id, doc, revertOf, requestId) =>
      answerOf(client, "SELECT admin_achievement_save($1, $2, $3, $4) AS r", [
        id,
        doc,
        revertOf,
        requestId,
      ]),
  },
  level_titles: {
    targetType: "level_title",
    doc: levelTitlesDocSchema,
    row: levelTitlesAdminSchema,
    idField: undefined,
    list: (client) => answerOf(client, "SELECT admin_level_titles() AS r"),
    save: (client, _id, doc, revertOf, requestId) =>
      answerOf(client, "SELECT admin_level_titles_save($1, $2, $3) AS r", [
        doc,
        revertOf,
        requestId,
      ]),
  },
  gem_shop: {
    targetType: "gem_shop_item",
    doc: gemShopDocSchema,
    row: gemShopItemAdminSchema,
    idField: "itemId",
    list: (client) => answerOf(client, "SELECT admin_shop_items() AS r"),
    save: (client, id, doc, revertOf, requestId) =>
      answerOf(client, "SELECT admin_shop_item_save($1, $2, $3, $4) AS r", [
        id,
        doc,
        revertOf,
        requestId,
      ]),
  },
};

/** A value outside a table's own bounds (a CHECK) is the admin's input, not a fault. */
async function catalogDoor<T>(
  pool: Pool,
  admin: Admin,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await door(pool, admin, work);
  } catch (error) {
    if ((error as { code?: unknown }).code === "23514") {
      throw invalidCatalog();
    }
    throw error;
  }
}

/** Which targets of a kind hold an earlier state to go back to: the latest catalog entry has a `before`. */
async function revertibleIds(client: PoolClient, targetType: string): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<{ target_id: string }>(
    `SELECT target_id FROM (
       SELECT DISTINCT ON (target_id) target_id, before FROM audit_log
       WHERE target_type = $1 AND action LIKE 'catalog.%' AND target_id IS NOT NULL
       ORDER BY target_id, id DESC) latest
     WHERE before IS NOT NULL`,
    [targetType],
  );
  return new Set(rows.map((row) => row.target_id));
}

/** The audit target of a row: its id, or the one document that holds every level title. */
const auditIdOf = (editor: Editor, id: string): string =>
  editor.idField === undefined ? WHOLE_SET : id;

function withRevertible(editor: Editor, answer: unknown, undoable: ReadonlySet<string>): Answer[] {
  if (editor.idField === undefined) {
    return [{ ...(answer as Answer), revertible: undoable.has(WHOLE_SET) }];
  }
  const field = editor.idField;
  return (answer as Answer[]).map((row) => ({
    ...row,
    revertible: undoable.has(String(row[field])),
  }));
}

/** Every row of a catalog with whether it can be reverted. A level-title set answers one row. */
export function listCatalog(pool: Pool, admin: Admin, kind: CatalogKind): Promise<unknown[]> {
  const editor = EDITORS[kind];
  return catalogDoor(pool, admin, async (client) => {
    const answer = await editor.list(client);
    const undoable = await revertibleIds(client, editor.targetType);
    return withRevertible(editor, answer, undoable).map((row) => editor.row.parse(row));
  });
}

/** The row a save or a revert answered with, and whether it can be reverted now. */
async function savedRow(
  client: PoolClient,
  editor: Editor,
  id: string,
  saved: unknown,
): Promise<unknown> {
  const undoable = await revertibleIds(client, editor.targetType);
  return editor.row.parse({
    ...(saved as Answer),
    revertible: undoable.has(auditIdOf(editor, id)),
  });
}

/**
 * Saves one row from an admin's input. The caller has already checked `input` against the editor's schema; the door checks
 * it again, writes the row and its audit entry in one transaction, and a save that changes nothing writes nothing.
 */
export function saveCatalog(
  pool: Pool,
  admin: Admin,
  kind: CatalogKind,
  target: Readonly<{ id: string; input: unknown; requestId: string }>,
): Promise<unknown> {
  const editor = EDITORS[kind];
  return catalogDoor(pool, admin, async (client) => {
    const saved = await editor.save(client, target.id, target.input, null, target.requestId);
    return savedRow(client, editor, target.id, saved);
  });
}

/**
 * Puts back what the row held before its latest catalog change (the `before` of that audit entry), through the same save
 * door and checks, and audits it as a revert. A second revert undoes the first. 409 `nothing_to_revert` when the row was
 * never changed or its latest entry made it (a template that was new has nothing earlier; switch it off instead), and 409
 * `stale` when another admin changed the row after this read: the door gets the entry's id and re-reads it under the row's
 * lock, so it never puts back an older state over a newer change.
 */
export function revertCatalog(
  pool: Pool,
  admin: Admin,
  kind: CatalogKind,
  target: Readonly<{ id: string; requestId: string }>,
): Promise<unknown> {
  const editor = EDITORS[kind];
  return catalogDoor(pool, admin, async (client) => {
    const { rows } = await client.query<{ id: string; before: unknown }>(
      `SELECT id, before FROM audit_log
       WHERE target_type = $1 AND target_id = $2 AND action LIKE 'catalog.%'
       ORDER BY id DESC LIMIT 1`,
      [editor.targetType, auditIdOf(editor, target.id)],
    );
    const latest = rows[0];
    if (latest === undefined || latest.before === null) {
      throw nothingToRevert();
    }
    const doc = editor.doc.safeParse(latest.before);
    if (!doc.success) {
      throw invalidCatalog({ issues: doc.error.issues.map((issue) => issue.message) });
    }
    const saved = await editor.save(client, target.id, null, latest.id, target.requestId);
    return savedRow(client, editor, target.id, saved);
  });
}

/** The editor's schema for an admin's input, for the routes to check a body before the door sees it. */
export const docSchemaOf = (kind: CatalogKind): z.ZodType => EDITORS[kind].doc;
