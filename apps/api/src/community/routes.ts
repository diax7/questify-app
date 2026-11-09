import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  communitySettling,
  goalEventEnded,
  goalLocked,
  goalOverlap,
  goalStarted,
  invalidGoal,
  limitReached,
  notFound,
  ownerOnly,
  platformFeatureOff,
  unlockTaken,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  deleteGoal,
  goalBody,
  listGoals,
  saveGoal,
  type CommunityDeps,
  type CommunityDone,
  type CommunityRefusal,
} from "#src/community/goals";
import { settleAndPay } from "#src/community/payer";
import { organizerContextOf } from "#src/organizers/context";
import { refusalThrower } from "#src/refusal-table";

const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 16 * 1024 } as const;
const owner = { config: { access: "owner", idempotent: true }, bodyLimit: 1024 } as const;

const eventParams = z.object({ eventId: z.uuid() });
const goalParams = z.object({ eventId: z.uuid(), goalId: z.uuid() });
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);
/** Seconds the dashboard waits before settling again while a transaction from the window is open. */
const SETTLING_RETRY_SECONDS = 5;

/** One HTTP answer per refusal (API.md, community quests). */
export function refuse(reply: FastifyReply, result: CommunityRefusal): never {
  return refuseCommunity(result, reply);
}

const refuseCommunity = refusalThrower<CommunityRefusal, [reply: FastifyReply]>({
  not_found: () => notFound(),
  invalid: (result) => invalidGoal({ issues: result.issues }),
  overlap: () => goalOverlap(),
  unlock_taken: () => unlockTaken(),
  locked: (result) => goalLocked({ field: result.field }),
  started: () => goalStarted(),
  event_ended: () => goalEventEnded(),
  limit_reached: (result) => limitReached({ limit: result.limit }),
  feature_off: () => platformFeatureOff(),
  owner_only: () => ownerOnly(),
  settling: (_result, reply) => {
    reply.header("retry-after", String(SETTLING_RETRY_SECONDS));
    return communitySettling();
  },
});

const valueOf = <T>(reply: FastifyReply, result: CommunityDone<T>): T =>
  result.kind === "done" ? result.value : refuse(reply, result);

/** The body checked here first, with the fields at fault named (`invalid_goal {issues}`). */
const bodyOf = (body: unknown) => {
  const result = goalBody.safeParse(body);
  if (!result.success) {
    throw invalidGoal({
      issues: [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "goal"))],
    });
  }
  return result.data;
};

/**
 * Community quests in the organizer scope (T-306b, F-101): the event's goals for owners and editors (`GET`, and `POST`,
 * `PATCH` and `DELETE` with an Idempotency-Key), and the owner's "Settle and pay now" (`POST …/community/settle`).
 */
export function registerCommunityTeamRoutes(scope: FastifyInstance, deps: CommunityDeps): void {
  scope.get("/events/:eventId/community-goals", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    return { goals: valueOf(reply, await listGoals(deps, organizerContextOf(request), eventId)) };
  });

  scope.post("/events/:eventId/community-goals", writing, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = bodyOf(request.body);
    const goal = valueOf(
      reply,
      await saveGoal(deps, organizerContextOf(request), {
        eventId,
        goalId: null,
        body,
        requestId: request.id,
      }),
    );
    return reply.code(201).send({ goal });
  });

  scope.patch("/events/:eventId/community-goals/:goalId", writing, async (request, reply) => {
    const { eventId, goalId } = parse(goalParams, request.params);
    const body = bodyOf(request.body);
    const goal = valueOf(
      reply,
      await saveGoal(deps, organizerContextOf(request), {
        eventId,
        goalId,
        body,
        requestId: request.id,
      }),
    );
    return { goal };
  });

  scope.delete("/events/:eventId/community-goals/:goalId", writing, async (request, reply) => {
    const { eventId, goalId } = parse(goalParams, request.params);
    valueOf(
      reply,
      await deleteGoal(deps, organizerContextOf(request), {
        eventId,
        goalId,
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });

  scope.post("/events/:eventId/community/settle", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    parse(emptyBody, request.body);
    return valueOf(
      reply,
      await settleAndPay(deps, organizerContextOf(request), { eventId, requestId: request.id }),
    );
  });
}
