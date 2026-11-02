import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import { readReadiness, readReadinessSoon, type ReadinessDeps } from "#src/readiness/readiness";

const eventParams = z.object({ eventId: z.uuid() });

/**
 * `GET …/events/:eventId/readiness` for the team (T-618, FR-1845): the go-live checklist, each item done, a warning or
 * blocking, with the numbers its words show. It reads and blocks nothing. Owners and editors within their event limit;
 * another organizer's event is 404.
 */
export function registerReadinessTeamRoutes(scope: FastifyInstance, deps: ReadinessDeps): void {
  scope.get(
    "/events/:eventId/readiness",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId } = parse(eventParams, request.params);
      const readiness = await readReadiness(deps, organizerContextOf(request), eventId);
      if (readiness === undefined) {
        throw notFound();
      }
      return readiness;
    },
  );
}

/**
 * `GET /v1/admin/readiness` (T-618, FR-1845): registered inside the console scope, whose hook answers 404 to anyone but
 * an active platform admin and sets `no-store`. Read only; names, times and checklist counts, no personal data, so
 * nothing is audited.
 */
export function registerConsoleReadinessRoutes(scope: FastifyInstance, deps: ReadinessDeps): void {
  scope.get("/readiness", { config: { access: "admin" }, bodyLimit: 1024 }, async (request) => {
    const account = request.staff?.account;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
    if (account === undefined) throw notFound();
    return readReadinessSoon(deps.pool, account.id);
  });
}
