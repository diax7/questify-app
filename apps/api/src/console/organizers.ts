import type { Pool, PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/** Questify paused it, with the reason it wrote (T-701). */
export type SuspensionView = Readonly<{ reason: string; since: string }>;

export type OrganizerRow = Readonly<{
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerEmail: string | null;
  events: Readonly<{ draft: number; scheduled: number; live: number }>;
}>;

export type OrganizerQuery = Readonly<{
  q: string | null;
  status: "active" | "paused" | null;
  cursor: string | null;
  limit: number;
}>;

export type OrganizerDetail = Readonly<{
  organizer: Readonly<{
    id: string;
    name: string;
    slug: string;
    status: string;
    createdAt: string;
    suspension: SuspensionView | null;
  }>;
  team: readonly Readonly<{
    /** The member's staff account, for the console's "end every session" (T-810c, FR-141). */
    staffUserId: string;
    email: string;
    role: "owner" | "editor";
    eventScope: readonly string[] | null;
  }>[];
  events: readonly Readonly<{
    id: string;
    joinCode: string;
    name: Readonly<{ ar: string | null; en: string | null }>;
    status: string;
    statusNow: string;
    startsAt: string | null;
    endsAt: string | null;
    suspension: SuspensionView | null;
  }>[];
  history: readonly HistoryEntry[];
  /** The owner's open email change, else the organizer's latest one (T-701b); null when there was none. */
  ownerEmailChange: OwnerEmailChange | null;
  /** The other organizers the owner's account belongs to: an email change applies to all of them (T-701b). */
  ownerOtherOrganizers: readonly string[];
}>;

/** An owner email change as the console's owner card shows it (`console_owner_email_change`). */
export type OwnerEmailChange = Readonly<{
  id: string;
  state: string;
  oldEmail: string | null;
  newEmail: string | null;
  createdAt: string;
  expiresAt: string;
  appliesAt: string | null;
  closedAt: string | null;
  resends: number;
  lastSentAt: string;
  completedHow: string | null;
  disputedAt: string | null;
}>;

export type HistoryEntry = Readonly<{
  id: string;
  at: string;
  actorType: string;
  action: string;
  targetType: string;
  eventId: string | null;
  /** Made by Questify support inside the organizer's dashboard (the entry's stamp, ADR-408). */
  bySupport: boolean;
  /** What the admin typed for a suspension, or for lifting one; null for every other entry. */
  reason: string | null;
}>;

type Admin = Readonly<{ id: string }>;

/** The audit actions whose entry keeps the admin's typed reason in `after` (the suspension doors and their lifting). */
export const REASON_ACTIONS: readonly string[] = [
  "event.suspend",
  "event.reactivate",
  "organizer.suspend",
  "organizer.reactivate",
];

const suspensionOf = (reason: string | null, since: Date | null): SuspensionView | null =>
  reason === null || since === null ? null : { reason, since: since.toISOString() };

/** Runs a console read in the admin's seat (the admin branches of the row rules, as T-210's event page). */
function asAdmin<T>(pool: Pool, admin: Admin, work: (client: PoolClient) => Promise<T>) {
  return withConnection(pool, (client) =>
    withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () => work(client)),
  );
}

/**
 * The console's organizer list: name or slug by prefix (case-folded), or an owner email exactly (never by prefix), a
 * status filter, keyset pages by name. The read shows owner emails, so it writes one audit entry with the ids shown.
 */
export function readOrganizers(
  pool: Pool,
  admin: Admin,
  query: OrganizerQuery,
  requestId: string,
): Promise<OrganizerRow[]> {
  return asAdmin(pool, admin, async (client) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      slug: string;
      status: string;
      owner_email: string | null;
      draft: number;
      scheduled: number;
      live: number;
    }>(
      `SELECT o.id, o.name, o.slug, o.status,
              (SELECT s.email FROM organizer_member m JOIN staff_user s ON s.id = m.staff_user_id
               WHERE m.organizer_id = o.id AND m.role = 'owner') AS owner_email,
              count(e.id) FILTER (WHERE e.status = 'draft')::int AS draft,
              count(e.id) FILTER (WHERE event_status_now(e.status, e.starts_at, e.ends_at) = 'scheduled')::int
                AS scheduled,
              count(e.id) FILTER (WHERE event_status_now(e.status, e.starts_at, e.ends_at) = 'live')::int AS live
       FROM organizer o LEFT JOIN event e ON e.organizer_id = o.id
       WHERE ($1::text IS NULL
              OR starts_with(lower(o.name), lower($1)) OR starts_with(lower(o.slug), lower($1))
              OR o.id IN (SELECT m.organizer_id FROM organizer_member m JOIN staff_user s ON s.id = m.staff_user_id
                          WHERE m.role = 'owner' AND s.email = lower($1)))
         AND ($2::text IS NULL OR o.status = $2)
         AND ($3::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM organizer c WHERE c.id = $3)
              OR (lower(o.name), o.id) > (SELECT lower(c.name), c.id FROM organizer c WHERE c.id = $3))
       GROUP BY o.id
       ORDER BY lower(o.name), o.id
       LIMIT $4`,
      [query.q, query.status, query.cursor, query.limit],
    );
    await recordAudit(client, {
      actor: { type: "admin", id: admin.id },
      action: "console.organizers_read",
      target: { type: "organizer" },
      after: { organizerIds: rows.map((row) => row.id) },
      requestId,
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      status: row.status,
      ownerEmail: row.owner_email,
      events: { draft: row.draft, scheduled: row.scheduled, live: row.live },
    }));
  });
}

