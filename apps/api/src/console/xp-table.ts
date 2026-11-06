import { itemAdminSchema, xpTablePreviewSchema, type XpTablePreview } from "@questify/shared";
import type { Pool } from "pg";
import { catalogDoor } from "#src/console/catalog";
import type { Admin } from "#src/console/doors";

/**
 * What an XP table would do to active players now (T-709d, ADR-440): how many go up and down a level, the level rewards
 * that fall due at their next sync. Read only and advisory (the console says "about"); the caller
 * has checked the document against the shared schema and the door checks it again (CA400).
 */
export function previewXpTable(pool: Pool, admin: Admin, doc: unknown): Promise<XpTablePreview> {
  return catalogDoor(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: unknown }>("SELECT admin_xp_table_preview($1) AS r", [
      doc,
    ]);
    return xpTablePreviewSchema.parse(rows[0]?.r);
  });
}

/**
 * Makes a new Questify item (T-709d, ADR-441), audited as
 * `catalog.item.create`. 409 `item_exists` when the id is taken. A new item has nothing to revert to.
 */
export function createItem(
  pool: Pool,
  admin: Admin,
  input: Readonly<{ doc: unknown; requestId: string }>,
): Promise<unknown> {
  return catalogDoor(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: Readonly<Record<string, unknown>> }>(
      "SELECT admin_item_create($1, $2) AS r",
      [input.doc, input.requestId],
    );
    return itemAdminSchema.parse({ ...rows[0]?.r, revertible: false });
  });
}
