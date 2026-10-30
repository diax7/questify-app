import type { Pool, QueryResultRow } from "pg";
import {
  bigScreenOff,
  cheersEventNotLive,
  cheersNotLive,
  cheersOff,
  invalidCheer,
  notFound,
  ownerOnly,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";

export type CheersDeps = Readonly<{ pool: Pool }>;

/** The Big screen page's reading of Cheers (migration 0090's `cheers_json`). */
export type CheersReading = Readonly<{
  /** Whether the big-screen add-on is active; a moment cannot start without it. */
  enabled: boolean;
  /** The event's own Cheers switch. */
  switch: boolean;
  /** Whether the platform allows Cheers at all. */
  platformOn: boolean;
  live: Readonly<{ startedAt: string; endsAt: string }> | null;
}>;

type Pg = Readonly<{ code?: string; detail?: string }>;

type Refusal = (detail: string | undefined) => HttpError;

/** The answer for each SQLSTATE the Cheers doors raise on purpose (CH429 is the caller's, so it is not here). */
const REFUSALS: Readonly<Record<string, Refusal>> = {
  AN404: () => notFound(),
  CH404: () => notFound(),
  BS403: () => bigScreenOff(),
  CH403: () => ownerOnly(),
  CH409: (detail) =>
    detail === "cheers_off"
      ? cheersOff()
      : detail === "not_live"
        ? cheersNotLive()
        : cheersEventNotLive(),
  CH422: (detail) => invalidCheer({ field: detail === "minutes" ? "minutes" : "reaction" }),
};

const refusalOf = ({ code, detail }: Pg): HttpError | undefined =>
  code === undefined ? undefined : REFUSALS[code]?.(detail);

/** One statement in a request context: the first row, or the refusal mapped; anything else is rethrown. */
export async function cheersCall<Row extends QueryResultRow>(
  deps: CheersDeps,
  context: RequestContext,
  sql: string,
  values: readonly unknown[],
): Promise<Row> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, context, async () => {
        const result = await client.query<Row>(sql, [...values]);
        return result.rows[0] as Row;
      }),
    );
  } catch (error) {
    throw refusalOf(error as Pg) ?? error;
  }
}

/**
 * Sends one cheer for the calling player. Answers undefined when it was taken, or the seconds to wait when the player is
 * over the per-minute limit (the database counts, so the limit holds across servers).
 *
 * @throws HttpError not_found for an event the player is not an active member of, cheers_not_live, invalid_cheer.
 */
export async function sendCheer(
  deps: CheersDeps,
  send: Readonly<{ playerId: string; eventId: string; reaction: string }>,
): Promise<number | undefined> {
  try {
    await cheersCall(deps, { playerId: send.playerId }, "SELECT send_cheer($1, $2) AS answer", [
      send.eventId,
      send.reaction,
    ]);
    return undefined;
  } catch (error) {
    const pg = error as Pg;
    if (pg.code === "CH429") {
      return Math.max(1, Number(pg.detail) || 1);
    }
    throw error;
  }
}