/** One organizer for the console: itself, its team, its events and its last 50 audit entries; audited (ids only). */
export function readOrganizer(
  pool: Pool,
  admin: Admin,
  organizerId: string,
  requestId: string,
): Promise<OrganizerDetail | undefined> {
  return asAdmin(pool, admin, async (client) => {
    const { rows } = await client.query<{
      id: string;
      name: string;
      slug: string;
      status: string;
      created_at: Date;
      suspension_reason: string | null;
      suspended_at: Date | null;
    }>(
      `SELECT id, name, slug, status, created_at, suspension_reason, suspended_at FROM organizer WHERE id = $1`,
      [organizerId],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const detail: OrganizerDetail = {
      organizer: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        suspension: suspensionOf(row.suspension_reason, row.suspended_at),
      },
      team: await readTeamOf(client, organizerId),
      events: await readEventsOf(client, organizerId),
      history: await readHistory(client, { organizerId }),
      ownerEmailChange: await readOwnerEmailChange(client, organizerId),
      ownerOtherOrganizers: await readOwnerOthers(client, organizerId),
    };
    await recordAudit(client, {
      actor: { type: "admin", id: admin.id },
      action: "console.organizer_read",
      target: { type: "organizer", id: organizerId },
      organizerId,
      requestId,
    });
    return detail;
  });
}

async function readOwnerEmailChange(
  client: PoolClient,
  organizerId: string,
): Promise<OwnerEmailChange | null> {
  const { rows } = await client.query<{ r: OwnerEmailChange | null }>(
    "SELECT console_owner_email_change($1) AS r",
    [organizerId],
  );
  return rows[0]?.r ?? null;
}

async function readOwnerOthers(client: PoolClient, organizerId: string): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT o.name FROM organizer_member owner_row
     JOIN organizer_member m ON m.staff_user_id = owner_row.staff_user_id AND m.organizer_id <> owner_row.organizer_id
     JOIN organizer o ON o.id = m.organizer_id
     WHERE owner_row.organizer_id = $1 AND owner_row.role = 'owner'
     ORDER BY lower(o.name), o.id LIMIT 50`,
    [organizerId],
  );
  return rows.map((row) => row.name);
}

async function readTeamOf(
  client: PoolClient,
  organizerId: string,
): Promise<OrganizerDetail["team"]> {
  const { rows } = await client.query<{
    staff_user_id: string;
    email: string;
    role: "owner" | "editor";
    event_scope: string[] | null;
  }>(
    `SELECT m.staff_user_id, s.email, m.role, m.event_scope FROM organizer_member m JOIN staff_user s ON s.id = m.staff_user_id
     WHERE m.organizer_id = $1 ORDER BY m.role DESC, m.created_at`,
    [organizerId],
  );
  return rows.map((row) => ({
    staffUserId: row.staff_user_id,
    email: row.email,
    role: row.role,
    eventScope: row.event_scope,
  }));
}

async function readEventsOf(
  client: PoolClient,
  organizerId: string,
): Promise<OrganizerDetail["events"]> {
  const { rows } = await client.query<{
    id: string;
    join_code: string;
    name_ar: string | null;
    name_en: string | null;
    status: string;
    status_now: string;
    starts_at: Date | null;
    ends_at: Date | null;
    suspension_reason: string | null;
    suspended_at: Date | null;
  }>(
    `SELECT id, join_code, name_ar, name_en, status, event_status_now(status, starts_at, ends_at) AS status_now,
            starts_at, ends_at, suspension_reason, suspended_at
     FROM event WHERE organizer_id = $1 ORDER BY starts_at DESC NULLS FIRST, id LIMIT 200`,
    [organizerId],
  );
  return rows.map((row) => ({
    id: row.id,
    joinCode: row.join_code,
    name: { ar: row.name_ar, en: row.name_en },
    status: row.status,
    statusNow: row.status_now,
    startsAt: row.starts_at?.toISOString() ?? null,
    endsAt: row.ends_at?.toISOString() ?? null,
    suspension: suspensionOf(row.suspension_reason, row.suspended_at),
  }));
}

/**
 * The last 50 audit entries of an organizer or of one event: what happened, never the values or who by name. The one
 * value shown is the reason an admin typed for a suspension or for lifting it, beside that entry.
 */
export async function readHistory(
  client: PoolClient,
  scope: Readonly<{ organizerId: string } | { eventId: string }>,
): Promise<HistoryEntry[]> {
  const byOrganizer = "organizerId" in scope;
  const { rows } = await client.query<{
    id: string;
    at: Date;
    actor_type: string;
    action: string;
    target_type: string;
    event_id: string | null;
    by_support: boolean;
    reason: string | null;
  }>(
    `SELECT id::text, at, actor_type, action, target_type, event_id, support_grant_id IS NOT NULL AS by_support,
            CASE WHEN action = ANY ($2::text[]) THEN after ->> 'reason' END AS reason
     FROM audit_log WHERE ${byOrganizer ? "organizer_id" : "event_id"} = $1 ORDER BY audit_log.id DESC LIMIT 50`,
    [byOrganizer ? scope.organizerId : scope.eventId, REASON_ACTIONS],
  );
  return rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    actorType: row.actor_type,
    action: row.action,
    targetType: row.target_type,
    eventId: row.event_id,
    bySupport: row.by_support,
    reason: row.reason,
  }));
}
