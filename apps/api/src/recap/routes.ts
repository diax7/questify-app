import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound, recapNotEnded, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { readRecap } from "#src/recap/recap";

const eventParams = z.object({ eventId: z.uuid() });

/**
 * The recap card's data (T-410, FR-752): `GET /v1/events/:eventId/recap` for a member who played (as the passport
 * counts it, `left` included). 404 for anyone else, an unknown event or a rehearsal account; 409 `not_ended` before
 * the end. Never cached.
 */
export function registerRecapRoutes(app: FastifyInstance, deps: Readonly<{ pool: Pool }>): void {
  app.get("/v1/events/:eventId/recap", { config: { access: "player" } }, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const player = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (player === undefined) {
      throw unauthenticated();
    }
    const answer = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: player.id }, () => readRecap(client, eventId)),
    );
    if (answer.kind === "not_found") {
      throw notFound();
    }
    if (answer.kind === "not_ended") {
      throw recapNotEnded();
    }
    return answer.recap;
  });
}
