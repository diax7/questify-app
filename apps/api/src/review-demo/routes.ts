import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  featureOff,
  notFound,
  reviewNoneLeft,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  listReviewCodes,
  reviewMeetCode,
  type ReviewCodeDeps,
  type ReviewOutcome,
} from "#src/review-demo/codes";

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const eventParams = z.object({ eventId: z.uuid() });
const meetBody = z.strictObject({ questId: z.uuid() });

function playerIdOf(request: { player?: { id: string } | undefined }): string {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
}

/** One answer per refusal; every refusal of the caller rule is the 404 an unknown event gets. */
function valueOf<T>(reply: FastifyReply, result: ReviewOutcome<T>): T {
  switch (result.kind) {
    case "done":
      return result.value;
    case "none_left":
      throw reviewNoneLeft();
    case "feature_off":
      throw featureOff();
    case "too_many_attempts":
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    default:
      throw notFound();
  }
}

/**
 * The App Review demo's QR picker (T-710b, ADR-565, ADR-640): the reviewer's list of the demo event's printable codes,
 * and a fictional player's meet code on demand. Both answer 404 to anyone but the reviewer, in the demo event, while
 * the window is open; the codes then go through the scanner's ordinary routes.
 */
export function registerReviewDemoPlayerRoutes(app: FastifyInstance, deps: ReviewCodeDeps): void {
  app.get("/v1/events/:eventId/review-codes", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    reply.header("cache-control", "no-store");
    return { codes: valueOf(reply, await listReviewCodes(deps, playerIdOf(request), eventId)) };
  });

  app.post("/v1/events/:eventId/review-codes/meet", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { questId } = parse(meetBody, request.body);
    const pass = valueOf(
      reply,
      await reviewMeetCode(deps, { playerId: playerIdOf(request), eventId, questId }),
    );
    return reply.code(201).header("cache-control", "no-store").send(pass);
  });
}
