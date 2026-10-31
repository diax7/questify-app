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

/** The stored blocks, locked until the transaction ends, so the audit's "before" is what this save replaces. */
export async function lockPlatformBlocks(
  db: Db,
  keys: readonly ("features" | "tuning")[],
): Promise<Partial<Record<"features" | "tuning", unknown>>> {
  const { rows } = await db.query<{ key: "features" | "tuning"; value: unknown }>(
    "SELECT key, value FROM platform_setting WHERE key = ANY($1) FOR UPDATE",
    [keys],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
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

/** An event's current feature switches, locked until the transaction ends. Undefined when the caller cannot see it. */
export async function lockEventSwitches(
  db: Db,
  eventId: string,
): Promise<{ organizerId: string; features: unknown } | undefined> {
  const { rows } = await db.query<{ organizer_id: string; features: unknown }>(
    "SELECT organizer_id, config -> 'features' AS features FROM event WHERE id = $1 FOR UPDATE",
    [eventId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { organizerId: row.organizer_id, features: row.features };
}

/** Replaces the feature switches inside an event's config and keeps whatever else it holds. */
export async function writeEventSwitches(
  db: Db,
  eventId: string,
  switches: Readonly<Record<string, boolean>>,
): Promise<void> {
  await db.query(
    `UPDATE event
     SET config = jsonb_set(config, '{features}', $2::jsonb, true), config_version = config_version + 1
     WHERE id = $1`,
    [eventId, JSON.stringify(switches)],
  );
}

/** An event's stored words, locked until the transaction ends. Undefined when the caller cannot see the event. */
export async function lockEventTerms(
  db: Db,
  eventId: string,
): Promise<{ organizerId: string; terms: unknown; archived: boolean } | undefined> {
  const { rows } = await db.query<{ organizer_id: string; terms: unknown; archived: boolean }>(
    `SELECT organizer_id, config -> 'terms' AS terms, status = 'archived' AS archived
     FROM event WHERE id = $1 FOR UPDATE`,
    [eventId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { organizerId: row.organizer_id, terms: row.terms, archived: row.archived };
}

/** Replaces the words inside an event's config and keeps whatever else it holds. */
export async function writeEventTerms(db: Db, eventId: string, terms: unknown): Promise<void> {
  await db.query(
    `UPDATE event
     SET config = jsonb_set(config, '{terms}', $2::jsonb, true), config_version = config_version + 1
     WHERE id = $1`,
    [eventId, JSON.stringify(terms)],
  );
}

/** An event's stored look, locked until the transaction ends. Undefined when the caller cannot see the event. */
export async function lockEventBranding(
  db: Db,
  eventId: string,
): Promise<{ organizerId: string; branding: unknown; archived: boolean } | undefined> {
  const { rows } = await db.query<{ organizer_id: string; branding: unknown; archived: boolean }>(
    `SELECT organizer_id, config -> 'branding' AS branding, status = 'archived' AS archived
     FROM event WHERE id = $1 FOR UPDATE`,
    [eventId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { organizerId: row.organizer_id, branding: row.branding, archived: row.archived };
}

/** Replaces the look inside an event's config and keeps whatever else it holds. */
export async function writeEventBranding(
  db: Db,
  eventId: string,
  branding: unknown,
): Promise<void> {
  await db.query(
    `UPDATE event
     SET config = jsonb_set(config, '{branding}', $2::jsonb, true), config_version = config_version + 1
     WHERE id = $1`,
    [eventId, JSON.stringify(branding)],
  );
}

/** An event's stored layout, locked until the transaction ends. Undefined when the caller cannot see the event. */
export async function lockEventLayout(
  db: Db,
  eventId: string,
): Promise<{ organizerId: string; layout: unknown; archived: boolean } | undefined> {
  const { rows } = await db.query<{ organizer_id: string; layout: unknown; archived: boolean }>(
    `SELECT organizer_id, config -> 'layout' AS layout, status = 'archived' AS archived
     FROM event WHERE id = $1 FOR UPDATE`,
    [eventId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { organizerId: row.organizer_id, layout: row.layout, archived: row.archived };
}

/** Replaces the layout inside an event's config and keeps whatever else it holds. */
export async function writeEventLayout(db: Db, eventId: string, layout: unknown): Promise<void> {
  await db.query(
    `UPDATE event
     SET config = jsonb_set(config, '{layout}', $2::jsonb, true), config_version = config_version + 1
     WHERE id = $1`,
    [eventId, JSON.stringify(layout)],
  );
}

export type EntitlementChange =
  | Readonly<{ kind: "no_event" }>
  | Readonly<{ kind: "added" | "already"; organizerId: string }>;

/** Records that Questify unlocked an add-on for an event, and says whether it was new. */
export async function insertEntitlement(
  db: Db,
  eventId: string,
  feature: string,
  adminId: string,
): Promise<EntitlementChange> {
  const { rows } = await db.query<{ organizer_id: string | null; added: number }>(
    `WITH target AS (SELECT id, organizer_id FROM event WHERE id = $1),
          added AS (
            INSERT INTO event_entitlement (event_id, organizer_id, feature, granted_by)
            SELECT id, organizer_id, $2, $3 FROM target
            ON CONFLICT (event_id, feature) DO NOTHING
            RETURNING 1
          )
     SELECT (SELECT organizer_id FROM target) AS organizer_id, (SELECT count(*)::int FROM added) AS added`,
    [eventId, feature, adminId],
  );
  const row = rows[0];
  if (row?.organizer_id === null || row === undefined) {
    return { kind: "no_event" };
  }
  return { kind: row.added === 1 ? "added" : "already", organizerId: row.organizer_id };
}

/** Removes an unlock and returns the event's organizer, or undefined when there was nothing to remove. */
export async function deleteEntitlement(
  db: Db,
  eventId: string,
  feature: string,
): Promise<string | undefined> {
  const { rows } = await db.query<{ organizer_id: string }>(
    "DELETE FROM event_entitlement WHERE event_id = $1 AND feature = $2 RETURNING organizer_id",
    [eventId, feature],
  );
  return rows[0]?.organizer_id;
}
