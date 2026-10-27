import {
  STREAK_CONFLICTS,
  STREAK_FIELDS,
  type DailyStreak,
  type EventStreak,
  type StreakBonus,
  type StreakConflictReason,
  type StreakField,
  type StreakSettings,
  type StreakSettingsBody,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";

export type StreakDeps = Readonly<{ pool: Pool }>;

/** Why the settings door refused (migration 0068); each maps to one HTTP answer in the routes. */
export type StreakRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "conflict"; reason: StreakConflictReason; day: string | null }>
  | Readonly<{ kind: "invalid"; field: StreakField }>;

export type StreakDone<T> = Readonly<{ kind: "done"; value: T }> | StreakRefusal;

type PgError = Readonly<{ code?: string; detail?: string; hint?: string }>;

const reasonOf = (detail: string | undefined): StreakConflictReason | undefined =>
  STREAK_CONFLICTS.find((reason) => reason === detail);
const fieldOf = (detail: string | undefined): StreakField | undefined =>
  STREAK_FIELDS.find((field) => field === detail);

/**
 * The SQLSTATEs of migration 0068's settings door as refusals; undefined for anything else. AN404 is a missing event,
 * another organizer's or an editor's write (the owner check answers it the same, so no event is confirmed to exist).
 */
export function streakRefusalOf(pg: PgError): StreakRefusal | undefined {
  switch (pg.code) {
    case "AN404":
      return { kind: "not_found" };
    case "RF409":
      return { kind: "conflict", reason: "results_final", day: null };
    case "ST409": {
      const reason = reasonOf(pg.detail);
      if (reason === undefined) {
        return undefined;
      }
      return { kind: "conflict", reason, day: reason === "day_started" ? (pg.hint ?? null) : null };
    }
    case "ST422": {
      const field = fieldOf(pg.detail);
      return field === undefined ? undefined : { kind: "invalid", field };
    }
    default:
      return undefined;
  }
}

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
async function asTeam<T>(
  deps: StreakDeps,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<StreakDone<T>> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const refusal = streakRefusalOf(error as PgError);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

async function settingsOf(client: PoolClient, eventId: string): Promise<StreakSettings> {
  const { rows } = await client.query<{ s: StreakSettings }>(
    "SELECT event_streak_settings($1) AS s",
    [eventId],
  );
  const settings = rows[0]?.s;
  // event_streak_settings answers one object or raises AN404; a missing one is a server fault.
  if (settings === undefined) {
    throw new Error("event_streak_settings answered no row");
  }
  return settings;
}

/** The event's streak settings for its owners and editors (`event_streak_settings`). */
export function readStreakSettings(
  deps: StreakDeps,
  context: OrganizerContext,
  eventId: string,
): Promise<StreakDone<StreakSettings>> {
  return asTeam(deps, context, (client) => settingsOf(client, eventId));
}

export type StreakSaved = Readonly<{ settings: StreakSettings; replayed: boolean }>;

/**
 * Saves the event's streak for an owner (`set_event_streak`, audited by the database) and answers it as stored;
 * `replayed` when the settings were already these (nothing written).
 */
export function saveStreakSettings(
  deps: StreakDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; body: StreakSettingsBody; requestId: string }>,
): Promise<StreakDone<StreakSaved>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: "set" | "unchanged" }>(
      "SELECT set_event_streak($1, $2, $3, $4, $5, $6) AS outcome",
      [
        request.eventId,
        request.body.enabled,
        request.body.bonusPoints,
        request.body.closedWeekdays,
        request.body.closedDays,
        request.requestId,
      ],
    );
    return {
      settings: await settingsOf(client, request.eventId),
      replayed: rows[0]?.outcome === "unchanged",
    };
  });
}

type OwnStreakRow = Readonly<{
  is_on: boolean;
  days: number;
  played_today: boolean;
  closed_today: boolean;
  bonus_points: number | null;
}>;

/**
 * The calling member's own event streak for event Home (`own_event_streak`): null while it is off (switched off, a
 * single-day event, or the event not live) and for anyone who is not an active member.
 */
export async function readOwnEventStreak(
  client: PoolClient,
  eventId: string,
): Promise<EventStreak | null> {
  const { rows } = await client.query<OwnStreakRow>("SELECT * FROM own_event_streak($1)", [
    eventId,
  ]);
  const row = rows[0];
  if (row === undefined || !row.is_on) {
    return null;
  }
  return {
    days: row.days,
    playedToday: row.played_today,
    closedToday: row.closed_today,
    bonusPoints: row.bonus_points,
  };
}

/** The streak bonus the caller's own completion paid (`own_streak_bonus`), or null; the same on a replay. */
export async function streakBonusPaid(
  client: PoolClient,
  completionId: string,
): Promise<StreakBonus | null> {
  const { rows } = await client.query<StreakBonus>("SELECT * FROM own_streak_bonus($1)", [
    completionId,
  ]);
  return rows[0] ?? null;
}

/** The caller's Questify daily streak (`own_daily_streak`): null while the platform switch is off. */
export async function readOwnDailyStreak(client: PoolClient): Promise<DailyStreak | null> {
  const { rows } = await client.query<{ s: DailyStreak | null }>("SELECT own_daily_streak() AS s");
  return rows[0]?.s ?? null;
}

/** Logs the streak bonus a fresh payment paid (`completion.streak_bonus {days}`, never the player); nothing on a replay. */
export function logStreakBonus(
  log: Readonly<{ info: (fields: Record<string, unknown>) => void }>,
  paid: Readonly<{ replayed: boolean; streakBonus: StreakBonus | null }> | null,
): void {
  if (paid !== null && paid.streakBonus !== null && !paid.replayed) {
    log.info({ event: "completion.streak_bonus", days: paid.streakBonus.days });
  }
}
