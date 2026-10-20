import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notEnrolled, notFound, rankingOff, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { Ranking } from "#src/ranking/ranking";
import type { SettingsService } from "#src/settings/service";

const eventParams = z.object({ eventId: z.uuid() });

/**
 * `GET /v1/events/:eventId/ranking` (FR-606, FR-607, FR-609; ADR-052): the top 10 and the caller's own place, for a
 * player with an active enrollment in the event, while the event's ranking is on.
 */
export function registerRankingRoutes(
  app: FastifyInstance,
  deps: Readonly<{ ranking: Ranking; settings: SettingsService }>,
): void {
  app.get("/v1/events/:eventId/ranking", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const player = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (player === undefined) {
      throw unauthenticated();
    }
    const config = await deps.settings.forEvent(eventId);
    if (config.kind !== "ok") {
      throw notFound();
    }
    if (config.config.features["ranking"]?.enabled === false) {
      throw rankingOff();
    }
    const view = await deps.ranking.read(eventId, player.id);
    if (view === "not_enrolled") {
      throw notEnrolled();
    }
    return view;
  });
}
