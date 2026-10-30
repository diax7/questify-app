import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { readEventTerms, type EventTerms } from "@questify/shared";

export type EventKind = "physical" | "virtual" | "workplace";
export type EventAccess = "public" | "unlisted" | "private";
export type JoinMethod = "code" | "qr" | "link" | "public_list";
export type EventStatus = "draft" | "scheduled" | "live" | "ended" | "archived";

/** The venue's pin (T-303b): optional, for the far-from-venue flag only. */
export type VenuePin = Readonly<{ lat: number; lng: number }>;

/** An event as the dashboard sees it. Times are instants; the zone says how to show them. */
export type EventRecord = Readonly<{
  id: string;
  joinCode: string;
  name: Readonly<{ ar: string | null; en: string | null }>;
  kind: EventKind;
  venue: Readonly<{ ar: string | null; en: string | null }>;
  access: EventAccess;
  joinMethods: readonly JoinMethod[];
  timezone: string;
  dayStartHour: number;
  startsAt: Date | null;
  endsAt: Date | null;
  status: EventStatus;
  /** The status at this moment, before the lifecycle tick catches up (migration 0009). */
  statusNow: EventStatus;
  createdAt: Date;
  /** The event's own ranking switch (FR-607); on unless the owner turned it off. */
  rankingOn: boolean;
  /** Today's ranking for a multi-day event (FR-608); on unless the owner turned it off. */
  rankingTodayOn: boolean;
  /** The event's share quests switch (FR-219, ADR-199). */
  shareQuestsOn: boolean;
  meetSomeoneOn: boolean;
  /** The event's mini-games switch (FR-1009, ADR-213). */
  miniGamesOn: boolean;
  /** The event's community quests switch (T-306b, ADR-226): off finishes its running goals. */
  communityOn: boolean;
  /** The event's flash quests switch (T-307, ADR-231): off hides and refuses every flash quest at once. */
  flashQuestsOn: boolean;
  /** The event's boosts switch (T-307, ADR-233): off stops every boost paying at once. */
  boostsOn: boolean;
  /** The event's help desk switch (T-310, ADR-248): off stops new tickets; open ones stay answerable. */
  helpDeskOn: boolean;
  /** The event's quest ratings switch (T-508, FR-1623): off until the owner turns it on. */
  questRatingsOn: boolean;
  /** The event's words (FR-404, FR-940), the defaults for any it did not set. */
  terms: EventTerms;
  /** The venue's pin, or null (T-303b); with its radius in metres. */
  venuePin: VenuePin | null;
  venueRadiusM: number;
  /** The event's city from the seeded list (T-403, ADR-277); none for a virtual event, fixed once live. */
  cityId: string | null;
  /** The event's interests from the catalog, at most 3, in catalog order (T-407, ADR-319). */
  interests: string[];
}>;

/** The fields the API may write (the column grants of migration 0009). */
export type EventFields = Readonly<{
  nameAr: string | null;
  nameEn: string | null;
  kind: EventKind;
  venueAr: string | null;
  venueEn: string | null;
  access: EventAccess;
  joinMethods: readonly JoinMethod[];
  timezone: string;
  dayStartHour: number;
  startsAt: Date;
  endsAt: Date;
  venuePin: VenuePin | null;
  venueRadiusM: number;
  cityId: string | null;
  interests: readonly string[];
}>;

type Row = {
  id: string;
  join_code: string;
  name_ar: string | null;
  name_en: string | null;
  kind: EventKind;
  venue_ar: string | null;
  venue_en: string | null;
  access: EventAccess;
  join_methods: JoinMethod[];
  timezone: string;
  day_start_hour: number;
  starts_at: Date | null;
  ends_at: Date | null;
  status: EventStatus;
  status_now: EventStatus;
  created_at: Date;
  ranking_on: boolean;
  ranking_today_on: boolean;
  share_quests_on: boolean;
  meet_someone_on: boolean;
  mini_games_on: boolean;
  community_on: boolean;
  flash_quests_on: boolean;
  boosts_on: boolean;
  help_desk_on: boolean;
  quest_ratings_on: boolean;
  terms: unknown;
  venue_lat: string | null;
  venue_lng: string | null;
  venue_radius_m: number;
  city_id: string | null;
  interests: string[];
};

const COLUMNS = `id, join_code, name_ar, name_en, kind, venue_ar, venue_en, access, join_methods, timezone,
  day_start_hour, starts_at, ends_at, status, event_status_now(status, starts_at, ends_at) AS status_now, created_at,
  coalesce((config -> 'features' ->> 'ranking')::boolean, true) AS ranking_on,
  coalesce((config -> 'features' ->> 'rankingToday')::boolean, true) AS ranking_today_on,
  coalesce((config -> 'features' ->> 'shareQuests')::boolean, true) AS share_quests_on,
  coalesce((config -> 'features' ->> 'meetSomeone')::boolean, true) AS meet_someone_on,
  coalesce((config -> 'features' ->> 'miniGames')::boolean, true) AS mini_games_on,
  coalesce((config -> 'features' ->> 'community')::boolean, true) AS community_on,
  coalesce((config -> 'features' ->> 'flashQuests')::boolean, true) AS flash_quests_on,
  coalesce((config -> 'features' ->> 'boosts')::boolean, true) AS boosts_on,
  coalesce((config -> 'features' ->> 'helpDesk')::boolean, true) AS help_desk_on,
  coalesce((config -> 'features' ->> 'questRatings')::boolean, false) AS quest_ratings_on, config -> 'terms' AS terms,
  venue_lat, venue_lng, venue_radius_m, city_id, interests`;

