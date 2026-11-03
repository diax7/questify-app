import {
  groupPushPreviewSchema,
  groupPushViewSchema,
  type GroupPushBody,
  type GroupPushPreview,
  type GroupPushView,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { door, type Admin } from "#src/console/doors";

async function answerOf(client: PoolClient, sql: string, values: unknown[] = []): Promise<unknown> {
  const { rows } = await client.query<{ r: unknown }>(sql, values);
  return rows[0]?.r;
}

/**
 * Who a send would reach, before it is sent (migration 0138, `admin_group_push_preview`): the event named by a join code
 * with its status, or the count of opted-in players not yet told this week. Read only; the database checks the admin
 * and the whole draft again.
 */
export function previewGroupPush(
  pool: Pool,
  admin: Admin,
  body: GroupPushBody,
): Promise<GroupPushPreview> {
  return door(pool, admin, async (client) =>
    groupPushPreviewSchema.parse(
      await answerOf(client, "SELECT admin_group_push_preview($1) AS r", [body]),
    ),
  );
}

/**
 * Sends the push (`admin_group_push_send`): the database refuses a draft that breaks a rule, an audience of nobody and
 * the 21st send in an hour, writes the record and audits it. An event's push is one notice the push store fans out; a
 * promotional push is written a page of players at a time by the push worker.
 */
export function sendGroupPush(
  pool: Pool,
  admin: Admin,
  target: Readonly<{ body: GroupPushBody; requestId: string }>,
): Promise<GroupPushView> {
  return door(pool, admin, async (client) =>
    groupPushViewSchema.parse(
      await answerOf(client, "SELECT admin_group_push_send($1, $2) AS r", [
        target.body,
        target.requestId,
      ]),
    ),
  );
}

/** The last 50 sends, newest first, with how far each has got. */
export function listGroupPushes(pool: Pool, admin: Admin): Promise<GroupPushView[]> {
  return door(pool, admin, async (client) =>
    z
      .array(groupPushViewSchema)
      .parse(await answerOf(client, "SELECT admin_group_push_list() AS r")),
  );
}
