import { decodeCursor, encodeCursor, parseLimit } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  banNotAllowed,
  eventFull,
  exclusionListFull,
  invalidExclusion,
  invalidRequest,
  notARequest,
  notFound,
  ownerOnly,
  requestEventOver,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  addExclusion,
  listExclusions,
  listPlayers,
  maskExclusion,
  removeExclusion,
  setBan,
  type ExclusionKind,
  type ModerationDeps,
} from "#src/moderation/moderation";
import { acceptAll, decideRequest, listRequests } from "#src/moderation/requests";
import { organizerContextOf } from "#src/organizers/context";
import { normalizeSaudiMobile } from "#src/players/phone";

const BODY_LIMIT = 1024;
const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;

const eventParams = z.object({ eventId: z.uuid() });
const playerParams = z.object({ eventId: z.uuid(), enrollmentId: z.uuid() });
const exclusionParams = z.object({ eventId: z.uuid(), exclusionId: z.uuid() });
const playersQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.string().optional(),
  q: z.string().max(30).optional(),
});
const banBody = z.strictObject({ banned: z.boolean() });
const requestsQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.string().optional(),
});
const exclusionBody = z.strictObject({
  kind: z.enum(["phone", "email_domain"]),
  value: z.string().min(1).max(260),
});

// The last label may be an internationalized TLD (`.السعودية` is xn--mgberp4a5d4ar), as migration 0019 allows.
const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** A phone as E.164 or a domain in lower case (a leading `@` is dropped), or undefined when it is neither. */
export function exclusionValue(kind: ExclusionKind, typed: string): string | undefined {
  if (kind === "phone") {
    return normalizeSaudiMobile(typed);
  }
  const domain = typed.trim().toLowerCase().replace(/^@/, "");
  return domain.length <= 253 && DOMAIN.test(domain) ? domain : undefined;
}

function pageOf(query: Readonly<{ cursor?: string | undefined; limit?: string | undefined }>): {
  afterId: string | null;
  limit: number;
} {
  try {
    const afterId =
      query.cursor === undefined ? null : z.uuid().parse(decodeCursor(query.cursor)["id"]);
    return { afterId, limit: parseLimit(query.limit) };
  } catch {
    throw invalidRequest();
  }
}

/**
 * The event team's view of its players and their standing (T-208), inside the organizer scope: the list for members,
 * bans and the exclusion list for the owner. The database checks the membership, the event limit and the owner again.
 */
export function registerModerationRoutes(scope: FastifyInstance, deps: ModerationDeps): void {
  scope.get("/events/:eventId/players", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const query = parse(playersQuery, request.query);
    const { afterId, limit } = pageOf(query);
    const players = await listPlayers(deps, organizerContextOf(request), {
      eventId,
      afterId,
      limit,
      prefix: query.q?.trim() || null,
    });
    if (players === null) {
      throw notFound();
    }
    const last = players.at(-1);
    return {
      players,
      nextCursor:
        players.length === limit && last !== undefined
          ? encodeCursor({ id: last.enrollmentId })
          : null,
    };
  });

  // FR-321, FR-1605: the owner bans a player from the event or lifts the ban; the record stays.
  scope.put("/events/:eventId/players/:enrollmentId/ban", owner, async (request) => {
    const { eventId, enrollmentId } = parse(playerParams, request.params);
    const { banned } = parse(banBody, request.body);
    const outcome = await setBan(deps, organizerContextOf(request), {
      eventId,
      enrollmentId,
      banned,
      requestId: request.id,
    });
    switch (outcome) {
      case "changed":
      case "unchanged":
        return { banned };
      case "not_found":
        throw notFound();
      case "not_owner":
        throw ownerOnly();
      case "not_allowed":
        throw banNotAllowed();
    }
  });

  scope.get("/events/:eventId/exclusions", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const exclusions = await listExclusions(deps, organizerContextOf(request), eventId);
    if (exclusions === null) {
      throw notFound();
    }
    return { exclusions };
  });

  // FR-319: phones and email domains that never appear on the event's boards; they still play.
  scope.post("/events/:eventId/exclusions", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(exclusionBody, request.body);
    const value = exclusionValue(body.kind, body.value);
    if (value === undefined) {
      throw invalidExclusion({ kind: body.kind });
    }
    const outcome = await addExclusion(deps, organizerContextOf(request), {
      eventId,
      kind: body.kind,
      value,
      requestId: request.id,
    });
    switch (outcome.kind) {
      case "added":
      case "existing":
        return reply.code(outcome.kind === "added" ? 201 : 200).send({
          exclusion: { id: outcome.id, kind: body.kind, value: maskExclusion(body.kind, value) },
        });
      case "not_found":
        throw notFound();
      case "not_owner":
        throw ownerOnly();
      case "full":
        throw exclusionListFull();
    }
  });

  scope.delete("/events/:eventId/exclusions/:exclusionId", owner, async (request, reply) => {
    const { eventId, exclusionId } = parse(exclusionParams, request.params);
    const outcome = await removeExclusion(deps, organizerContextOf(request), {
      eventId,
      exclusionId,
      requestId: request.id,
    });
    switch (outcome) {
      case "removed":
        return reply.code(204).send();
      case "not_found":
        throw notFound();
      case "not_owner":
        throw ownerOnly();
    }
  });
  registerRequestRoutes(scope, deps);
}

/**
 * The event's join requests and waiting list (T-218, FR-1819, FR-1821): the owner and editors list, accept, decline and
 * accept all. The database checks the caller's event limit, the seat and the event's state again, and audits.
 */
function registerRequestRoutes(scope: FastifyInstance, deps: ModerationDeps): void {
  scope.get("/events/:eventId/join-requests", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { afterId, limit } = pageOf(parse(requestsQuery, request.query));
    const page = await listRequests(deps, organizerContextOf(request), {
      eventId,
      afterId,
      limit,
    });
    if (page === null) {
      throw notFound();
    }
    const { requests, pending } = page;
    const last = requests.at(-1);
    return {
      requests,
      pending,
      nextCursor:
        requests.length === limit && last !== undefined
          ? encodeCursor({ id: last.enrollmentId })
          : null,
    };
  });

  for (const [path, accept] of [
    ["accept", true],
    ["decline", false],
  ] as const) {
    scope.post(`/events/:eventId/join-requests/:enrollmentId/${path}`, member, async (request) => {
      const { eventId, enrollmentId } = parse(playerParams, request.params);
      const outcome = await decideRequest(deps, organizerContextOf(request), {
        eventId,
        enrollmentId,
        accept,
        requestId: request.id,
      });
      switch (outcome) {
        case "accepted":
        case "unchanged":
        case "declined":
          return { status: accept ? "active" : "declined" };
        case "not_found":
          throw notFound();
        case "not_allowed":
          throw notARequest();
        case "ended":
          throw requestEventOver();
        case "full":
          throw eventFull();
      }
    });
  }

  scope.post("/events/:eventId/join-requests/accept-all", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const outcome = await acceptAll(deps, organizerContextOf(request), {
      eventId,
      requestId: request.id,
    });
    switch (outcome.kind) {
      case "done":
        return { accepted: outcome.accepted, remaining: outcome.remaining };
      case "not_found":
        throw notFound();
      case "ended":
        throw requestEventOver();
    }
  });
}
