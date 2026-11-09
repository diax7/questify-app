import type { Pool, PoolClient } from "pg";
import {
  activationStateOf,
  refusalOf,
  type ActivationState,
  type LimitMode,
  type PlayerLimit,
  type Refusal,
} from "#src/activation/activation";
import type { Caller } from "#src/auth/sign-in";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { recordAudit } from "#src/audit/record";
import { readHistory, type HistoryEntry, type SuspensionView } from "#src/console/organizers";
import type { OrganizerContext } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";

/** What the team and the console both see of an event's activation (FR-1019, FR-1021, FR-1729). */
export type ActivationView = Readonly<{
  state: ActivationState;
  requestedAt: string | null;
  note: string | null;
  limit: PlayerLimit;
  players: number;
  /** The marks reached under the current limit: 80 and 100 (FR-1021). */
  alerts: readonly number[];
  addons: readonly string[];
}>;

export type ConsoleEvent = ActivationView &
  Readonly<{
    event: Readonly<{
      id: string;
      joinCode: string;
      name: Readonly<{ ar: string | null; en: string | null }>;
      kind: string;
      venue: Readonly<{ ar: string | null; en: string | null }>;
      status: string;
      statusNow: string;
      timezone: string;
      startsAt: string | null;
      endsAt: string | null;
      organizer: Readonly<{ id: string; name: string }>;
      ownerEmail: string | null;
      /** Questify paused the event itself (T-701). */
      suspension: SuspensionView | null;
      /** Questify paused its organizer, which pauses every event of it. */
      organizerSuspension: SuspensionView | null;
    }>;
    /** Live support grants on this event: who holds one, and until when (ADR-407). */
    supportGrants: readonly Readonly<{
      id: string;
      adminEmail: string;
      mine: boolean;
      openedAt: string;
      expiresAt: string;
      /** `view` (read-only, T-712) or `edit` (T-701). */
      kind: "view" | "edit";
    }>[];
    /** The event's last 50 audit entries, support work marked. */
    history: readonly HistoryEntry[];
  }>;

export type QueueItem = Readonly<{
  eventId: string;
  name: Readonly<{ ar: string | null; en: string | null }>;
  organizer: string;
  requestedAt: string;
  startsAt: string | null;
  timezone: string;
}>;

export type RequestResult =
  | Readonly<{ kind: "requested" | "already"; requestedAt: string }>
  | Refusal;
export type Done = Readonly<{ kind: "done" }> | Refusal;
export type WithdrawResult = Readonly<{ kind: "withdrawn" | "none" }> | Refusal;

type ViewRow = {
  status: string;
  player_limit_mode: LimitMode;
  player_limit: number | null;
  request_state: "pending" | "rejected" | null;
  requested_at: Date | null;
  note: string | null;
  players: number;
  alerts: number[];
  addons: string[];
};

/** One query for the view; the row-level rules decide who sees the event at all. */
const VIEW_SQL = `
  SELECT e.status, e.player_limit_mode, e.player_limit,
         r.state AS request_state, r.requested_at, r.note,
         COALESCE(event_seat_count(e.id), 0) AS players,
         ARRAY(SELECT a.level::int FROM event_limit_alert a WHERE a.event_id = e.id ORDER BY a.level) AS alerts,
         ARRAY(SELECT x.feature FROM event_entitlement x WHERE x.event_id = e.id ORDER BY x.feature) AS addons
  FROM event e LEFT JOIN event_activation_request r ON r.event_id = e.id
  WHERE e.id = $1`;

function viewOf(row: ViewRow): ActivationView {
  return {
    state: activationStateOf(
      row.status,
      row.request_state === null ? undefined : { state: row.request_state },
    ),
    requestedAt: row.requested_at?.toISOString() ?? null,
    note: row.note,
    limit: { mode: row.player_limit_mode, value: row.player_limit },
    players: row.players,
    alerts: row.alerts,
    addons: row.addons,
  };
}

async function readView(client: PoolClient, eventId: string): Promise<ActivationView | undefined> {
  const { rows } = await client.query<ViewRow>(VIEW_SQL, [eventId]);
  return rows[0] === undefined ? undefined : viewOf(rows[0]);
}

