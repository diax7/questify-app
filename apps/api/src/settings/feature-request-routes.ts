import { REGISTRIES, featureRequestBodySchema, isGatedFeature } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { AuthKeys } from "#src/auth/keys";
import {
  addonAlreadyUnlocked,
  notFound,
  ownerOnly,
  requestDeclinedRecently,
  unknownAddon,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { PublicAccount } from "#src/auth/staff-store";
import { BUCKETS } from "#src/auth/throttle";
import { CONSOLE_CATALOG_LIMIT, CONSOLE_CATALOG_WRITE_LIMIT } from "#src/console/catalog-routes";
import type { ConsolePlatformDeps } from "#src/console/platform-routes";
import { throttled } from "#src/console/throttle";
import { holdBack, type DeviceLimit } from "#src/devices/limits";
import { organizerContextOf } from "#src/organizers/context";
import {
  askForFeature,
  createFeatureRequestQueue,
  type AskOutcome,
} from "#src/settings/feature-requests";

const BODY_LIMIT = 1024;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;
const admin = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;
const eventParams = z.object({ eventId: z.uuid() });
const requestParams = z.object({ requestId: z.uuid() });
const queueQuery = z
  .strictObject({ afterAt: z.iso.datetime().optional(), afterId: z.uuid().optional() })
  .refine((query) => (query.afterAt === undefined) === (query.afterId === undefined));

/** Ask Questify requests per staff account (ADR-545): far above an owner's real use, on top of the one-open rule. */
export const FEATURE_REQUEST_LIMIT: DeviceLimit = {
  bucket: BUCKETS.featureRequest,
  max: 20,
  windowSeconds: 3600,
};

/** The door's outcome as the answer: the request (201 new, 200 the open one again), or the refusal. */
function answerOf(outcome: AskOutcome, reply: FastifyReply): unknown {
  switch (outcome.kind) {
    case "created":
    case "already_open":
      reply.code(outcome.kind === "created" ? 201 : 200);
      return { request: outcome.request };
    case "owner_only":
      throw ownerOnly();
    case "not_addon":
      throw unknownAddon();
    case "unlocked":
      throw addonAlreadyUnlocked();
    case "declined_recently": {
      const wait = Math.max(1, Math.ceil((Date.parse(outcome.retryAt) - Date.now()) / 1000));
      reply.header("retry-after", String(wait));
      throw requestDeclinedRecently({ retryAt: outcome.retryAt, retryAfterSeconds: wait });
    }
    default:
      throw notFound();
  }
}

/**
 * The owner's Ask Questify for an add-on of one of the organizer's events (T-711b, FR-1827), inside the organizer scope
 * whose hook checks the session and the owner role (`access: owner`); the database checks the owner again
 * (`request_feature`, RQ403) and keeps one open request per event and add-on. A staff route: maintenance's play doors do
 * not apply.
 */
export function registerFeatureRequestTeamRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool; keys: Pick<AuthKeys, "userKey"> }>,
): void {
  scope.post("/events/:eventId/feature-requests", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { feature } = parse(featureRequestBodySchema, request.body);
    if (!isGatedFeature(REGISTRIES, feature)) {
      throw unknownAddon({ feature });
    }
    const context = organizerContextOf(request);
    const key = deps.keys.userKey(`${BUCKETS.featureRequest}:${context.staffUserId}`);
    await holdBack(deps.pool, [{ limit: FEATURE_REQUEST_LIMIT, key }], true, reply);
    const outcome = await askForFeature(deps.pool, context, {
      eventId,
      feature,
      requestId: request.id,
    });
    return answerOf(outcome, reply);
  });
}

/** The admin of a request that passed the console hook. */
function adminOf(request: FastifyRequest): PublicAccount {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return account;
}

/**
 * The console's Requests list and its Decline (T-711b), inside the console scope whose hook answers 404 to anyone but an
 * active platform admin. Allow is the add-on unlock (`PUT /v1/admin/events/{id}/addons/{feature}`), which closes the
 * request in its own transaction.
 */
export function registerConsoleFeatureRequestRoutes(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
): void {
  const queue = createFeatureRequestQueue(deps.pool);

  scope.get("/feature-requests", admin, async (request, reply) => {
    const query = parse(queueQuery, request.query);
    await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    const cursor =
      query.afterAt === undefined || query.afterId === undefined
        ? undefined
        : { afterAt: query.afterAt, afterId: query.afterId };
    const page = await queue.list(adminOf(request), cursor);
    if (page === undefined) {
      throw notFound();
    }
    return page;
  });

  scope.post("/feature-requests/:requestId/decline", admin, async (request, reply) => {
    const { requestId } = parse(requestParams, request.params);
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    const outcome = await queue.decline(adminOf(request), requestId, { requestId: request.id });
    if (outcome === "not_found") {
      throw notFound();
    }
    return reply.code(204).send();
  });
}
