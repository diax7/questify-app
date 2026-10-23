import { joinCard } from "@questify/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  alreadyPlayer,
  joinCardStale,
  joinNotAllowed,
  notFound,
  rehearsalClosed,
  rehearsalFull,
  rehearsalOver,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { isThrottled } from "#src/join/join";
import { cardInForce } from "#src/join/routes";
import { organizerContextOf } from "#src/organizers/context";
import { rehearsalCodeOf, type RehearsalRefusal } from "#src/rehearsal/rehearsal";
import type { Refused, Rehearsal, RehearsalJoin } from "#src/rehearsal/service";

const eventParams = z.object({ eventId: z.uuid() });
const codeParams = z.object({ code: z.string().max(20) });
const joinBody = z.strictObject({
  code: z.string().max(20),
  cardVersion: z.string().regex(/^[0-9]+(\.[0-9]+){0,2}$/),
});

const member = { config: { access: "member" }, bodyLimit: 1024 } as const;
const player = { config: { access: "player" }, bodyLimit: 1024 } as const;

/** A refusal as its HTTP answer: an event out of reach and a rehearsal never opened both look like none. */
function refuse(refusal: RehearsalRefusal): never {
  if (refusal === "over") {
    throw rehearsalOver();
  }
  throw notFound();
}

const isRefused = (value: object): value is Refused => "kind" in value && value.kind === "refused";

/** The value, or the refusal thrown as its HTTP answer. */
function result<T extends object>(value: T | Refused): T {
  if (isRefused(value)) {
    return refuse(value.refusal);
  }
  return value;
}

/**
 * The team's rehearsal (T-211, inside the organizer scope): owners and editors within their events read the card (it
 * opens the rehearsal with a code on first read before go-live), rotate the code, and erase everything rehearsal wrote.
 */
export function registerRehearsalTeamRoutes(scope: FastifyInstance, rehearsal: Rehearsal): void {
  scope.get("/events/:eventId/rehearsal", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return { rehearsal: result(await rehearsal.card(organizerContextOf(request), eventId)) };
  });

  scope.post("/events/:eventId/rehearsal/code", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const rotated = result(
      await rehearsal.rotate(organizerContextOf(request), eventId, callerOf(request)),
    );
    return { code: rotated.code };
  });

  scope.post("/events/:eventId/rehearsal/erase", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const erased = result(
      await rehearsal.erase(organizerContextOf(request), eventId, callerOf(request)),
    );
    return { erased: erased.counts };
  });
}

function throttled(reply: FastifyReply, retryAfterSeconds: number): never {
  reply.header("retry-after", String(retryAfterSeconds));
  throw tooManyAttempts({ retryAfterSeconds });
}

function joinAnswer(answer: RehearsalJoin, reply: FastifyReply) {
  switch (answer.kind) {
    case "joined":
    case "already":
      return {
        eventId: answer.eventId,
        enrollmentId: answer.enrollmentId,
        alreadyMember: answer.kind === "already",
      };
    case "already_player":
      throw alreadyPlayer();
    case "not_allowed":
      throw joinNotAllowed();
    case "full":
      throw rehearsalFull();
    case "closed":
      throw rehearsalClosed();
    case "throttled":
      return throttled(reply, answer.retryAfterSeconds);
  }
}

/**
 * The player's side (FR-1721): a signed-in player reads the event a rehearsal code opens, with the join card, then
 * joins as a rehearsal account. A malformed code names nothing and costs no lookup.
 */
export function registerRehearsalPlayerRoutes(app: FastifyInstance, rehearsal: Rehearsal): void {
  app.get("/v1/rehearsals/:code", player, async (request, reply) => {
    const me = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (me === undefined) {
      throw unauthenticated();
    }
    const code = rehearsalCodeOf(parse(codeParams, request.params).code);
    if (code === undefined) {
      throw rehearsalClosed();
    }
    const event = await rehearsal.eventByCode(me.id, request.ip, code);
    if (isThrottled(event)) {
      return throttled(reply, event.retryAfterSeconds);
    }
    if (event === null) {
      throw rehearsalClosed();
    }
    return { event, card: cardInForce() };
  });

  app.post("/v1/rehearsals/join", player, async (request, reply) => {
    const me = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (me === undefined) {
      throw unauthenticated();
    }
    const body = parse(joinBody, request.body);
    if (body.cardVersion !== joinCard().version) {
      throw joinCardStale({ card: cardInForce() });
    }
    const code = rehearsalCodeOf(body.code);
    if (code === undefined) {
      throw rehearsalClosed();
    }
    return joinAnswer(await rehearsal.join(me.id, request.ip, code, body.cardVersion), reply);
  });
}
