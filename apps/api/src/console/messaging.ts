import {
  messageTemplateAdminSchema,
  messageTemplateDocSchema,
  supportContactAdminSchema,
  type MessageTemplateAdmin,
  type MessageTemplateDoc,
  type MessageTemplateKey,
  type SupportContact,
  type SupportContactAdmin,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { invalidCatalog, nothingToRevert } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";

/** The audit target type of a template (migration 0127), as the catalog's revert reads it. */
const TEMPLATE_TARGET = "message_template";

async function answerOf(client: PoolClient, sql: string, values: unknown[] = []): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

/** The templates whose latest change has an earlier state to go back to (an unchanged seed has none). */
async function revertibleTemplates(client: PoolClient): Promise<ReadonlySet<string>> {
  const { rows } = await client.query<{ target_id: string }>(
    `SELECT target_id FROM (
       SELECT DISTINCT ON (target_id) target_id, before FROM audit_log
       WHERE target_type = $1 AND action LIKE 'catalog.%' AND target_id IS NOT NULL
       ORDER BY target_id, id DESC) latest
     WHERE before IS NOT NULL`,
    [TEMPLATE_TARGET],
  );
  return new Set(rows.map((row) => row.target_id));
}

const asRow = (row: unknown, undoable: ReadonlySet<string>): MessageTemplateAdmin => {
  const key = (row as { key: string }).key;
  return messageTemplateAdminSchema.parse({ ...(row as object), revertible: undoable.has(key) });
};

/** Every message template with whether each can be reverted. */
export function listTemplates(pool: Pool, admin: Admin): Promise<MessageTemplateAdmin[]> {
  return door(pool, admin, async (client) => {
    const rows = (await answerOf(client, "SELECT admin_message_templates() AS r")) as unknown[];
    const undoable = await revertibleTemplates(client);
    return rows.map((row) => asRow(row, undoable));
  });
}

/**
 * Saves one template. The caller has checked `doc` against the CST rules; the door checks the structure again (the
 * opt-out and code placeholders, the lengths) and audits the change.
 */
export function saveTemplate(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ key: MessageTemplateKey; doc: MessageTemplateDoc; requestId: string }>,
): Promise<MessageTemplateAdmin> {
  return door(pool, admin, async (client) => {
    const saved = await answerOf(
      client,
      "SELECT admin_message_template_save($1, $2, NULL, $3) AS r",
      [target.key, target.doc, target.requestId],
    );
    return asRow(saved, await revertibleTemplates(client));
  });
}

/**
 * Puts back what the template held before its latest change, through the same save door (a second revert undoes the
 * first). The earlier text is checked against the rules again: a rule that changed since is refused, not saved.
 * 409 `nothing_to_revert` for a template never changed, 409 `stale` when it changed after this read.
 */
export function revertTemplate(
  pool: Pool,
  admin: Admin,
  target: Readonly<{
    key: MessageTemplateKey;
    requestId: string;
    check: (doc: MessageTemplateDoc) => void;
  }>,
): Promise<MessageTemplateAdmin> {
  return door(pool, admin, async (client) => {
    const { rows } = await client.query<{ id: string; before: unknown }>(
      `SELECT id, before FROM audit_log
       WHERE target_type = $1 AND target_id = $2 AND action LIKE 'catalog.%'
       ORDER BY id DESC LIMIT 1`,
      [TEMPLATE_TARGET, target.key],
    );
    const latest = rows[0];
    if (latest === undefined || latest.before === null) {
      throw nothingToRevert();
    }
    const earlier = messageTemplateDocSchema.safeParse(latest.before);
    if (!earlier.success) {
      throw invalidCatalog({ issues: earlier.error.issues.map((issue) => issue.message) });
    }
    target.check(earlier.data);
    const saved = await answerOf(
      client,
      "SELECT admin_message_template_save($1, NULL, $2, $3) AS r",
      [target.key, latest.id, target.requestId],
    );
    return asRow(saved, await revertibleTemplates(client));
  });
}

/** The support contact as an admin sees it. */
export function readSupportContact(pool: Pool, admin: Admin): Promise<SupportContactAdmin> {
  return door(pool, admin, async (client) =>
    supportContactAdminSchema.parse(await answerOf(client, "SELECT admin_support_contact() AS r")),
  );
}

/** Saves the three fields at once; an empty one is cleared. The door checks each pattern again and audits the change. */
export function saveSupportContact(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ contact: SupportContact; requestId: string }>,
): Promise<SupportContactAdmin> {
  return door(pool, admin, async (client) =>
    supportContactAdminSchema.parse(
      await answerOf(client, "SELECT admin_support_contact_save($1, $2) AS r", [
        target.contact,
        target.requestId,
      ]),
    ),
  );
}
