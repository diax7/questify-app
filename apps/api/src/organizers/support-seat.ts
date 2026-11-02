import type { Pool } from "pg";
import type { PublicAccount } from "#src/auth/staff-store";
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
  const verb = method === "HEAD" ? "GET" : method;
  const key = `${verb} ${routeUrl.slice(ORGANIZER_PREFIX.length)}`;
  if (REFUSED_IN_EVENT.has(key)) {
    return false;
  }
  if (params.eventId !== undefined) {
    return principal.eventScope?.includes(params.eventId) === true;
  }
  return SHELL_READS.has(key);
}
