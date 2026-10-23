import type { Pool, PoolClient } from "pg";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { onlyRow } from "#src/db/rows";
import type { OrganizerContext } from "#src/organizers/store";

export type ModerationDeps = Readonly<{ pool: Pool }>;

/** A player as the event's team sees them: what the join card discloses (PD-17), nothing that links them elsewhere. */
export type EventPlayer = Readonly<{
  enrollmentId: string;
  username: string;
  avatar: string;
  status: "pending" | "active" | "left" | "removed" | "banned" | "declined";
  score: number;
  joinedAt: Date;
  /** The join answers (FR-131), in the event's field order: for this event's team only. */
  answers: readonly JoinAnswerView[];
  /** The player's oldest open flag case (T-209), for a link to it; null when none is open. */
  openFlag: string | null;
  /** The owner paused this player's redemptions (FR-518). */
  redeemPaused: boolean;
  /** A rehearsal account (T-211): erased at go-live. */
  rehearsal: boolean;
}>;

export type JoinAnswerView = Readonly<{
  fieldId: string;
  kind: string;
  label: Readonly<{ ar: string | null; en: string | null }>;
  value: string;
  /** A choice field's answer as its option's labels (ADR-171); null for a free-text answer. */
  choice: Readonly<{ ar: string | null; en: string | null }> | null;
}>;

export type BanOutcome = "changed" | "unchanged" | "not_found" | "not_owner" | "not_allowed";

export type ExclusionKind = "phone" | "email_domain";

/** An exclusion entry as the dashboard sees it: a phone shows only its last four digits, for every seat. */
export type Exclusion = Readonly<{
  id: string;
  kind: ExclusionKind;
  value: string;
  createdAt: Date;
}>;

export type AddOutcome =
  | Readonly<{ kind: "added" | "existing"; id: string }>
  | Readonly<{ kind: "not_found" | "not_owner" | "full" }>;

export type RemoveOutcome = "removed" | "not_found" | "not_owner";

/** Most entries an event's exclusion list holds (migration 0019 enforces it too). */
export const EXCLUSION_LIMIT = 500;

export const asOrganizer = <T>(
  deps: ModerationDeps,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: context.organizerId, staffUserId: context.staffUserId },
      () => work(client),
    ),
  );

/**
 * Whether the event is the caller organizer's and within their event limit. Any organizer can see public events, so
 * both lists below check this, not only whether the event is visible.
 */
export async function ownEvent(
  client: PoolClient,
  context: OrganizerContext,
  eventId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    "SELECT 1 FROM event WHERE id = $1 AND organizer_id = $2 AND in_event_scope(id, app_event_scope())",
    [eventId, context.organizerId],
  );
  return rowCount === 1;
}

/** Shows a phone as its last four digits; a domain as it is. */
export function maskExclusion(kind: ExclusionKind, value: string): string {
  return kind === "phone" ? `•••• ${value.slice(-4)}` : value;
}

/**
 * The event's players for its team, in join order (T-208); null when the event is not the caller's to see. The
 * database checks the caller and their event limit again.
 */
export async function listPlayers(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    afterId: string | null;
    limit: number;
    prefix: string | null;
  }>,
): Promise<EventPlayer[] | null> {
  return asOrganizer(deps, context, async (client) => {
    if (!(await ownEvent(client, context, request.eventId))) {
      return null;
    }
    const { rows } = await client.query<{
      enrollment_id: string;
      username: string;
      avatar: string;
      status: EventPlayer["status"];
      score: string;
      joined_at: Date;
      open_flag: string | null;
      redeem_paused: boolean;
      rehearsal: boolean;
    }>("SELECT * FROM event_players($1, $2, $3, $4)", [
      request.eventId,
      request.afterId,
      request.limit,
      request.prefix,
    ]);
    const answers = await readAnswers(
      client,
      request.eventId,
      rows.map((row) => row.enrollment_id),
    );
    return rows.map((row) => ({
      enrollmentId: row.enrollment_id,
      username: row.username,
      avatar: row.avatar,
      status: row.status,
      score: Number(row.score),
      joinedAt: row.joined_at,
      answers: answers.get(row.enrollment_id) ?? [],
      openFlag: row.open_flag,
      redeemPaused: row.redeem_paused,
      rehearsal: row.rehearsal,
    }));
  });
}

