import type { Client, PoolClient } from "pg";

type Db = Client | PoolClient;

/** The stored blocks of the platform settings, exactly as the database holds them. */
export async function readStoredPlatform(
  db: Db,
): Promise<{ features?: unknown; tuning?: unknown }> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    "SELECT key, value FROM platform_setting WHERE key IN ('features', 'tuning')",
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/** An event's stored config, or undefined when the caller cannot see such an event. */
export async function readStoredEventConfig(db: Db, eventId: string): Promise<unknown | undefined> {
  const { rows } = await db.query<{ config: unknown }>("SELECT config FROM event WHERE id = $1", [
    eventId,
  ]);
  return rows[0] === undefined ? undefined : rows[0].config;
}

export async function readEntitlements(db: Db, eventId: string): Promise<string[]> {
  const { rows } = await db.query<{ feature: string }>(
    "SELECT feature FROM event_entitlement WHERE event_id = $1 ORDER BY feature",
    [eventId],
  );
  return rows.map((row) => row.feature);
}

export async function upsertPlatformBlock(
  db: Db,
  key: "features" | "tuning",
  value: unknown,
  adminId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO platform_setting (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), adminId],
  );
}

/** Replaces the feature switches inside an event's config and keeps whatever else it holds. */
export async function writeEventSwitches(
  db: Db,
  eventId: string,
  switches: Readonly<Record<string, boolean>>,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE event
     SET config = jsonb_set(config, '{features}', $2::jsonb, true), config_version = config_version + 1
     WHERE id = $1`,
    [eventId, JSON.stringify(switches)],
  );
  return rowCount === 1;
}

/** Records that Questify unlocked an add-on for an event (a repeat changes nothing). False when the event does not exist. */
export async function insertEntitlement(
  db: Db,
  eventId: string,
  feature: string,
  adminId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ found: number }>(
    `WITH target AS (SELECT id, organizer_id FROM event WHERE id = $1),
          added AS (
            INSERT INTO event_entitlement (event_id, organizer_id, feature, granted_by)
            SELECT id, organizer_id, $2, $3 FROM target
            ON CONFLICT (event_id, feature) DO NOTHING
          )
     SELECT count(*)::int AS found FROM target`,
    [eventId, feature, adminId],
  );
  return rows[0]?.found === 1;
}

/** Removes an unlock. False when there was nothing to remove. */
export async function deleteEntitlement(
  db: Db,
  eventId: string,
  feature: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM event_entitlement WHERE event_id = $1 AND feature = $2",
    [eventId, feature],
  );
  return rowCount === 1;
}
