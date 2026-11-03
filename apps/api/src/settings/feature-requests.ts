import type {
  ConsoleFeatureRequest,
  ConsoleFeatureRequests,
  FeatureRequestState,
} from "@questify/shared";
import type { Client, Pool, PoolClient } from "pg";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { teamSeat, type OrganizerContext } from "#src/organizers/store";
import { isActiveAdmin } from "#src/settings/platform-switches";

type Db = Client | PoolClient;

/** The Ask Questify requests (T-711b, FR-1827, ADR-545): the owner's door, the owner's reading, the console's queue. */

export type AskedRequest = Readonly<{ id: string; status: "open"; requestedAt: string }>;

export type AskOutcome =
  | Readonly<{ kind: "created" | "already_open"; request: AskedRequest }>
  | Readonly<{ kind: "not_found" | "owner_only" | "not_addon" | "unlocked" }>
  | Readonly<{ kind: "declined_recently"; retryAt: string }>;

type PgError = Readonly<{ code?: string; hint?: string }>;

const REFUSALS: Readonly<Record<string, AskOutcome["kind"]>> = {
  RQ404: "not_found",
  RQ403: "owner_only",
  RQ422: "not_addon",
  RQ409: "unlocked",
};

/** The door's refusal as an outcome, or undefined for an error that is not one of its refusals. */
export function askRefusalOf(error: PgError): AskOutcome | undefined {
  if (error.code === "RQ429") {
    return { kind: "declined_recently", retryAt: new Date(String(error.hint)).toISOString() };
  }
  const kind = error.code === undefined ? undefined : REFUSALS[error.code];
  return kind === undefined ? undefined : ({ kind } as AskOutcome);
}

type AskRow = { id: string; status: "open"; requested_at: Date; created: boolean };

/**
 * The event's owner asks Questify for an add-on (`request_feature`, migration 0139): recorded once, answered again while
 * open, refused as the database refuses. The rate limit is the route's.
 */