const toRecord = (row: Row): EventRecord => ({
  id: row.id,
  joinCode: row.join_code,
  name: { ar: row.name_ar, en: row.name_en },
  kind: row.kind,
  venue: { ar: row.venue_ar, en: row.venue_en },
  access: row.access,
  joinMethods: row.join_methods,
  timezone: row.timezone,
  dayStartHour: row.day_start_hour,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  status: row.status,
  statusNow: row.status_now,
  createdAt: row.created_at,
  rankingOn: row.ranking_on,
  rankingTodayOn: row.ranking_today_on,
  shareQuestsOn: row.share_quests_on,
  meetSomeoneOn: row.meet_someone_on,
  miniGamesOn: row.mini_games_on,
  communityOn: row.community_on,
  flashQuestsOn: row.flash_quests_on,
  boostsOn: row.boosts_on,
  helpDeskOn: row.help_desk_on,
  questRatingsOn: row.quest_ratings_on,
  terms: readEventTerms(row.terms),
  venuePin:
    row.venue_lat === null || row.venue_lng === null
      ? null
      : { lat: Number(row.venue_lat), lng: Number(row.venue_lng) },
  venueRadiusM: row.venue_radius_m,
  cityId: row.city_id,
  interests: row.interests,
});

/** The events the caller may see in their organizer (the database applies an editor's limit). */
export async function listEvents(db: PoolClient, organizerId: string): Promise<EventRecord[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM event WHERE organizer_id = $1 ORDER BY created_at DESC`,
    [organizerId],
  );
  return rows.map(toRecord);
}

/** One event; `lock` holds the row until the transaction ends, so an edit is never built on a stale read. */
export async function readEvent(
  db: PoolClient,
  organizerId: string,
  id: string,
  lock = false,
): Promise<EventRecord | undefined> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM event WHERE organizer_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
    [organizerId, id],
  );
  const row = rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/** Join codes avoid letters and digits people confuse (0 and O, 1, I and L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 5;

/** A fresh join code; replaced in tests to force a collision. */
export function newJoinCode(): string {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join("");
}

/**
 * Creates a draft with a fresh join code. A taken code is skipped without aborting the transaction (`ON CONFLICT DO
 * NOTHING`), and another is tried, up to five times.
 *
 * @throws Error when five codes in a row were taken (about one in 10^40 with today's events).
 */
export async function insertEvent(
  db: PoolClient,
  organizerId: string,
  fields: EventFields,
  codes: () => string = newJoinCode,
): Promise<EventRecord> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const { rows } = await db.query<Row>(
      `INSERT INTO event (organizer_id, join_code, name_ar, name_en, kind, venue_ar, venue_en, access, join_methods,
                          timezone, day_start_hour, starts_at, ends_at, venue_lat, venue_lng, venue_radius_m, city_id, interests)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        organizerId,
        codes(),
        fields.nameAr,
        fields.nameEn,
        fields.kind,
        fields.venueAr,
        fields.venueEn,
        fields.access,
        fields.joinMethods,
        fields.timezone,
        fields.dayStartHour,
        fields.startsAt,
        fields.endsAt,
        fields.venuePin?.lat ?? null,
        fields.venuePin?.lng ?? null,
        fields.venueRadiusM,
        fields.cityId,
        fields.interests,
      ],
    );
    const row = rows[0];
    if (row !== undefined) {
      return toRecord(row);
    }
  }
  throw new Error(`No free join code after ${CODE_ATTEMPTS} attempts; nothing was created.`);
}

export async function updateEvent(
  db: PoolClient,
  organizerId: string,
  id: string,
  fields: EventFields,
): Promise<EventRecord | undefined> {
  // A time read into JavaScript loses its microseconds; one sent back unchanged keeps the stored value, or the times
  // guard (migration 0009) would see a change to an event that has started.
  const { rows } = await db.query<Row>(
    `UPDATE event SET name_ar = $3, name_en = $4, kind = $5, venue_ar = $6, venue_en = $7, access = $8,
                      join_methods = $9, timezone = $10, day_start_hour = $11,
                      starts_at = CASE WHEN date_trunc('milliseconds', starts_at) = $12 THEN starts_at ELSE $12 END,
                      ends_at = CASE WHEN date_trunc('milliseconds', ends_at) = $13 THEN ends_at ELSE $13 END,
                      venue_lat = $14, venue_lng = $15, venue_radius_m = $16, city_id = $17, interests = $18
     WHERE organizer_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [
      organizerId,
      id,
      fields.nameAr,
      fields.nameEn,
      fields.kind,
      fields.venueAr,
      fields.venueEn,
      fields.access,
      fields.joinMethods,
      fields.timezone,
      fields.dayStartHour,
      fields.startsAt,
      fields.endsAt,
      fields.venuePin?.lat ?? null,
      fields.venuePin?.lng ?? null,
      fields.venueRadiusM,
      fields.cityId,
      fields.interests,
    ],
  );
  const row = rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/** Deletes a draft (the policy refuses any other status). Returns false when nothing was deleted. */
export async function deleteDraft(
  db: PoolClient,
  organizerId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await db.query("DELETE FROM event WHERE organizer_id = $1 AND id = $2", [
    organizerId,
    id,
  ]);
  return rowCount === 1;
}
