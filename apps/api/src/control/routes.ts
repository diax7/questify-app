import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { ControlReader } from "#src/control/control";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });

/**
 * `GET …/events/:eventId/control` for the team (T-603, FR-1024, FR-1028): the live control room's one poll. The newest
 * completions (username and avatar the team already reads, never a contact detail or points), the counters, and the
 * players who completed each quest. Owners and editors within their event limit; another organizer's event is 404.
 */
export function registerControlTeamRoutes(scope: FastifyInstance, reader: ControlReader): void {
  scope.get(
    "/events/:eventId/control",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request) => {
      const { eventId } = parse(eventParams, request.params);
      const view = await reader.read(organizerContextOf(request), eventId);
      if (view === undefined) {
        throw notFound();
      }
      return view;
    },
  );
}
