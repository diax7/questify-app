import type { Pool, QueryResultRow } from "pg";
import { MESSAGES } from "@questify/shared";
import { notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";

export type RatingDeps = Readonly<{ pool: Pool }>;

const MESSAGE_FOR: Readonly<Record<string, { ar: string; en: string }>> = {
  ratings_off: MESSAGES["error.ratingsOff"],
  not_completed: MESSAGES["error.ratingNotCompleted"],
  invalid_rating: MESSAGES["error.ratingInvalid"],
};

/** A rating refusal in the API's one envelope; the code is the key of `MESSAGE_FOR`. */
export function ratingError(
  status: number,
  code: "ratings_off" | "not_completed" | "invalid_rating",
): HttpError {
  return new HttpError(status, code, MESSAGE_FOR[code] ?? MESSAGES["error.ratingInvalid"], {});
}

type Pg = Readonly<{ code?: string; detail?: string }>;

/** The answer for each SQLSTATE the rating and share doors raise on purpose; the detail is the database's. */
function refusalOf({ code, detail }: Pg): HttpError | undefined {
  switch (code) {
    case "AN404":
    case "QR404":
      return notFound();
    case "QR422":
      return ratingError(422, "invalid_rating");
    case "QR409":
      return ratingError(409, detail === "not_completed" ? "not_completed" : "ratings_off");
    default:
      return undefined;
  }
}

/** One statement in a request context: the first row, or the refusal mapped; anything else is rethrown. */
export async function ratingCall<Row extends QueryResultRow>(
  deps: RatingDeps,
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
