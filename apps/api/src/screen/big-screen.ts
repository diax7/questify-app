import type { Pool, PoolClient } from "pg";
import { bigScreenOff, invalidBigScreen } from "#src/auth/http-errors";
import { inDevice } from "#src/devices/errors";
import type { HttpError } from "#src/http-error";
import type { Scene } from "#src/screen/scenes";

/** The Big screen page's reading: the scenes running in order, the ones offered, and whether the add-on is active. */
export type BigScreenPlan = Readonly<{
  scenes: readonly Scene[];
  offered: readonly Scene[];
  enabled: boolean;
}>;

type Team = Readonly<{ organizerId: string; staffUserId: string }>;

type PgError = Readonly<{ code?: string; detail?: string }>;

/** The refusals of migration 0083's team doors as HTTP answers; undefined for anything else. */
const refusalOf = (pg: PgError): HttpError | undefined => {
  if (pg.code === "BS403") {
    return bigScreenOff();
  }
  return pg.code === "BS422" ? invalidBigScreen({ field: pg.detail ?? "scenes" }) : undefined;
};

/** One call as the team member, with the database's own refusals turned into their answers. */
async function asTeam<T>(
  pool: Pool,
  team: Team,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await inDevice(pool, team, work);
  } catch (error) {
    throw refusalOf(error as PgError) ?? error;
  }
}

const planOf = (row: unknown): BigScreenPlan => {
  const plan = row as { scenes: Scene[]; offered: Scene[]; enabled: boolean };
  return { scenes: plan.scenes, offered: plan.offered, enabled: plan.enabled };
};

/**
 * The event's picked scenes for its team (FR-631): the running list, what is offered (the ranking only while it is on,
 * FR-1612) and whether the big-screen add-on is active.
 *
 * @throws HttpError not_found for another organizer's event.
 */
export function readBigScreen(pool: Pool, team: Team, eventId: string): Promise<BigScreenPlan> {
  return asTeam(pool, team, async (client) => {
    const { rows } = await client.query<{ plan: unknown }>("SELECT event_big_screen($1) AS plan", [
      eventId,
    ]);
    return planOf((rows[0] as { plan: unknown }).plan);
  });
}

/**
 * Saves the picked scenes in order (an empty list is allowed), audited by the database.
 *
 * @throws HttpError big_screen_off while the add-on is not active, invalid_big_screen for an unknown, repeated or too
 *   many scenes or the ranking while it is off, not_found for another organizer's event.
 */
export function saveBigScreen(
  pool: Pool,
  team: Team,
  change: Readonly<{ eventId: string; scenes: readonly string[]; requestId: string }>,
): Promise<BigScreenPlan> {
  return asTeam(pool, team, async (client) => {
    const { rows } = await client.query<{ plan: unknown }>(
      "SELECT set_big_screen($1, $2, $3) AS plan",
      [change.eventId, change.scenes, change.requestId],
    );
    return planOf((rows[0] as { plan: unknown }).plan);
  });
}
