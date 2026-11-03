import {
  MESSAGES,
  operatorActivitySchema,
  staffBriefingSentSchema,
  type OperatorActivity,
  type StaffBriefingBody,
  type StaffBriefingSent,
} from "@questify/shared";
import type { Pool } from "pg";
import { notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { HttpError } from "#src/http-error";
import type { OrganizerContext } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";

export type OperatorActivityDeps = Readonly<{ pool: Pool }>;

const ERROR_MESSAGES: Readonly<Record<string, { ar: string; en: string }>> = {
  invalid_briefing: MESSAGES["error.invalidBriefing"],
  briefing_limit: MESSAGES["error.briefingLimit"],
  briefing_nobody: MESSAGES["error.briefingNobody"],
  briefing_event_closed: MESSAGES["error.briefingEventClosed"],
};

export function briefingError(
  status: number,
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): HttpError {
  return new HttpError(
    status,
    code,
    ERROR_MESSAGES[code] ?? MESSAGES["error.invalidBriefing"],
    details,
  );
}

type Pg = Readonly<{ code?: string; detail?: string }>;

/** The API's answer for each SQLSTATE the briefing door raises on purpose (migration 0111). */
const REFUSALS: Readonly<Record<string, (detail: string | undefined) => HttpError>> = {
  AN404: () => notFound(),
  PA422: (detail) => briefingError(422, "invalid_briefing", { field: detail, issue: "invalid" }),
  PL429: (detail) => briefingError(429, "briefing_limit", { window: detail }),
  PT409: () => briefingError(409, "briefing_nobody"),
  PE409: () => briefingError(409, "briefing_event_closed"),
};

const asTeam = <T>(
  deps: OperatorActivityDeps,
  team: OrganizerContext,
  work: (query: (sql: string, values: unknown[]) => Promise<unknown[]>) => Promise<T>,
): Promise<T> =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, teamSeat(team), () =>
      work(async (sql, values) => (await client.query(sql, values)).rows),
    ),
  );

/**
 * What each operator of the event did today and last, and the latest actions (T-617, FR-1844): the door's answer
 * (`operator_activity`, migration 0111) checked against the strict schema, so nothing but usernames, counts, station
 * names and the organizer's own briefings can leave. 404 for an event outside the member's organizer or event limit.
 */
export async function readOperatorActivity(
  deps: OperatorActivityDeps,
  team: OrganizerContext,
  eventId: string,
  recent: number,
): Promise<OperatorActivity> {
  try {
    const rows = await asTeam(deps, team, (query) =>
      query("SELECT operator_activity($1, $2) AS answer", [eventId, recent]),
    );
    return operatorActivitySchema.parse((rows[0] as { answer: unknown }).answer);
  } catch (error) {
    if ((error as Pg).code === "AN404") {
      throw notFound();
    }
    throw error;
  }
}

/**
 * Sends a briefing to the event's operators (`staff_briefing_send`): the draft was cleaned and checked by the route, the
 * database bounds it again, limits the event, and writes one personal notice per current operator.
 */
export async function sendStaffBriefing(
  deps: OperatorActivityDeps,
  team: OrganizerContext,
  call: Readonly<{
    eventId: string;
    draft: StaffBriefingBody;
    key: string;
    requestId: string;
  }>,
): Promise<StaffBriefingSent> {
  try {
    const rows = await asTeam(deps, team, (query) =>
      query("SELECT * FROM staff_briefing_send($1, $2::jsonb, $3, $4)", [
        call.eventId,
        JSON.stringify(call.draft),
        call.key,
        call.requestId,
      ]),
    );
    return staffBriefingSentSchema.parse(rows[0]);
  } catch (error) {
    const { code, detail } = error as Pg;
    const refusal = REFUSALS[code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    throw refusal(detail);
  }
}
