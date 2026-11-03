import type { Pool } from "pg";
import type { PublicAccount, SupportGrant } from "#src/auth/staff-store";
import { listMemberships } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerPrincipal } from "#src/organizers/store";
import { ORGANIZER_PREFIX } from "#src/route-access";

/**
 * Inside a granted event, support never pairs a device (a station would keep scanning after the grant ends) and never
 * exports players' data (review MAJOR 3). Keys are the method and the route pattern below the organizer prefix.
 */
const REFUSED_IN_EVENT = new Set([
  "POST /events/:eventId/devices",
  "POST /events/:eventId/devices/preview",
  "POST /events/:eventId/exports/:kind",
]);

/**
 * A view (T-712, ADR-524) also never reads the printed quest codes (secrets that pay points) nor the rehearsal card, whose
 * first read before go-live opens the rehearsal and makes a join code (a write; plan review MAJOR 1).
 */
const REFUSED_IN_VIEW = new Set(["GET /events/:eventId/codes", "GET /events/:eventId/rehearsal"]);

/** The only routes without an event that support may use: what the dashboard's frame reads (the events list). */
const SHELL_READS = new Set(["GET /events"]);

/**
 * The principal of a Questify admin with a live support grant in this organizer (ADR-407), or undefined. Only an
 * active platform admin gets one; the database checks the grant again on every statement (app_organizer_id).
 */
export async function supportSeatOf(
  pool: Pool,
  account: PublicAccount,
  organizerId: string,
): Promise<OrganizerPrincipal | undefined> {
  if (account.platformRole !== "admin" || account.status !== "active") {
    return undefined;
  }
  const seats = await withConnection(pool, (client) =>
    withRequestContext(client, { staffUserId: account.id }, () =>
      listMemberships(client, account.id),
    ),
  );
  const seat = seats.find((item) => item.organizerId === organizerId && item.support !== undefined);
  return seat?.support === undefined
    ? undefined
    : {
        id: organizerId,
        role: "editor",
        eventScope: seat.support.map((grant) => grant.eventId),
        suspension: seat.suspension,
        support: seat.support,
      };
}

/**
 * Deny by default for support (review MAJOR 3): a route with `:eventId` only for a granted event and not on the
 * refused list, and otherwise only the frame's reads. Everything else answers as a route of an organizer the admin
 * cannot see.
 */
export function supportMayUse(
  method: string,
  routeUrl: string,
  params: Readonly<{ eventId?: string }>,
  principal: OrganizerPrincipal,
): boolean {
  const key = routeKeyOf(method, routeUrl);
  if (REFUSED_IN_EVENT.has(key)) {
    return false;
  }
  if (REFUSED_IN_VIEW.has(key) && viewGrantOf(params, principal) !== undefined) {
    return false;
  }
  if (params.eventId !== undefined) {
    return principal.eventScope?.includes(params.eventId) === true;
  }
  return SHELL_READS.has(key);
}

/** The method (HEAD read as GET) and the route pattern below the organizer prefix: the refused lists' and the log's key. */
export function routeKeyOf(method: string, routeUrl: string): string {
  const verb = method === "HEAD" ? "GET" : method;
  return `${verb} ${routeUrl.slice(ORGANIZER_PREFIX.length)}`;
}

/**
 * The `view` grant this request runs under (T-712, ADR-521), or undefined: the grant of the request's event when it is a
 * view; without an event, the first view grant held in this organizer (an event-less read under a view is read-only).
 */
export function viewGrantOf(
  params: Readonly<{ eventId?: string }>,
  principal: OrganizerPrincipal,
): SupportGrant | undefined {
  const grants = principal.support ?? [];
  if (params.eventId !== undefined) {
    return grants.find((grant) => grant.eventId === params.eventId && grant.kind === "view");
  }
  return grants.find((grant) => grant.kind === "view");
}
