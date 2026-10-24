import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  badDeadline,
  communityPaying,
  deskClosedUntilDeadline,
  deskNeeded,
  eventArchived,
  invalidRequest,
  limitReached,
  notFound,
  ownerOnly,
  prizeOverlap,
  prizeRemoved,
  prizesLocked,
  resultsChanged,
  resultsFinal,
  resultsNotConfirmed,
  resultsNotEnded,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import {
  PRIZE_KINDS,
  confirmResults,
  createPrize,
  listPrizes,
  memberRules,
  playerResults,
  readResults,
  removePrize,
  revealResults,
  updatePrize,
  updatePrizeSettings,
  type ResultsDeps,
  type ResultsDone,
  type ResultsRefusal,
} from "#src/results/results";

const member = { config: { access: "member" }, bodyLimit: 32 * 1024 } as const;
const creating = { ...member, config: { ...member.config, idempotent: true } } as const;
const owner = { config: { access: "owner" }, bodyLimit: 8 * 1024 } as const;
const player = { config: { access: "player" } } as const;

const eventParams = z.object({ eventId: z.uuid() });
const prizeParams = z.object({ eventId: z.uuid(), prizeId: z.uuid() });
const rank = z.number().int().min(1).max(100);
const text = (max: number) =>
  z.strictObject({ ar: z.string().max(max).nullish(), en: z.string().max(max).nullish() });
const prizeFields = {
  rankFrom: rank.optional(),
  rankTo: rank.optional(),
  name: text(120).optional(),
  description: text(2000).optional(),
};
const prizeBody = z.strictObject({
  ...prizeFields,
  kind: z.enum(PRIZE_KINDS),
  rankFrom: rank,
  rankTo: rank,
});
const prizePatch = z.strictObject(prizeFields);
const settingsBody = z.strictObject({
  rankPrizes: z.boolean().optional(),
  rules: text(10_000).optional(),
});
const confirmBody = z.strictObject({ expected: z.array(z.uuid()).max(100) });
const revealBody = z.strictObject({ claimUntil: z.iso.datetime({ offset: true }) });

function refuse(result: ResultsRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "event_archived":
      throw eventArchived();
    case "invalid":
      throw invalidRequest({ field: result.field });
    case "limit_reached":
      throw limitReached({ limit: result.limit });
    case "owner_only":
      throw ownerOnly();
    case "desk_needed":
      throw deskNeeded();
    case "prizes_locked":
      throw prizesLocked();
    case "overlap":
      throw prizeOverlap();
    case "removed":
      throw prizeRemoved();
    case "results_final":
      throw resultsFinal();
    case "not_ended":
      throw resultsNotEnded();
    case "results_changed":
      throw resultsChanged();
    case "not_confirmed":
      throw resultsNotConfirmed();
    case "bad_deadline":
      throw badDeadline();
    case "desk_closed_until_deadline":
      throw deskClosedUntilDeadline();
    case "community_paying":
      throw communityPaying({ goals: result.goals, due: result.due });
  }
}

const valueOf = <T>(result: ResultsDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

/**
 * Rank prizes and final results in the organizer scope (T-214): `GET|POST …/events/:eventId/rank-prizes`,
 * `PATCH|DELETE …/rank-prizes/:prizeId`, `PUT …/rank-prizes` for the switch and the rules text (owners and editors);
 * `GET …/results` (owners and editors), `POST …/results/confirm` and `…/results/reveal` (the owner). The database
 * checks every rule again.
 */
export function registerResultsTeamRoutes(scope: FastifyInstance, deps: ResultsDeps): void {
  scope.get("/events/:eventId/rank-prizes", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return valueOf(await listPrizes(deps, organizerContextOf(request), eventId));
  });

  scope.put("/events/:eventId/rank-prizes", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(settingsBody, request.body);
    return valueOf(
      await updatePrizeSettings(
        deps,
        organizerContextOf(request),
        eventId,
        body,
        callerOf(request),
      ),
    );
  });

  scope.post("/events/:eventId/rank-prizes", creating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(prizeBody, request.body);
    const prize = valueOf(
      await createPrize(deps, organizerContextOf(request), eventId, body, callerOf(request)),
    );
    return reply.code(201).send({ prize });
  });

  scope.patch("/events/:eventId/rank-prizes/:prizeId", member, async (request) => {
    const { eventId, prizeId } = parse(prizeParams, request.params);
    const body = parse(prizePatch, request.body);
    const prize = valueOf(
      await updatePrize(
        deps,
        organizerContextOf(request),
        { eventId, id: prizeId },
        body,
        callerOf(request),
      ),
    );
    return { prize };
  });

  scope.delete("/events/:eventId/rank-prizes/:prizeId", member, async (request, reply) => {
    const { eventId, prizeId } = parse(prizeParams, request.params);
    valueOf(
      await removePrize(
        deps,
        organizerContextOf(request),
        { eventId, id: prizeId },
        callerOf(request),
      ),
    );
    return reply.code(204).send();
  });

  scope.get("/events/:eventId/results", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return valueOf(await readResults(deps, organizerContextOf(request), eventId));
  });

  scope.post("/events/:eventId/results/confirm", owner, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { expected } = parse(confirmBody, request.body);
    return valueOf(
      await confirmResults(deps, organizerContextOf(request), {
        eventId,
        expected,
        requestId: request.id,
      }),
    );
  });

  scope.post("/events/:eventId/results/reveal", owner, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { claimUntil } = parse(revealBody, request.body);
    return valueOf(
      await revealResults(deps, organizerContextOf(request), {
        eventId,
        claimUntil: new Date(claimUntil),
        requestId: request.id,
      }),
    );
  });
}

/**
 * The member's side (FR-520, FR-1707, FR-1718): `GET /v1/events/:eventId/results` (empty until the reveal; nothing for
 * a non-member) and `GET /v1/events/:eventId/rules` (404 for a non-member or an event with no rules).
 */
export function registerResultsPlayerRoutes(app: FastifyInstance, deps: ResultsDeps): void {
  app.get("/v1/events/:eventId/results", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return playerResults(deps, playerIdOf(request.player), eventId);
  });

  app.get("/v1/events/:eventId/rules", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const rules = await memberRules(deps, playerIdOf(request.player), eventId);
    if (rules === undefined || rules === null) {
      throw notFound();
    }
    return { rules };
  });
}

// Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
const playerIdOf = (signedIn: { id: string } | undefined): string => {
  if (signedIn === undefined) {
    throw notFound();
  }
  return signedIn.id;
};
