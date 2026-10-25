import { MESSAGES, type SouvenirList, type MessageKey } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { invalidRequest, notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";
import type { OrganizerContext } from "#src/organizers/store";

export type SouvenirDeps = Readonly<{ pool: Pool }>;
const CONFLICTS: Readonly<Record<string, MessageKey>> = {
  souvenir_locked: "souvenir.lockedError",
  souvenir_empty: "souvenir.emptyError",
  souvenir_changed: "souvenir.changedError",
  results_final: "souvenir.resultsError",
  event_archived: "souvenir.closed",
  limit_reached: "souvenir.limitError",
  idempotency_conflict: "souvenir.keyError",
};

/** Never echo exception details or submitted cosmetic text. */
export function souvenirRefusal(error: unknown): never {
  const pg = error as { code?: string; detail?: string };
  if (pg.code === "AN404") throw notFound();
  if (pg.code === "SV422" || pg.code === "23514" || pg.code === "23503" || pg.code === "22P02")
    throw invalidRequest();
  const message = pg.detail === undefined ? undefined : CONFLICTS[pg.detail];
  if (pg.code === "SV409" && pg.detail !== undefined && message !== undefined) {
    throw new HttpError(409, pg.detail, MESSAGES[message]);
  }
  throw error;
}

export async function asSouvenirTeam<T>(
  deps: SouvenirDeps,
  actor: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
        () => work(client),
      ),
    );
  } catch (error) {
    return souvenirRefusal(error);
  }
}

export async function souvenirList(client: PoolClient, eventId: string): Promise<SouvenirList> {
  const { rows } = await client.query<{ value: SouvenirList }>(
    "SELECT souvenir_list($1) AS value",
    [eventId],
  );
  const row = rows[0];
  if (row === undefined) throw notFound();
  return row.value;
}
