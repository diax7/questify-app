import { ANALYTICS_PANELS } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readAnalytics, type AnalyticsDeps } from "#src/analytics/analytics";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";

const params = z.object({ eventId: z.uuid(), panel: z.enum(ANALYTICS_PANELS) });

/**
 * `GET …/events/:eventId/analytics/:panel` for the team (T-607, FR-1201 to FR-1205): the participation, quest and
 * category, or reward and points figures, counts only. Owners and editors within their event limit; another
 * organizer's event is 404 and a panel that does not exist is 400.
 */
export function registerAnalyticsTeamRoutes(scope: FastifyInstance, deps: AnalyticsDeps): void {
  scope.get(
    "/events/:eventId/analytics/:panel",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId, panel } = parse(params, request.params);
      const answer = await readAnalytics(deps, organizerContextOf(request), eventId, panel);
      if (answer === undefined) {
        throw notFound();
      }
      return answer;
    },
  );
}
