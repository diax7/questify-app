import { onlyRow } from "#src/db/rows";
import { asOrganizer, ownEvent, type ModerationDeps } from "#src/moderation/moderation";
import type { OrganizerContext } from "#src/organizers/store";

/** A join request as the event's team sees it (T-218): the public profile, never contact details. */
export type JoinRequest = Readonly<{
  enrollmentId: string;
  username: string;
  avatar: string;
  status: "pending" | "declined";
  /** Asked from the waiting list of a full event (FR-1821), not for approval of a Private event. */
  waitlisted: boolean;
  requestedAt: Date;
}>;

export type DecideOutcome =
  | "accepted"
  | "declined"
  | "unchanged"
  | "not_found"
  | "not_allowed"
  | "ended"
  | "full";

export type AcceptAllOutcome =
  | Readonly<{ kind: "done"; accepted: number; remaining: number }>
  | Readonly<{ kind: "not_found" | "ended" }>;

/** One page of the queue and how many requests of the whole event still wait for an answer. */
export type RequestsPage = Readonly<{ requests: JoinRequest[]; pending: number }>;

/**
 * The event's pending requests oldest first, then the declined ones (FR-1819), with the count of every pending
 * request; null when the event is not the caller's to see. The database checks the caller and their event limit again.
 */
export async function listRequests(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; afterId: string | null; limit: number }>,
): Promise<RequestsPage | null> {
  return asOrganizer(deps, context, async (client) => {
    if (!(await ownEvent(client, context, request.eventId))) {
      return null;
    }
    const { rows } = await client.query<{
      enrollment_id: string;
      username: string;
      avatar: string;
      status: JoinRequest["status"];
      waitlisted: boolean;
      requested_at: Date;
    }>("SELECT * FROM join_requests($1, $2, $3)", [
      request.eventId,
      request.afterId,
      request.limit,
    ]);
    const counted = await client.query<{ pending: number }>(
      "SELECT pending_join_requests($1) AS pending",
      [request.eventId],
    );
    return {
      requests: rows.map((row) => ({
        enrollmentId: row.enrollment_id,
        username: row.username,
        avatar: row.avatar,
        status: row.status,
        waitlisted: row.waitlisted,
        requestedAt: row.requested_at,
      })),
      pending: onlyRow(counted.rows, "pending_join_requests").pending,
    };
  });
}

/** Accepts or declines one request (ADR-167); the database checks the seat, the event's state and audits. */
export async function decideRequest(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; enrollmentId: string; accept: boolean; requestId: string }>,
): Promise<DecideOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: DecideOutcome }>(
      "SELECT decide_join_request($1, $2, $3, $4) AS outcome",
      [request.eventId, request.enrollmentId, request.accept, request.requestId],
    );
    return onlyRow(rows, "decide_join_request").outcome;
  });
}

/** Accepts the oldest pending requests while seats are free (FR-1825's Accept all, a release from the waiting list). */
export async function acceptAll(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; requestId: string }>,
): Promise<AcceptAllOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{
      outcome: AcceptAllOutcome["kind"];
      accepted: number;
      remaining: number;
    }>("SELECT * FROM accept_all_join_requests($1, $2)", [request.eventId, request.requestId]);
    const row = onlyRow(rows, "accept_all_join_requests");
    return row.outcome === "done"
      ? { kind: "done", accepted: row.accepted, remaining: row.remaining }
      : { kind: row.outcome };
  });
}
