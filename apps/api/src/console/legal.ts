import {
  helpAdminSchema,
  helpDocSchema,
  legalAdminListSchema,
  type HelpAdmin,
  type HelpDoc,
  type LegalAdminList,
  type LegalDocumentId,
  type LegalPublish,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { invalidCatalog, nothingToRevert } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";

/** The audit target type of a help article (migration 0123), as the catalog's revert reads it. */
const HELP_TARGET = "help_article";

async function answerOf(client: PoolClient, sql: string, values: unknown[] = []): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

/** Every legal document with its versions, newest first, and which one is in force. */
export function listLegal(pool: Pool, admin: Admin): Promise<LegalAdminList> {
  return door(pool, admin, async (client) =>
    legalAdminListSchema.parse({
      documents: await answerOf(client, "SELECT admin_legal_list() AS r"),
    }),
  );
}

/**
 * Publishes a version of a document (FR-1781): in force at once, so players are asked at their next launch and an
 * organizer's team is held until the owner accepts. A version not later than the one in force is refused (409).
 */
export function publishLegal(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ document: LegalDocumentId; input: LegalPublish; requestId: string }>,
): Promise<Readonly<{ document: string; version: string; publishedAt: string }>> {
  const { input } = target;
  return door(pool, admin, async (client) => {
    const answer = await answerOf(
      client,
      "SELECT admin_legal_publish($1, $2, $3, $4, $5, $6) AS r",
      [
        target.document,
        input.version,
        input.text.ar,
        input.text.en,
        input.note ?? null,
        target.requestId,
      ],
    );
    return answer as { document: string; version: string; publishedAt: string };
  });
}

/** The articles whose latest change has an earlier state to go back to (a new article has none). */
async function revertibleHelp(client: PoolClient): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<{ target_id: string }>(
    `SELECT target_id FROM (
       SELECT DISTINCT ON (target_id) target_id, before FROM audit_log
       WHERE target_type = $1 AND action LIKE 'catalog.%' AND target_id IS NOT NULL
       ORDER BY target_id, id DESC) latest
     WHERE before IS NOT NULL`,
    [HELP_TARGET],
  );
  return new Set(rows.map((row) => row.target_id));
}

const asRow = (row: unknown, undoable: ReadonlySet<string>): HelpAdmin => {
  const id = (row as { id: string }).id;
  return helpAdminSchema.parse({ ...(row as object), revertible: undoable.has(id) });
};

/** Every help article, the unpublished ones too, with whether each can be reverted. */
export function listHelp(pool: Pool, admin: Admin): Promise<HelpAdmin[]> {
  return door(pool, admin, async (client) => {
    const rows = (await answerOf(client, "SELECT admin_help_articles() AS r")) as unknown[];
    const undoable = await revertibleHelp(client);
    return rows.map((row) => asRow(row, undoable));
  });
}

/** Saves one article (made when the id is new). The caller has checked `doc`; the door checks it again and audits it. */
export function saveHelp(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ id: string; doc: HelpDoc; requestId: string }>,
): Promise<HelpAdmin> {
  return door(pool, admin, async (client) => {
    const saved = await answerOf(client, "SELECT admin_help_article_save($1, $2, NULL, $3) AS r", [
      target.id,
      target.doc,
      target.requestId,
    ]);
    return asRow(saved, await revertibleHelp(client));
  });
}

/**
 * Puts back what the article held before its latest change, through the same save door and checks (a second revert undoes
 * the first). 409 `nothing_to_revert` for an article never changed, 409 `stale` when it changed after this read.
 */
export function revertHelp(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ id: string; requestId: string }>,
): Promise<HelpAdmin> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ id: string; before: unknown }>(
      `SELECT id, before FROM audit_log
       WHERE target_type = $1 AND target_id = $2 AND action LIKE 'catalog.%'
       ORDER BY id DESC LIMIT 1`,
      [HELP_TARGET, target.id],
    );
    const latest = rows[0];
    if (latest === undefined || latest.before === null) {
      throw nothingToRevert();
    }
    const earlier = helpDocSchema.safeParse(latest.before);
    if (!earlier.success) {
      throw invalidCatalog({ issues: earlier.error.issues.map((issue) => issue.message) });
    }
    const saved = await answerOf(client, "SELECT admin_help_article_save($1, NULL, $2, $3) AS r", [
      target.id,
      latest.id,
      target.requestId,
    ]);
    return asRow(saved, await revertibleHelp(client));
  });
}