/** The page's join answers by enrollment, read under the team's own rules (migration 0028's policy). */
async function readAnswers(
  client: PoolClient,
  eventId: string,
  enrollmentIds: readonly string[],
): Promise<Map<string, JoinAnswerView[]>> {
  const { rows } = await client.query<{
    enrollment_id: string;
    field_id: string;
    kind: string;
    label_ar: string | null;
    label_en: string | null;
    value: string;
    choice: { ar: string | null; en: string | null } | null;
  }>(
    `SELECT a.enrollment_id, a.field_id, f.kind, f.label_ar, f.label_en, a.value,
            (SELECT jsonb_build_object('ar', o ->> 'ar', 'en', o ->> 'en')
             FROM jsonb_array_elements(f.options) o WHERE o ->> 'id' = a.value) AS choice
     FROM join_answer a JOIN event_join_field f ON f.id = a.field_id
     WHERE a.event_id = $1 AND a.enrollment_id = ANY ($2::uuid[])
     ORDER BY f.position, f.id`,
    [eventId, enrollmentIds],
  );
  const byEnrollment = new Map<string, JoinAnswerView[]>();
  for (const row of rows) {
    const list = byEnrollment.get(row.enrollment_id) ?? [];
    list.push({
      fieldId: row.field_id,
      kind: row.kind,
      label: { ar: row.label_ar, en: row.label_en },
      value: row.value,
      choice: row.choice,
    });
    byEnrollment.set(row.enrollment_id, list);
  }
  return byEnrollment;
}

/** Bans a player from the event or lifts the ban (FR-321, FR-1605); the database checks the owner and audits. */
export async function setBan(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; enrollmentId: string; banned: boolean; requestId: string }>,
): Promise<BanOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: BanOutcome }>(
      "SELECT set_enrollment_ban($1, $2, $3, $4) AS outcome",
      [request.eventId, request.enrollmentId, request.banned, request.requestId],
    );
    return onlyRow(rows, "set_enrollment_ban").outcome;
  });
}

/** The event's exclusion list (FR-319), newest first, masked; null when the event is not the caller's to see. */
export async function listExclusions(
  deps: ModerationDeps,
  context: OrganizerContext,
  eventId: string,
): Promise<Exclusion[] | null> {
  return asOrganizer(deps, context, async (client) => {
    if (!(await ownEvent(client, context, eventId))) {
      return null;
    }
    const { rows } = await client.query<{
      id: string;
      kind: ExclusionKind;
      value: string;
      created_at: Date;
    }>(
      "SELECT id, kind, value, created_at FROM event_exclusion WHERE event_id = $1 ORDER BY created_at DESC, id",
      [eventId],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      value: maskExclusion(row.kind, row.value),
      createdAt: row.created_at,
    }));
  });
}

/** Adds a phone (E.164) or an email domain (lower case) to the list; a duplicate answers the entry already there. */
export async function addExclusion(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; kind: ExclusionKind; value: string; requestId: string }>,
): Promise<AddOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: AddOutcome["kind"]; id: string | null }>(
      "SELECT outcome, id FROM add_exclusion($1, $2, $3, $4)",
      [request.eventId, request.kind, request.value, request.requestId],
    );
    const row = onlyRow(rows, "add_exclusion");
    // An added or found entry always has its id (migration 0019).
    return row.outcome === "added" || row.outcome === "existing"
      ? { kind: row.outcome, id: String(row.id) }
      : { kind: row.outcome };
  });
}

/** Removes an entry by its id (FR-319); another event's or organizer's id is not found. */
export async function removeExclusion(
  deps: ModerationDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; exclusionId: string; requestId: string }>,
): Promise<RemoveOutcome> {
  return asOrganizer(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: RemoveOutcome }>(
      "SELECT remove_exclusion($1, $2, $3) AS outcome",
      [request.eventId, request.exclusionId, request.requestId],
    );
    return onlyRow(rows, "remove_exclusion").outcome;
  });
}
