import type { Pool, QueryResultRow } from "pg";
import { MESSAGES } from "@questify/shared";
import { notEnrolled, notFound, notOperator } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";

const ERROR_MESSAGES: Readonly<Record<string, { ar: string; en: string }>> = {
  invalid_session: MESSAGES["error.sessionInvalid"],
  session_seats_below: MESSAGES["error.sessionSeatsBelow"],
  session_has_registrations: MESSAGES["error.sessionHasRegistrations"],
  session_has_attendance: MESSAGES["error.sessionHasAttendance"],
  session_limit: MESSAGES["error.sessionLimit"],
  session_event_closed: MESSAGES["error.sessionEventClosed"],
  session_not_required: MESSAGES["error.sessionNotRequired"],
  session_nobody: MESSAGES["error.sessionNobody"],
  session_message_limit: MESSAGES["error.sessionMessageLimit"],
  session_full: MESSAGES["error.sessionFull"],
  session_closed: MESSAGES["error.sessionClosed"],
  session_started: MESSAGES["error.sessionStarted"],
};

export type SessionDeps = Readonly<{ pool: Pool }>;

export function sessionError(
  status: number,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): HttpError {
  return new HttpError(
    status,
    code,
    ERROR_MESSAGES[code] ?? MESSAGES["error.sessionInvalid"],
    details,
  );
}

type Pg = Readonly<{ code?: string; detail?: string }>;

/** A conflict the database names in its detail: `seats_below:40` carries the registered number. */
function conflict(detail: string | undefined): HttpError {
  const [name = "", number] = (detail ?? "").split(":");
  if (name === "seats_below") {
    return sessionError(409, "session_seats_below", { registered: Number(number) });
  }
  const known = [
    "has_registrations",
    "has_attendance",
    "limit",
    "not_required",
    "closed",
    "full",
    "started",
  ];
  return sessionError(409, known.includes(name) ? `session_${name}` : "invalid_session");
}

/** The API's answer for each SQLSTATE the session doors raise on purpose; the detail is the database's. */
const REFUSALS: Readonly<Record<string, (detail: string | undefined) => HttpError>> = {
  AN404: () => notFound(),
  SS404: () => notFound(),
  AM403: () => notEnrolled(),
  OP403: () => notOperator(),
  PS422: (detail) => sessionError(422, "invalid_session", { issue: detail }),
  PS409: conflict,
  PE409: () => sessionError(409, "session_event_closed"),
  PT409: () => sessionError(409, "session_nobody"),
  PL429: (detail) => sessionError(429, "session_message_limit", { window: detail }),
};

/** Turns a refusal of the session doors into the API's answer; anything else is rethrown. */
export function sessionRefusal(error: unknown): never {
  const { code, detail } = error as Pg;
  const answer = code === undefined ? undefined : REFUSALS[code];
  if (answer === undefined) throw error;
  throw answer(detail);
}

/** One statement in a request context: the first row, or the refusal mapped. */
export async function sessionCall<Row extends QueryResultRow>(
  deps: SessionDeps,
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
    return sessionRefusal(error);
  }
}