export async function askForFeature(
  pool: Pool,
  actor: OrganizerContext,
  request: Readonly<{ eventId: string; feature: string; requestId: string }>,
): Promise<AskOutcome> {
  try {
    const row = await withConnection(pool, (client) =>
      withRequestContext(client, teamSeat(actor), async () => {
        const { rows } = await client.query<AskRow>("SELECT * FROM request_feature($1, $2, $3)", [
          request.eventId,
          request.feature,
          request.requestId,
        ]);
        return rows[0] as AskRow;
      }),
    );
    return {
      kind: row.created ? "created" : "already_open",
      request: { id: row.id, status: "open", requestedAt: row.requested_at.toISOString() },
    };
  } catch (error) {
    const refusal = askRefusalOf(error as PgError);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/** The latest request of each add-on of the event, as the organizer's members may read them (their own rows only). */
export async function readEventRequests(
  db: Db,
  eventId: string,
): Promise<Readonly<Record<string, FeatureRequestState>>> {
  const { rows } = await db.query<{
    feature: string;
    status: FeatureRequestState["status"];
    at: Date;
  }>(
    `SELECT DISTINCT ON (feature) feature, status, coalesce(decided_at, requested_at) AS at
     FROM feature_request WHERE event_id = $1 ORDER BY feature, requested_at DESC`,
    [eventId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.feature, { status: row.status, at: row.at.toISOString() }]),
  );
}

/**
 * Allow closes the event's open request for the add-on, whether the unlock was new or already there, in the unlock's own
 * transaction (as the admin: the table's admin policy), with one `feature_request.allow` entry each.
 */
export async function closeOpenRequests(
  client: Db,
  admin: Readonly<{ id: string }>,
  target: Readonly<{ eventId: string; feature: string }>,
  meta: AuditMeta,
): Promise<void> {
  const { rows } = await client.query<{ id: string; organizer_id: string }>(
    `UPDATE feature_request SET status = 'allowed', decided_by = $3, decided_at = now()
     WHERE event_id = $1 AND feature = $2 AND status = 'open' RETURNING id, organizer_id`,
    [target.eventId, target.feature, admin.id],
  );
  for (const row of rows) {
    await recordAudit(client, {
      actor: { type: "admin", id: admin.id },
      action: "feature_request.allow",
      organizerId: row.organizer_id,
      eventId: target.eventId,
      target: { type: "feature_request", id: row.id },
      after: { feature: target.feature, status: "allowed" },
      requestId: meta.requestId,
    });
  }
}

/** A page of the console's queue. */
export const REQUESTS_PAGE = 50;

type QueueRow = {
  id: string;
  event_id: string;
  name_ar: string | null;
  name_en: string | null;
  organizer_id: string;
  organizer: string;
  feature: string;
  requested_at: Date;
};

const rowOf = (row: QueueRow): ConsoleFeatureRequest => ({
  id: row.id,
  eventId: row.event_id,
  event: { ar: row.name_ar, en: row.name_en },
  organizerId: row.organizer_id,
  organizer: row.organizer,
  feature: row.feature,
  requestedAt: row.requested_at.toISOString(),
});

export type QueueCursor = Readonly<{ afterAt: string; afterId: string }>;

export type DeclineOutcome = "declined" | "not_found";

export type FeatureRequestQueue = Readonly<{
  /** Open requests, oldest first, after the cursor; undefined for anyone but an active admin. */
  list: (
    admin: PublicAccount,
    cursor: QueueCursor | undefined,
  ) => Promise<ConsoleFeatureRequests | undefined>;
  /** Declines one open request (`not_found` when there is none open by that id), audited `feature_request.decline`. */
  decline: (admin: PublicAccount, id: string, meta?: AuditMeta) => Promise<DeclineOutcome>;
}>;

/**
 * The console's Requests list (T-711b): open requests whose add-on is still locked (one the owner sent while an admin
 * unlocked it is left out), with business names only, and the decline. Runs as the admin; the policies check again.
 */
export function createFeatureRequestQueue(pool: Pool): FeatureRequestQueue {
  const asAdmin = <R>(admin: PublicAccount, work: (client: PoolClient) => Promise<R>): Promise<R> =>
    withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () => work(client)),
    );
  return {
    list: async (admin, cursor) => {
      if (!isActiveAdmin(admin)) {
        return undefined;
      }
      // Ordered by the millisecond the cursor carries, so a page never repeats or skips a row.
      const rows = await asAdmin(admin, async (client) => {
        const { rows: found } = await client.query<QueueRow>(
          `SELECT r.id, r.event_id, e.name_ar, e.name_en, r.organizer_id, o.name AS organizer, r.feature,
                  r.requested_at
           FROM feature_request r JOIN event e ON e.id = r.event_id JOIN organizer o ON o.id = r.organizer_id
           WHERE r.status = 'open'
             AND NOT EXISTS (SELECT 1 FROM event_entitlement x WHERE x.event_id = r.event_id AND x.feature = r.feature)
             AND ($1::timestamptz IS NULL
                  OR (date_trunc('milliseconds', r.requested_at), r.id) > ($1::timestamptz, $2::uuid))
           ORDER BY date_trunc('milliseconds', r.requested_at), r.id LIMIT $3`,
          [cursor?.afterAt ?? null, cursor?.afterId ?? null, REQUESTS_PAGE + 1],
        );
        return found;
      });
      const page = rows.slice(0, REQUESTS_PAGE).map(rowOf);
      const last = page.at(-1);
      return {
        requests: page,
        next:
          rows.length > REQUESTS_PAGE && last !== undefined
            ? { afterAt: last.requestedAt, afterId: last.id }
            : null,
      };
    },

    decline: async (admin, id, meta = {}) => {
      if (!isActiveAdmin(admin)) {
        return "not_found";
      }
      return asAdmin(admin, async (client) => {
        const { rows } = await client.query<{
          organizer_id: string;
          event_id: string;
          feature: string;
        }>(
          `UPDATE feature_request SET status = 'declined', decided_by = $2, decided_at = now()
           WHERE id = $1 AND status = 'open' RETURNING organizer_id, event_id, feature`,
          [id, admin.id],
        );
        const row = rows[0];
        if (row === undefined) {
          return "not_found";
        }
        await recordAudit(client, {
          actor: { type: "admin", id: admin.id },
          action: "feature_request.decline",
          organizerId: row.organizer_id,
          eventId: row.event_id,
          target: { type: "feature_request", id },
          after: { feature: row.feature, status: "declined" },
          requestId: meta.requestId,
        });
        return "declined";
      });
    },
  };
}
