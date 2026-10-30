import type { Pool, QueryResultRow } from "pg";
import { MESSAGES } from "@questify/shared";
import { notEnrolled, notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";

const ERROR_MESSAGES: Readonly<Record<string, { ar: string; en: string }>> = {
  invalid_map: MESSAGES["error.mapInvalid"],
  map_limit: MESSAGES["error.mapLimit"],
  map_pin_limit: MESSAGES["error.mapPinLimit"],
  map_quest_pinned: MESSAGES["error.mapQuestPinned"],
  map_event_closed: MESSAGES["error.mapEventClosed"],
};

export type MapDeps = Readonly<{ pool: Pool }>;

export function mapError(
  status: number,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): HttpError {
  return new HttpError(status, code, ERROR_MESSAGES[code] ?? MESSAGES["error.mapInvalid"], details);
}

type Pg = Readonly<{ code?: string; detail?: string }>;

const CONFLICTS: Readonly<Record<string, string>> = {
  event_closed: "map_event_closed",
  limit: "map_limit",
  pin_limit: "map_pin_limit",
  quest_pinned: "map_quest_pinned",
};

/** The API's answer for each SQLSTATE the map doors raise on purpose; the detail is the database's. */
const REFUSALS: Readonly<Record<string, (detail: string | undefined) => HttpError>> = {
  AN404: () => notFound(),
  MP404: () => notFound(),
  AM403: () => notEnrolled(),
  PS422: (detail) => mapError(422, "invalid_map", { issue: detail }),
  MP409: (detail) => mapError(409, CONFLICTS[detail ?? ""] ?? "invalid_map"),
};

/** Turns a refusal of the map doors into the API's answer; anything else is rethrown. */
export function mapRefusal(error: unknown): never {
  const { code, detail } = error as Pg;
  const answer = code === undefined ? undefined : REFUSALS[code];
  if (answer === undefined) throw error;
  throw answer(detail);
}

/** One statement in a request context: the first row, or the refusal mapped. */
export async function mapCall<Row extends QueryResultRow>(
  deps: MapDeps,
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
    return mapRefusal(error);
  }
}
