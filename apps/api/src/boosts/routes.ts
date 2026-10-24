import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  boostEventEnded,
  boostNotStarted,
  boostOverlap,
  boostStarted,
  invalidBoost,
  limitReached,
  notFound,
  platformFeatureOff,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  boostBody,
  deleteBoost,
  listBoosts,
  saveBoost,
  stopBoost,
  type BoostDeps,
  type BoostDone,
  type BoostRefusal,
} from "#src/boosts/boosts";
import { organizerContextOf } from "#src/organizers/context";

const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 1024 } as const;

const eventParams = z.object({ eventId: z.uuid() });
const boostParams = z.object({ eventId: z.uuid(), boostId: z.uuid() });
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);

/** One HTTP answer per refusal (API.md, boosts). */
function refuse(result: BoostRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "invalid":
      throw invalidBoost({ issues: result.issues });
    case "boost_overlap":
      throw boostOverlap();
    case "boost_started":
      throw boostStarted();
    case "not_started":
      throw boostNotStarted();
    case "event_ended":
      throw boostEventEnded();
    case "limit_reached":
      throw limitReached({ limit: result.limit });
    case "feature_off":
      throw platformFeatureOff();
  }
}

const valueOf = <T>(result: BoostDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

/** The body checked here first, with the fields at fault named (`invalid_boost {issues}`). */
const bodyOf = (body: unknown) => {
  const result = boostBody.safeParse(body);
  if (!result.success) {
    throw invalidBoost({
      issues: [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "boost"))],
    });
  }
  return result.data;
};

/**
 * Double-point boosts in the organizer scope (T-307, FR-252): the event's boosts for owners and editors (`GET`, and
 * `POST`, `PATCH`, `DELETE` and Stop with an Idempotency-Key).
 */
export function registerBoostTeamRoutes(scope: FastifyInstance, deps: BoostDeps): void {
  scope.get("/events/:eventId/boosts", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return { boosts: valueOf(await listBoosts(deps, organizerContextOf(request), eventId)) };
  });

  scope.post("/events/:eventId/boosts", writing, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = bodyOf(request.body);
    const boost = valueOf(
      await saveBoost(deps, organizerContextOf(request), {
        eventId,
        boostId: null,
        body,
        requestId: request.id,
      }),
    );
    return reply.code(201).send({ boost });
  });

  scope.patch("/events/:eventId/boosts/:boostId", writing, async (request) => {
    const { eventId, boostId } = parse(boostParams, request.params);
    const body = bodyOf(request.body);
    const boost = valueOf(
      await saveBoost(deps, organizerContextOf(request), {
        eventId,
        boostId,
        body,
        requestId: request.id,
      }),
    );
    return { boost };
  });

  scope.delete("/events/:eventId/boosts/:boostId", writing, async (request, reply) => {
    const { eventId, boostId } = parse(boostParams, request.params);
    valueOf(
      await deleteBoost(deps, organizerContextOf(request), {
        eventId,
        boostId,
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });

  scope.post("/events/:eventId/boosts/:boostId/end", writing, async (request) => {
    const { eventId, boostId } = parse(boostParams, request.params);
    parse(emptyBody, request.body);
    return valueOf(
      await stopBoost(deps, organizerContextOf(request), {
        eventId,
        boostId,
        requestId: request.id,
      }),
    );
  });
}
