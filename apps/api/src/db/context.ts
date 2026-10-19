import type { Client, PoolClient } from "pg";

/** Who is making the request. The database reads this to apply row-level security. */
export type RequestContext = Readonly<{
  organizerId?: string;
  playerId?: string;
  staffUserId?: string;
  isAdmin?: boolean;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkedId(name: string, value: string | undefined): string {
  if (value === undefined) {
    return "";
  }
  if (!UUID.test(value)) {
    throw new RangeError(`${name} must be a UUID.`);
  }
  return value;
}

/**
 * Runs `work` in one transaction whose row-level-security context is `context`.
 * Every context value is set each time, so nothing from an earlier request can leak into this one.
 *
 * @throws RangeError when an id is not a UUID. Rolls back and rethrows when `work` fails.
 */
export async function withRequestContext<T>(
  client: Client | PoolClient,
  context: RequestContext,
  work: () => Promise<T>,
): Promise<T> {
  const values: [string, string][] = [
    ["app.organizer_id", checkedId("organizerId", context.organizerId)],
    ["app.player_id", checkedId("playerId", context.playerId)],
    ["app.staff_user_id", checkedId("staffUserId", context.staffUserId)],
    ["app.is_admin", context.isAdmin === true ? "on" : ""],
  ];
  await client.query("BEGIN");
  try {
    for (const [name, value] of values) {
      await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