/** Runs a definer call; one of our refusals comes back as a result, anything else is rethrown. */
async function refusing<T>(work: () => Promise<T>): Promise<T | Refusal> {
  try {
    return await work();
  } catch (error) {
    const refusal = refusalOf(error);
    // Stryker disable next-line ConditionalExpression,BlockStatement: an unexpected database failure cannot be caused from a test without breaking the database
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

export type ActivationDeps = Readonly<{
  pool: Pool;
  /** Called after the add-ons change, so the composed configuration is read afresh (settings/service.ts). */
  onAddonsChanged: () => void;
}>;

const organizerSeat = (actor: OrganizerContext): RequestContext => teamSeat(actor);
const adminSeat = (admin: PublicAccount): RequestContext => ({
  isAdmin: true,
  staffUserId: admin.id,
});

/** The owner's side and the console's side of activation (T-210). Every write is a definer of migration 0027. */
export function createActivation(deps: ActivationDeps) {
  const inSeat: InSeat = (seat, work) =>
    refusing(() =>
      withConnection(deps.pool, (client) => withRequestContext(client, seat, () => work(client))),
    );

  return { ...teamDoors(deps, inSeat), ...lookupDoors(deps), ...adminDoors(deps, inSeat) };
}

type InSeat = <T>(
  seat: RequestContext,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T | Refusal>;

/** The owner's side: the view, the request and its withdrawal. */
function teamDoors(deps: ActivationDeps, inSeat: InSeat) {
  return {
    view: (actor: OrganizerContext, eventId: string) =>
      withConnection(deps.pool, (client) =>
        withRequestContext(client, organizerSeat(actor), () => readView(client, eventId)),
      ),

    request: (actor: OrganizerContext, eventId: string, caller: Caller): Promise<RequestResult> =>
      inSeat(organizerSeat(actor), async (client) => {
        const { rows } = await client.query<{
          outcome: "requested" | "already";
          requested_at: Date;
        }>("SELECT outcome, requested_at FROM request_event_activation($1, $2)", [
          eventId,
          caller.requestId ?? null,
        ]);
        const row = rows[0];
        // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the definer answers one row or raises
        if (row === undefined) {
          // Stryker disable next-line StringLiteral: unreachable, as above
          throw new Error("request_event_activation answered no row; check migration 0027");
        }
        return { kind: row.outcome, requestedAt: row.requested_at.toISOString() };
      }),

    withdraw: (actor: OrganizerContext, eventId: string, caller: Caller): Promise<WithdrawResult> =>
      inSeat(organizerSeat(actor), async (client) => {
        const { rows } = await client.query<{ withdrawn: boolean }>(
          "SELECT withdraw_event_activation($1, $2) AS withdrawn",
          [eventId, caller.requestId ?? null],
        );
        // Stryker disable next-line OptionalChaining,StringLiteral: equivalent: the definer always answers one row, and the route reads anything but "withdrawn" as 404
        return { kind: rows[0]?.withdrawn === true ? "withdrawn" : "none" };
      }),
  };
}

/** The console's reads: the queue, a code lookup and the event page. */
function lookupDoors(deps: ActivationDeps) {
  return {
    queue: (admin: PublicAccount): Promise<QueueItem[]> =>
      withConnection(deps.pool, (client) =>
        withRequestContext(client, adminSeat(admin), async () => {
          const { rows } = await client.query<{
            event_id: string;
            name_ar: string | null;
            name_en: string | null;
            organizer: string;
            requested_at: Date;
            starts_at: Date | null;
            timezone: string;
          }>(
            `SELECT r.event_id, e.name_ar, e.name_en, o.name AS organizer, r.requested_at, e.starts_at, e.timezone
             FROM event_activation_request r
             JOIN event e ON e.id = r.event_id
             JOIN organizer o ON o.id = e.organizer_id
             WHERE r.state = 'pending'
             ORDER BY r.requested_at, r.event_id
             LIMIT 200`,
          );
          return rows.map((row) => ({
            eventId: row.event_id,
            name: { ar: row.name_ar, en: row.name_en },
            organizer: row.organizer,
            requestedAt: row.requested_at.toISOString(),
            startsAt: row.starts_at?.toISOString() ?? null,
            timezone: row.timezone,
          }));
        }),
      ),

    findByCode: (admin: PublicAccount, code: string): Promise<string | undefined> =>
      withConnection(deps.pool, (client) =>
        withRequestContext(client, adminSeat(admin), async () => {
          const { rows } = await client.query<{ id: string }>(
            "SELECT id FROM event WHERE lower(join_code) = lower($1)",
            [code],
          );
          return rows[0]?.id;
        }),
      ),

    consoleEvent: (admin: PublicAccount, eventId: string, requestId: string) =>
      consoleEventAs(deps.pool, admin, { eventId, requestId }),
  };
}

/** The admin's writes: activate, reject and the player limit. */
function adminDoors(deps: ActivationDeps, inSeat: InSeat) {
  return {
    activate: async (
      admin: PublicAccount,
      eventId: string,
      input: Readonly<{ limit: PlayerLimit; addons: readonly string[] }>,
      caller: Caller,
    ): Promise<Done> => {
      const result = await inSeat(adminSeat(admin), async (client) => {
        await client.query("SELECT activate_event($1, $2, $3, $4, $5)", [
          eventId,
          input.limit.mode,
          input.limit.value,
          input.addons,
          caller.requestId ?? null,
        ]);
        return { kind: "done" } as const;
      });
      deps.onAddonsChanged();
      return result;
    },

    reject: (admin: PublicAccount, eventId: string, note: string, caller: Caller): Promise<Done> =>
      inSeat(adminSeat(admin), async (client) => {
        await client.query("SELECT reject_event_activation($1, $2, $3)", [
          eventId,
          note,
          caller.requestId ?? null,
        ]);
        return { kind: "done" } as const;
      }),

    setLimit: (
      admin: PublicAccount,
      eventId: string,
      limit: PlayerLimit,
      caller: Caller,
    ): Promise<Done> =>
      inSeat(adminSeat(admin), async (client) => {
        await client.query("SELECT set_event_player_limit($1, $2, $3, $4)", [
          eventId,
          limit.mode,
          limit.value,
          caller.requestId ?? null,
        ]);
        return { kind: "done" } as const;
      }),
  };
}

export type Activation = ReturnType<typeof createActivation>;

/** The console's event page in the admin's seat. */
function consoleEventAs(
  pool: Pool,
  admin: PublicAccount,
  input: Readonly<{ eventId: string; requestId: string }>,
): Promise<ConsoleEvent | undefined> {
  return withConnection(pool, (client) =>
    withRequestContext(client, adminSeat(admin), () =>
      readConsoleEvent(client, { adminId: admin.id, ...input }),
    ),
  );
}

const suspensionOf = (reason: string | null, since: Date | null): SuspensionView | null =>
  reason === null || since === null ? null : { reason, since: since.toISOString() };

async function readSupportGrants(
  client: PoolClient,
  adminId: string,
  eventId: string,
): Promise<ConsoleEvent["supportGrants"]> {
  const { rows } = await client.query<{
    id: string;
    admin_id: string;
    admin_email: string;
    opened_at: Date;
    expires_at: Date;
    kind: "view" | "edit";
  }>("SELECT * FROM event_support_grants($1)", [eventId]);
  return rows.map((row) => ({
    id: row.id,
    adminEmail: row.admin_email,
    mine: row.admin_id === adminId,
    openedAt: row.opened_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    kind: row.kind,
  }));
}

/** The console's event page (T-210, T-701): it shows the owner's email, so each read writes one audit entry (Q-116). */
async function readConsoleEvent(
  client: PoolClient,
  input: Readonly<{ adminId: string; eventId: string; requestId: string }>,
): Promise<ConsoleEvent | undefined> {
  const { eventId } = input;
  const { rows } = await client.query<{
    id: string;
    join_code: string;
    name_ar: string | null;
    name_en: string | null;
    kind: string;
    venue_ar: string | null;
    venue_en: string | null;
    status: string;
    status_now: string;
    timezone: string;
    starts_at: Date | null;
    ends_at: Date | null;
    organizer_id: string;
    organizer_name: string;
    owner_email: string | null;
    suspension_reason: string | null;
    suspended_at: Date | null;
    organizer_reason: string | null;
    organizer_suspended_at: Date | null;
  }>(
    `SELECT e.id, e.join_code, e.name_ar, e.name_en, e.kind, e.venue_ar, e.venue_en, e.status,
            event_status_now(e.status, e.starts_at, e.ends_at) AS status_now, e.timezone, e.starts_at, e.ends_at,
            o.id AS organizer_id, o.name AS organizer_name, e.suspension_reason, e.suspended_at,
            o.suspension_reason AS organizer_reason, o.suspended_at AS organizer_suspended_at,
            (SELECT s.email FROM organizer_member m JOIN staff_user s ON s.id = m.staff_user_id
             WHERE m.organizer_id = o.id AND m.role = 'owner') AS owner_email
     FROM event e JOIN organizer o ON o.id = e.organizer_id
     WHERE e.id = $1`,
    [eventId],
  );
  const row = rows[0];
  // Stryker disable next-line ConditionalExpression: equivalent: readView of a missing event is undefined too
  const view = row === undefined ? undefined : await readView(client, eventId);
  // Stryker disable next-line LogicalOperator,ConditionalExpression: equivalent: row and view are both present or both missing (the unknown-event test covers the 404)
  if (row === undefined || view === undefined) {
    return undefined;
  }
  await recordAudit(client, {
    actor: { type: "admin", id: input.adminId },
    action: "console.event_read",
    target: { type: "event", id: eventId },
    organizerId: row.organizer_id,
    eventId,
    requestId: input.requestId,
  });
  return {
    ...view,
    supportGrants: await readSupportGrants(client, input.adminId, eventId),
    history: await readHistory(client, { eventId }),
    event: {
      id: row.id,
      joinCode: row.join_code,
      name: { ar: row.name_ar, en: row.name_en },
      kind: row.kind,
      venue: { ar: row.venue_ar, en: row.venue_en },
      status: row.status,
      statusNow: row.status_now,
      timezone: row.timezone,
      startsAt: row.starts_at?.toISOString() ?? null,
      endsAt: row.ends_at?.toISOString() ?? null,
      organizer: { id: row.organizer_id, name: row.organizer_name },
      ownerEmail: row.owner_email,
      suspension: suspensionOf(row.suspension_reason, row.suspended_at),
      organizerSuspension: suspensionOf(row.organizer_reason, row.organizer_suspended_at),
    },
  };
}
