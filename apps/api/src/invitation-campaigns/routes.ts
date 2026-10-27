import { createHash } from "node:crypto";
import {
  invitationApproveBodySchema,
  invitationNoteBodySchema,
  invitationOpenBodySchema,
  invitationRequestBodySchema,
} from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { addressBucket } from "#src/auth/normalize";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { holdBack } from "#src/devices/limits";
import {
  approveCampaign,
  campaignDetail,
  campaignQueue,
  cancelCampaign,
  closeCampaign,
  listCampaigns,
  openInvitation,
  requestCampaign,
  type InvitationDeps,
} from "#src/invitation-campaigns/campaigns";
import { organizerContextOf } from "#src/organizers/context";

const BODY_LIMIT = 4096;
const eventParams = z.object({ eventId: z.uuid() });
const campaignParams = z.object({ eventId: z.uuid(), campaignId: z.uuid() });
const consoleParams = z.object({ campaignId: z.uuid() });
const empty = z.union([z.strictObject({}), z.null(), z.undefined()]);
/** At most 120 opens an hour per address: a person opens a few, a link scanner many. */
const OPEN_LIMIT = { bucket: BUCKETS.invitationOpen, max: 120, windowSeconds: 3600 } as const;

/**
 * The request's key in the database (`request_id`): one UUID per caller, organizer, path and Idempotency-Key, so a
 * retry after a crash replays the first campaign instead of asking twice; no raw key is stored.
 */
function requestKeyOf(request: FastifyRequest): string {
  const actor = organizerContextOf(request);
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        actor.organizerId,
        actor.staffUserId,
        request.url.split("?")[0],
        request.headers["idempotency-key"],
      ]),
    )
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * The owner's side (T-409, FR-738, FR-739), inside the organizer scope (whose hook answers 404 to a non-member and 403
 * `owner_only` to an editor on an owner route): owners and editors in scope read the event's campaigns with rounded
 * counts; only the owner requests (with an Idempotency-Key) or withdraws one. Nothing here holds a price.
 */
export function registerInvitationTeamRoutes(scope: FastifyInstance, deps: InvitationDeps): void {
  const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
  const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;

  scope.get("/events/:eventId/invitation-campaigns", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return listCampaigns(deps.pool, organizerContextOf(request), eventId);
  });

  scope.post(
    "/events/:eventId/invitation-campaigns",
    { ...owner, config: { ...owner.config, idempotent: true } },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(invitationRequestBodySchema, request.body);
      const campaign = await requestCampaign(deps.pool, organizerContextOf(request), {
        eventId,
        body,
        requestId: requestKeyOf(request),
      });
      return reply.code(201).send({ campaign });
    },
  );

  scope.delete(
    "/events/:eventId/invitation-campaigns/:campaignId",
    owner,
    async (request, reply) => {
      const { eventId, campaignId } = parse(campaignParams, request.params);
      parse(empty, request.body);
      await cancelCampaign(deps.pool, organizerContextOf(request), {
        eventId,
        body: { campaignId },
        requestId: request.id,
      });
      return reply.code(204).send();
    },
  );
}

/** The admin of a request that passed the console hook (activation/routes.ts). */
function adminIdOf(request: FastifyRequest): string {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) throw notFound();
  return account.id;
}

/**
 * The console's side (T-409, ADR-329): the queue, one campaign with its exact counts, the audience estimate and the
 * rendered messages, and the approval, refusal and cancel, each with an Idempotency-Key. Registered inside the console
 * scope, whose hook answers 404 to anyone but an active platform admin and sets `no-store`.
 */
export function registerConsoleInvitationRoutes(
  scope: FastifyInstance,
  deps: InvitationDeps,
): void {
  const read = { config: { access: "admin" }, bodyLimit: BODY_LIMIT } as const;
  const write = { ...read, config: { ...read.config, idempotent: true } } as const;

  scope.get("/invitation-campaigns", read, async (request) =>
    campaignQueue(deps.pool, adminIdOf(request)),
  );

  scope.get("/invitation-campaigns/:campaignId", read, async (request) => {
    const { campaignId } = parse(consoleParams, request.params);
    return campaignDetail(deps, adminIdOf(request), campaignId);
  });

  scope.post("/invitation-campaigns/:campaignId/approve", write, async (request) => {
    const { campaignId } = parse(consoleParams, request.params);
    const body = parse(invitationApproveBodySchema, request.body);
    return approveCampaign(deps, adminIdOf(request), { campaignId, body, requestId: request.id });
  });

  for (const action of ["refuse", "cancel"] as const) {
    scope.post(`/invitation-campaigns/:campaignId/${action}`, write, async (request) => {
      const { campaignId } = parse(consoleParams, request.params);
      const body = parse(invitationNoteBodySchema, request.body);
      const campaign = await closeCampaign(deps.pool, adminIdOf(request), action, {
        campaignId,
        body,
        requestId: request.id,
      });
      return { campaign };
    });
  }
}

/**
 * The invitation landing page's door (ADR-332 (2)): anonymous, its own address bucket counted before the token is
 * read (so guessed tokens are throttled like real ones), never cached. The answer is the public event card only.
 */
export function registerInvitationOpenRoute(
  app: FastifyInstance,
  deps: Readonly<{ pool: InvitationDeps["pool"]; keys: Pick<AuthKeys, "addressKey"> }>,
): void {
  app.post(
    "/v1/public/invitation-open",
    { config: { access: "public" }, bodyLimit: 512 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      await holdBack(
        deps.pool,
        [{ limit: OPEN_LIMIT, key: deps.keys.addressKey(addressBucket(request.ip)) }],
        true,
        reply,
      );
      const { token } = parse(invitationOpenBodySchema, request.body);
      return openInvitation(deps.pool, token);
    },
  );
}
