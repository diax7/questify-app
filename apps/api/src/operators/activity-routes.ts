import {
  OPERATOR_RECENT_FIRST,
  OPERATOR_RECENT_MAX,
  checkStaffBriefing,
  staffBriefingBodySchema,
} from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "#src/auth/request";
import {
  briefingError,
  readOperatorActivity,
  sendStaffBriefing,
  type OperatorActivityDeps,
} from "#src/operators/activity";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
const activityQuery = z.strictObject({
  recent: z.coerce.number().int().min(1).max(OPERATOR_RECENT_MAX).default(OPERATOR_RECENT_FIRST),
});

/**
 * The operators page's activity and briefing (T-617, FR-1844) for the event's team: `GET …/operators/activity` reads
 * what each operator did and the latest actions; `POST …/operators/briefing` sends a short push to the event's operators
 * and to no player. Owners and editors within their event limit; another organizer's event is 404. A briefing is
 * cleaned and checked like an announcement (a 140-character text is the whole push) and sent once per Idempotency-Key.
 */
export function registerOperatorActivityRoutes(
  scope: FastifyInstance,
  deps: OperatorActivityDeps,
): void {
  scope.get(
    "/events/:eventId/operators/activity",
    { config: { access: "member" }, bodyLimit: 1024 },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId } = parse(eventParams, request.params);
      const { recent } = parse(activityQuery, request.query);
      return readOperatorActivity(deps, organizerContextOf(request), eventId, recent);
    },
  );
  scope.post(
    "/events/:eventId/operators/briefing",
    { config: { access: "member", idempotent: true }, bodyLimit: 8_000 },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const parsed = staffBriefingBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw briefingError(422, "invalid_briefing", {
          field: parsed.error.issues[0]?.path[0] ?? "briefing",
          issue: "invalid",
        });
      }
      const checked = checkStaffBriefing(parsed.data);
      if (!checked.ok) {
        throw briefingError(422, "invalid_briefing", {
          field: checked.field,
          issue: checked.issue,
        });
      }
      const sent = await sendStaffBriefing(deps, organizerContextOf(request), {
        eventId,
        draft: checked.draft,
        key: String(request.headers["idempotency-key"]),
        requestId: request.id,
      });
      return reply.code(201).send(sent);
    },
  );
}
