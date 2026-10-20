import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { notFound, ownerOnly, unauthenticated } from "#src/auth/http-errors";
import type { Sessions } from "#src/auth/session";
import { checkOrigin, requireSession } from "#src/auth/staff-guard";
import {
  membershipOf,
  readTeam,
  type OrganizerContext,
  type OrganizerPrincipal,
} from "#src/organizers/store";
import { ORGANIZER_PREFIX } from "#src/route-access";

export type OrganizerRoutesDeps = Readonly<{
  pool: Pool;
  sessions: Sessions;
  dashboardOrigin: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller and the organizer they are a member of; only reachable after the scope's hook. */
export function organizerContextOf(
  request: FastifyRequest,
): OrganizerContext & { organizer: OrganizerPrincipal } {
  const staff = request.staff;
  const organizer = request.organizer;
  if (staff === undefined || organizer === undefined) {
    // Reached only if the scope's hook was bypassed, which must never answer a request.
    throw unauthenticated();
  }
  return { staffUserId: staff.account.id, organizerId: organizer.id, organizer };
}

/**
 * Registers every /v1/organizers/:organizerId route in one scope. Its hook runs the staff checks (no-store, Origin,
 * session), then reads the caller's membership of that organizer from the database: a non-member gets 404, the same
 * as an organizer that does not exist, and an editor on an `owner` route gets 403. The database checks the
 * membership again on every query (migration 0008).
 */
export function registerOrganizerRoutes(app: FastifyInstance, deps: OrganizerRoutesDeps): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        checkOrigin(request, deps.dashboardOrigin, true);
        await requireSession(request, reply, deps.sessions);
        const { organizerId } = request.params as { organizerId?: string };
        const staff = request.staff;
        if (organizerId === undefined || !UUID.test(organizerId) || staff === undefined) {
          throw notFound();
        }
        const membership = await membershipOf(
          deps.pool,
          staff.account.id,
          organizerId.toLowerCase(),
        );
        if (membership === undefined) {
          throw notFound();
        }
        if (request.routeOptions.config.access === "owner" && membership.role !== "owner") {
          throw ownerOnly();
        }
        request.organizer = membership;
      });

      scope.get("/members", { config: { access: "member" } }, async (request) =>
        readTeam(deps.pool, organizerContextOf(request)),
      );
    },
    { prefix: ORGANIZER_PREFIX },
  );
}
