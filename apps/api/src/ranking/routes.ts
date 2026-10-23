import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  notEnrolled,
  notFound,
  rankingOff,
  todayRankingOff,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { Ranking } from "#src/ranking/ranking";
import type { SettingsService } from "#src/settings/service";

const eventParams = z.object({ eventId: z.uuid() });
const rankingQuery = z.strictObject({ scope: z.enum(["event", "today"]).default("event") });

/**
 * `GET /v1/events/:eventId/ranking` (FR-606, FR-607, FR-609; ADR-052): the top 10 and the caller's own place, for a
 * player with an active enrollment in the event, while the event's ranking is on. `?scope=today` gives today's ranking
 * (FR-610, ADR-166) while the event is multi-day and live and the owner left it on (FR-608); `today` says whether it is.
 */
export function registerRankingRoutes(
  app: FastifyInstance,
  deps: Readonly<{ ranking: Ranking; settings: SettingsService }>,
): void {
  app.get("/v1/events/:eventId/ranking", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { scope } = parse(rankingQuery, request.query ?? {});
    const player = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (player === undefined) {
      throw unauthenticated();
    }
    const config = await deps.settings.forEvent(eventId, player.id);
    if (config.kind !== "ok") {
      throw notFound();
    }
    const features = config.config.features;
    if (features["ranking"]?.enabled === false) {
      throw rankingOff();
    }
    const todayOn = features["rankingToday"]?.enabled !== false;
    if (scope === "today" && !todayOn) {
      throw todayRankingOff();
    }
    const view = await deps.ranking.read(eventId, player.id, scope);
    if (view === "not_enrolled") {
      throw notEnrolled();
    }
    if (view === "today_off") {
      throw todayRankingOff();
    }
    return { ...view, today: view.today && todayOn };
  });
}
