import type { Pool, PoolClient } from "pg";
import { bigScreenOff, finaleStarted, invalidFinale, ownerOnly } from "#src/auth/http-errors";
import { inDevice } from "#src/devices/errors";
import type { HttpError } from "#src/http-error";

/** Where the event's results stand, as the Results page reads it (`results_state`). */
export type ResultsState = "not_ended" | "open" | "confirmed" | "revealed";

/** The finale as the Finale section shows it; `goal` is the attached community goal, if any. */
export type FinaleReading = Readonly<{
  /** Whether the big-screen add-on is active; the finale cannot be set while it is not. */
  enabled: boolean;
  endsAt: string | null;
  state: ResultsState;
  finale: Readonly<{
    startsAt: string;
    started: boolean;
    goalId: string | null;
    goal: Readonly<{
      title: Readonly<{ ar: string | null; en: string | null }>;
      status: string;
      startsAt: string;
      endsAt: string;
    }> | null;
  }> | null;
}>;

type Owner = Readonly<{ organizerId: string; staffUserId: string }>;

type PgError = Readonly<{ code?: string; detail?: string }>;

/** The refusals of migration 0084's team doors as HTTP answers; undefined for anything else. */
const refusalOf = (pg: PgError): HttpError | undefined => {
  switch (pg.code) {
    case "BS403":
      return bigScreenOff();
    case "LF403":
      return ownerOnly();
    case "LF409":
      return finaleStarted();
    case "LF422":
      return invalidFinale({ field: pg.detail ?? "startsAt" });
    default:
      return undefined;
  }
};

/** One call as the team member, with the database's own refusals turned into their answers. */
async function asTeam<T>(
  pool: Pool,
  team: Owner,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await inDevice(pool, team, work);
  } catch (error) {
    throw refusalOf(error as PgError) ?? error;
  }
}

const readingOf = (rows: readonly { reading: unknown }[]): FinaleReading =>
  (rows[0] as { reading: FinaleReading }).reading;

/**
 * The event's finale for its team (FR-254): the time, the goal, the add-on and where the results stand.
 *
 * @throws HttpError not_found for another organizer's event.
 */
export function readFinale(pool: Pool, team: Owner, eventId: string): Promise<FinaleReading> {
  return asTeam(pool, team, async (client) =>
    readingOf((await client.query("SELECT event_finale($1) AS reading", [eventId])).rows),
  );
}

/**
 * Sets the finale's time and, optionally, the community goal that is its last push (FR-1621). Owner only; audited.
 *
 * @throws HttpError big_screen_off while the add-on is not active, owner_only, finale_started once the time has come,
 *   invalid_finale for a time outside the event's window or a goal that is not this event's, is final or closes before
 *   the finale starts, not_found for another organizer's event.
 */
export function saveFinale(
  pool: Pool,
  team: Owner,
  change: Readonly<{
    eventId: string;
    startsAt: Date;
    goalId: string | null;
    requestId: string;
  }>,
): Promise<FinaleReading> {
  return asTeam(pool, team, async (client) =>
    readingOf(
      (
        await client.query("SELECT set_finale($1, $2, $3, $4) AS reading", [
          change.eventId,
          change.startsAt,
          change.goalId,
          change.requestId,
        ])
      ).rows,
    ),
  );
}

/**
 * Removes the finale, before or after it started. Owner only; audited when there was one.
 *
 * @throws HttpError owner_only, not_found for another organizer's event.
 */
export function clearFinale(
  pool: Pool,
  team: Owner,
  change: Readonly<{ eventId: string; requestId: string }>,
): Promise<FinaleReading> {
  return asTeam(pool, team, async (client) =>
    readingOf(
      (
        await client.query("SELECT clear_finale($1, $2) AS reading", [
          change.eventId,
          change.requestId,
        ])
      ).rows,
    ),
  );
}
