import type { Client, Pool, PoolClient } from "pg";
import { setLocalSettings } from "#src/db/connection";

/** Who is making the request. The database reads this to apply row-level security. */
export type RequestContext = Readonly<{
  organizerId?: string;
  playerId?: string;
  staffUserId?: string;
  isAdmin?: boolean;
  /** A paired station, kiosk or big screen (T-309): set only by the device guard from the row it found. */
  deviceId?: string;
  /**
   * A support admin's view of an organizer (T-712, ADR-521): the transaction opens READ ONLY, the only kind in which the
   * database honours a `view` grant. Set by the organizer scope's hook, never by a client.
   */
  readOnly?: true;
  /**
   * One snapshot for the whole transaction (REPEATABLE READ): set only by a service whose database door asks for it, the
   * duplicate's `event_copy_setup` (ADR-739). A serialization failure (40001) is the caller's to retry.
   */
  repeatableRead?: true;
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

function settingsOf(context: RequestContext): [string, string][] {
  return [
    ["app.organizer_id", checkedId("organizerId", context.organizerId)],
    ["app.player_id", checkedId("playerId", context.playerId)],
    ["app.staff_user_id", checkedId("staffUserId", context.staffUserId)],
    ["app.is_admin", context.isAdmin === true ? "on" : ""],
    ["app.device_id", checkedId("deviceId", context.deviceId)],
  ];
}

/** `BEGIN READ ONLY` for a support view (ADR-521), `ISOLATION LEVEL REPEATABLE READ` when asked (ADR-739). */
const beginOf = (context: RequestContext): string =>
  [
    "BEGIN",
    ...(context.repeatableRead === true ? ["ISOLATION LEVEL REPEATABLE READ"] : []),
    ...(context.readOnly === true ? ["READ ONLY"] : []),
  ].join(" ");

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
  const values = settingsOf(context);
  await client.query(beginOf(context));
  try {
    await setLocalSettings(client, values);
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Runs `work` on a connection of `pool` in one transaction with `context`, then always rolls it back, never commits,
 * on success and on error (the practice scan's API wall, ADR-249). When the rollback itself fails, the connection is
 * released with that error so the pool destroys it rather than lend out a transaction left open.
 *
 * @throws RangeError when an id is not a UUID. Rethrows what `work` throws, or the rollback's own failure.
 */
export async function withRolledBackContext<T>(
  pool: Pool,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const values = settingsOf(context);
  const client = await pool.connect();
  let outcome: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>;
  try {
    await client.query(beginOf(context));
    await setLocalSettings(client, values);
    outcome = { ok: true, value: await work(client) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    const broken = error instanceof Error ? error : new Error(String(error));
    client.release(broken);
    throw broken;
  }
  client.release();
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
