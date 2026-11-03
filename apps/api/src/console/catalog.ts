import {
  achievementAdminSchema,
  achievementBeforeSchema,
  achievementDocSchema,
  amountsAdminSchema,
  amountsDocSchema,
  gemShopDocSchema,
  gemShopItemAdminSchema,
  homeLayoutAdminSchema,
  homeLayoutDocSchema,
  itemAdminSchema,
  itemDocSchema,
  levelTitlesAdminSchema,
  levelTitlesDocSchema,
  loweredGemsSchema,
  templateAdminSchema,
  templateDocSchema,
  xpTableAdminSchema,
  xpTableDocSchema,
  xpTableLoweringSchema,
  type CatalogKind,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import {
  CATALOG_CONFLICTS,
  confirmationRequired,
  invalidCatalog,
  nothingToRevert,
} from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";

type Answer = Readonly<Record<string, unknown>>;

/** What a door call carries: the row, the document (null on a revert), the entry a revert undoes, the confirmation. */
type SaveCall = Readonly<{
  id: string;
  doc: unknown;
  revertOf: string | null;
  confirmed: boolean;
  requestId: string;
}>;

/**
 * One catalog editor (T-709b, T-709c, T-709d): the shape of what an admin edits (`doc`), of an audit entry's `before` a
 * revert puts back (`before`), of a row as the console lists it (`row`), the audit target, and its two database doors
 * (migrations 0119, 0122, 0124 and 0137). A level-title set, the amounts, the XP table and Questify home's layout are one
 * document each, so they have no id: `auditId` names them.
 */
type Editor = Readonly<{
  targetType: string;
  doc: z.ZodType;
  before: z.ZodType;
  row: z.ZodType;
  /** The row's id field in the list door's answer; undefined for a single document. */
  idField: "key" | "id" | "itemId" | undefined;
  /** The audit target id of a single document. */
  auditId: string;
  /** Whether a save can pay gems that cannot come back, so the door asks for a confirmation (409 confirmation_required). */
  confirmable: boolean;
  list: (client: PoolClient) => Promise<unknown>;
  save: (client: PoolClient, call: SaveCall) => Promise<unknown>;
}>;

async function answerOf(client: PoolClient, sql: string, values: unknown[] = []): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

const EDITORS: Readonly<Record<CatalogKind, Editor>> = {
  template: {
    targetType: "event_template",
    doc: templateDocSchema,
    before: templateDocSchema,
    row: templateAdminSchema,
    idField: "key",
    auditId: "",
    confirmable: false,
    list: (client) => answerOf(client, "SELECT admin_templates() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_template_save($1, $2, $3, $4) AS r", [
        call.id,
        call.doc,
        call.revertOf,
        call.requestId,
      ]),
  },
  achievement: {
    targetType: "achievement",
    doc: achievementDocSchema,
    before: achievementBeforeSchema,
    row: achievementAdminSchema,
    idField: "id",
    auditId: "",
    confirmable: true,
    list: (client) => answerOf(client, "SELECT admin_achievements() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_achievement_save($1, $2, $3, $4, $5) AS r", [
        call.id,
        call.doc,
        call.revertOf,
        call.confirmed,
        call.requestId,
      ]),
  },
  level_titles: {
    targetType: "level_title",
    doc: levelTitlesDocSchema,
    before: levelTitlesDocSchema,
    row: levelTitlesAdminSchema,
    idField: undefined,
    auditId: "all",
    confirmable: false,
    list: (client) => answerOf(client, "SELECT admin_level_titles() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_level_titles_save($1, $2, $3) AS r", [
        call.doc,
        call.revertOf,
        call.requestId,
      ]),
  },
  gem_shop: {
    targetType: "gem_shop_item",
    doc: gemShopDocSchema,
    before: gemShopDocSchema,
    row: gemShopItemAdminSchema,
    idField: "itemId",
    auditId: "",
    confirmable: false,
    list: (client) => answerOf(client, "SELECT admin_shop_items() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_shop_item_save($1, $2, $3, $4) AS r", [
        call.id,
        call.doc,
        call.revertOf,
        call.requestId,
      ]),
  },
  amounts: {
    targetType: "platform_setting",
    doc: amountsDocSchema,
    before: amountsDocSchema,
    row: amountsAdminSchema,
    idField: undefined,
    auditId: "amounts",
    confirmable: false,
    list: (client) => answerOf(client, "SELECT admin_amounts() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_amounts_save($1, $2, $3) AS r", [
        call.doc,
        call.revertOf,
        call.requestId,
      ]),
  },
  xp_table: {
    targetType: "xp_level",
    doc: xpTableDocSchema,
    before: xpTableDocSchema,
    row: xpTableAdminSchema,
    idField: undefined,
    auditId: "all",
    confirmable: true,
    list: (client) => answerOf(client, "SELECT admin_xp_table() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_xp_table_save($1, $2, $3, $4) AS r", [
        call.doc,
        call.revertOf,
        call.confirmed,
        call.requestId,
      ]),
  },
  item: {
    targetType: "item",
    doc: itemDocSchema,
    before: itemDocSchema,
    row: itemAdminSchema,
    idField: "id",
    auditId: "",
    confirmable: false,
    list: (client) => answerOf(client, "SELECT admin_items() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_item_save($1, $2, $3, $4) AS r", [
        call.id,
        call.doc,
        call.revertOf,
        call.requestId,
      ]),
  },
  home_layout: {
    targetType: "platform_setting",
    doc: homeLayoutDocSchema,
    before: homeLayoutDocSchema,
    row: homeLayoutAdminSchema,
    idField: undefined,
    auditId: "questify_home",
    confirmable: false,
    list: (client) => answerOf(client, "SELECT admin_home_layout() AS r"),
    save: (client, call) =>
      answerOf(client, "SELECT admin_home_layout_save($1, $2, $3) AS r", [
        call.doc,
        call.revertOf,
        call.requestId,
      ]),
  },
};

/** The door's JSON detail of a refusal (CA428 and CA409 of migrations 0122 and 0124). */
function detailOf(detail: unknown): Readonly<Record<string, unknown>> {
  // Stryker disable next-line ConditionalExpression: those doors always set the detail; a missing one is a broken door
  if (typeof detail !== "string") {
    throw new Error("a catalog refusal came without its detail; check migrations 0122 and 0124");
  }
  return JSON.parse(detail) as Readonly<Record<string, unknown>>;
}

/**
 * What an unconfirmed lowering pays: the gems per lowered tier of an achievement (migration 0122), or the levels an XP
 * table makes due and the gems each pays (migration 0124).
 */
function lowering(detail: unknown) {
  const parsed = detailOf(detail);
  return Object.hasOwn(parsed, "levels")
    ? confirmationRequired(xpTableLoweringSchema.parse(parsed))
    : confirmationRequired({ gems: loweredGemsSchema.parse(parsed) });
}

/** A CA409 that names its reason (migration 0124) as its own answer; a bare CA409 stays the console door's `stale`. */
function conflict(error: unknown, detail: unknown): unknown {
  if (typeof detail !== "string" || !detail.startsWith("{")) {
    return error;
  }
  const { reason, level } = detailOf(detail);
  const answer = Object.hasOwn(CATALOG_CONFLICTS, String(reason))
    ? CATALOG_CONFLICTS[reason as keyof typeof CATALOG_CONFLICTS]
    : undefined;
  // Stryker disable next-line ConditionalExpression: every reason 0124 raises is listed; an unknown one is a broken door
  if (answer === undefined) {
    throw new Error(`unknown catalog refusal ${String(reason)}; check migration 0124`);
  }
  return answer(level === undefined ? {} : { level });
}

/** A catalog door's own refusal as the admin's answer; anything else as it came. */
function catalogRefusal(error: unknown): unknown {
  const { code, detail } = error as { code?: unknown; detail?: unknown };
  if (code === "23514") {
    return invalidCatalog();
  }
  if (code === "CA428") {
    return lowering(detail);
  }
  return code === "CA409" ? conflict(error, detail) : error;
}

/**
 * Runs catalog work as a console door. A value outside a table's own bounds (a CHECK) is the admin's input, not a fault;
 * a lowering that was not confirmed answers what it would pay; a refusal with a reason answers that reason.
 */
export function catalogDoor<T>(
  pool: Pool,
  admin: Admin,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return door(pool, admin, async (client) => {
    try {
      return await work(client);
    } catch (error) {
      throw catalogRefusal(error);
    }
  });
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

/** The audit target of a row: its id, or the name of the single document. */
const auditIdOf = (editor: Editor, id: string): string =>
  editor.idField === undefined ? editor.auditId : id;

function withRevertible(editor: Editor, answer: unknown, undoable: ReadonlySet<string>): Answer[] {
  if (editor.idField === undefined) {
    return [{ ...(answer as Answer), revertible: undoable.has(editor.auditId) }];
  }
  const field = editor.idField;
  return (answer as Answer[]).map((row) => ({
    ...row,
    revertible: undoable.has(String(row[field])),
  }));
}

/** Every row of a catalog with whether it can be reverted. A single document answers one row. */
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
 * it again, writes the row and its audit entry in one transaction, and a save that changes nothing writes nothing. An
 * achievement whose threshold falls answers 409 `confirmation_required` with the gems it pays unless `confirmed`.
 */
export function saveCatalog(
  pool: Pool,
  admin: Admin,
  kind: CatalogKind,
  target: Readonly<{ id: string; input: unknown; requestId: string; confirmed?: boolean }>,
): Promise<unknown> {
  const editor = EDITORS[kind];
  return catalogDoor(pool, admin, async (client) => {
    const saved = await editor.save(client, {
      id: target.id,
      doc: target.input,
      revertOf: null,
      confirmed: target.confirmed === true,
      requestId: target.requestId,
    });
    return savedRow(client, editor, target.id, saved);
  });
}

/**
 * Puts back what the row held before its latest catalog change (the `before` of that audit entry), through the same save
 * door and checks, and audits it as a revert. A second revert undoes the first. 409 `nothing_to_revert` when the row was
 * never changed or its latest entry made it (a template that was new has nothing earlier; switch it off instead), and 409
 * `stale` when another admin changed the row after this read: the door gets the entry's id and re-reads it under the row's
 * lock, so it never puts back an older state over a newer change. A revert that lowers a threshold needs `confirmed`.
 */
export function revertCatalog(
  pool: Pool,
  admin: Admin,
  kind: CatalogKind,
  target: Readonly<{ id: string; requestId: string; confirmed?: boolean }>,
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
    const doc = editor.before.safeParse(latest.before);
    if (!doc.success) {
      throw invalidCatalog({ issues: doc.error.issues.map((issue) => issue.message) });
    }
    const saved = await editor.save(client, {
      id: target.id,
      doc: null,
      revertOf: latest.id,
      confirmed: target.confirmed === true,
      requestId: target.requestId,
    });
    return savedRow(client, editor, target.id, saved);
  });
}

/** The editor's schema for an admin's input, for the routes to check a body before the door sees it. */
export const docSchemaOf = (kind: CatalogKind): z.ZodType => EDITORS[kind].doc;

/** Whether the editor's saves and reverts take `confirmed` (a lowering pays gems that cannot come back). */
export const isConfirmable = (kind: CatalogKind): boolean => EDITORS[kind].confirmable;
