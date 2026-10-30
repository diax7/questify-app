import type { Pool, QueryResultRow } from "pg";
import { MESSAGES } from "@questify/shared";
import { notEnrolled, notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";

const ERROR_MESSAGES: Readonly<Record<string, { ar: string; en: string }>> = {
  invalid_sponsor: MESSAGES["error.sponsorInvalid"],
  sponsor_limit: MESSAGES["error.sponsorLimit"],
  sponsor_event_closed: MESSAGES["error.sponsorEventClosed"],
};

export type SponsorDeps = Readonly<{ pool: Pool }>;

export function sponsorError(
  status: number,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): HttpError {
  return new HttpError(
    status,
    code,
    ERROR_MESSAGES[code] ?? MESSAGES["error.sponsorInvalid"],
    details,
  );
}

type Pg = Readonly<{ code?: string; detail?: string }>;

const CONFLICTS: Readonly<Record<string, string>> = {
  event_closed: "sponsor_event_closed",
  limit: "sponsor_limit",
};

/** The API's answer for each SQLSTATE the sponsor doors raise on purpose; the detail is the database's. */
const REFUSALS: Readonly<Record<string, (detail: string | undefined) => HttpError>> = {
  AN404: () => notFound(),
  SO404: () => notFound(),
  AM403: () => notEnrolled(),
  PS422: (detail) => sponsorError(422, "invalid_sponsor", { issue: detail }),
  SO409: (detail) => sponsorError(409, CONFLICTS[detail ?? ""] ?? "invalid_sponsor"),
};

/** Turns a refusal of the sponsor doors into the API's answer; anything else is rethrown. */
export function sponsorRefusal(error: unknown): never {
  const { code, detail } = error as Pg;
  const answer = code === undefined ? undefined : REFUSALS[code];
  if (answer === undefined) throw error;
  throw answer(detail);
}

/** One statement in a request context: the first row, or the refusal mapped. */
export async function sponsorCall<Row extends QueryResultRow>(
  deps: SponsorDeps,
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
    return sponsorRefusal(error);
  }
}
