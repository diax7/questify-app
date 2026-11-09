import { scoresHidden } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  notEnrolled,
  notFound,
  rankingOff,
  todayRankingOff,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { playerRanking } from "#src/ranking/display";
import type { Ranking } from "#src/ranking/ranking";
import type { ConfigResult, SettingsService } from "#src/settings/service";

const eventParams = z.object({ eventId: z.uuid() });
const rankingQuery = z.strictObject({ scope: z.enum(["event", "today"]).default("event") });

/**
 * `GET /v1/events/:eventId/ranking` (FR-606, FR-607, FR-609; ADR-052): the top 10 and the caller's own place, for a
 * player with an active enrollment in the event, while the event's ranking is on. `?scope=today` gives today's ranking
 * (FR-610, ADR-166) while the event is multi-day and live and the owner left it on (FR-608); `today` says whether it is.
 * With the event's ranking on "rank only" (FR-1832, ADR-396) the answer carries places and players and no score, for the
 * whole event and for today alike, and says so in `scores: false`.
 */
export function registerRankingRoutes(
  app: FastifyInstance,
  deps: Readonly<{ ranking: Ranking; settings: SettingsService }>,
): void {
  app.get("/v1/events/:eventId/ranking", { config: { access: "player" } }, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { scope } = parse(rankingQuery, request.query ?? {});
    const player = playerOf(request);
    const config = onlyOk(await deps.settings.forEvent(eventId, player.id));
    const todayOn = checkSwitches(config, scope);
    const view = readable(await deps.ranking.read(eventId, player.id, scope));
    return playerRanking(
      { ...view, today: view.today && todayOn },
      scoresHidden(config.config.layout.looks),
    );
  });
}

const playerOf = (request: FastifyRequest): { id: string } => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player;
};

type OkConfig = Extract<ConfigResult, { kind: "ok" }>;

/** The event's configuration, or the answer of an event that is not there. */
const onlyOk = (config: ConfigResult): OkConfig => {
  if (config.kind !== "ok") {
    throw notFound();
  }
  return config;
};

/** Refuses a ranking the event switched off (or today's, for that scope); tells whether today's ranking is on. */
function checkSwitches(config: OkConfig, scope: "event" | "today"): boolean {
  const features = config.config.features;
  if (features["ranking"]?.enabled === false) {
    throw rankingOff();
  }
  const todayOn = features["rankingToday"]?.enabled !== false;
  if (scope === "today" && !todayOn) {
    throw todayRankingOff();
  }
  return todayOn;
}

/** The ranking the reader may see, or the answer to what keeps it from them. */
function readable<T extends object>(view: T | "not_enrolled" | "today_off"): T {
  if (view === "not_enrolled") {
    throw notEnrolled();
  }
  if (view === "today_off") {
    throw todayRankingOff();
  }
  return view;
}
