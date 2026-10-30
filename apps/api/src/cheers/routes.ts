import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { tooManyAttempts, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { cheersCall, sendCheer, type CheersDeps, type CheersReading } from "#src/cheers/store";
import { organizerContextOf } from "#src/organizers/context";

const eventParams = z.object({ eventId: z.uuid() });
/** The database checks the range, so a moment of 0 or 99 minutes gets `invalid_cheer`, not a bare 422. */
const startBody = z.strictObject({ minutes: z.number().int() });
/** The database checks the name, so an unknown reaction gets `invalid_cheer` too. */
const cheerBody = z.strictObject({ reaction: z.string().max(20) });

const member = { config: { access: "member" } } as const;
const ownerWriting = { config: { access: "owner", idempotent: true }, bodyLimit: 1024 } as const;

/**
 * The Cheers section of the Big screen page (T-509, FR-1841): any member reads it; only the owner starts a moment
 * (1 to 30 minutes) and stops it. The event's on/off switch is the owner's `PUT …/cheers`, beside the other switches.
 */
export function registerCheersTeamRoutes(scope: FastifyInstance, deps: CheersDeps): void {
  const run = (request: Parameters<typeof organizerContextOf>[0], sql: string, values: unknown[]) =>
    cheersCall<{ answer: CheersReading }>(deps, organizerContextOf(request), sql, values);
  scope.get("/events/:eventId/cheers", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    return (await run(request, "SELECT event_cheers($1) AS answer", [eventId])).answer;
  });
  scope.post("/events/:eventId/cheers/start", ownerWriting, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { minutes } = parse(startBody, request.body);
    return (
      await run(request, "SELECT start_cheers_moment($1, $2, $3) AS answer", [
        eventId,
        minutes,
        request.id,
      ])
    ).answer;
  });
  scope.post("/events/:eventId/cheers/stop", ownerWriting, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return (
      await run(request, "SELECT stop_cheers_moment($1, $2) AS answer", [eventId, request.id])
    ).answer;
  });
}

const player = { config: { access: "player" }, bodyLimit: 256 } as const;

/**
 * The player's cheer (T-509, FR-1841): one of the five reactions while a moment is live. A tap is not idempotent on
 * purpose: it pays nothing, a repeated tap is another cheer, and the per-minute limit bounds a retry storm. Over the
 * limit the answer is 429 with `Retry-After`.
 */
export function registerMemberCheerRoutes(app: FastifyInstance, deps: CheersDeps): void {
  app.post("/v1/events/:eventId/cheers", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    if (request.player === undefined) {
      throw unauthenticated();
    }
    const { reaction } = parse(cheerBody, request.body);
    const wait = await sendCheer(deps, { playerId: request.player.id, eventId, reaction });
    if (wait !== undefined) {
      reply.header("retry-after", String(wait));
      throw tooManyAttempts({ retryAfterSeconds: wait });
    }
    return reply.code(201).send({ sent: true });
  });
}
