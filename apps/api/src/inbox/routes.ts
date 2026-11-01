import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { readInbox, type InboxDeps } from "#src/inbox/inbox";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });

/**
 * `GET …/events/:eventId/inbox` for the team (T-616, FR-1825): the counts of what waits, the open help requests by
 * kind, the escalated ones, the join requests, the submissions and the flags. Counts only; the lists live on the Help
 * desk, Submissions, Flagged activity and Players pages. Owners and editors within their event limit; another
 * organizer's event is 404.
 */
export function registerInboxTeamRoutes(scope: FastifyInstance, deps: InboxDeps): void {
  scope.get(
    "/events/:eventId/inbox",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId } = parse(eventParams, request.params);
      const inbox = await readInbox(deps, organizerContextOf(request), eventId);
      if (inbox === undefined) {
        throw notFound();
      }
      return inbox;
    },
  );
}
