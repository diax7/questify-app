import {
  memberQuestRatingSchema,
  questRatingBodySchema,
  questRatingScoresSchema,
  sharedSurveyResultsSchema,
  surveyResultsOpenBodySchema,
  surveyShareStateSchema,
  withoutContactDetails,
  type MemberQuestRating,
  type QuestRatingScores,
} from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound, unauthenticated } from "#src/auth/http-errors";
import { generateToken, hashToken, type AuthKeys } from "#src/auth/keys";
import { addressBucket } from "#src/auth/normalize";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { holdBack } from "#src/devices/limits";
import type { HomeDeps } from "#src/home/home";
import { organizerContextOf } from "#src/organizers/context";
import { ratingCall, ratingError, type RatingDeps } from "#src/ratings/store";

const eventParams = z.object({ eventId: z.uuid() });
const surveyParams = eventParams.extend({ questId: z.uuid() });
const questParams = z.object({ questId: z.uuid() });
/** At most 120 opens an hour per address: a speaker opens a few, a link scanner many (as the invitation's open). */
const OPEN_LIMIT = { bucket: BUCKETS.surveyResultsOpen, max: 120, windowSeconds: 3600 } as const;

/** The dashboard's side (T-508): each quest's thumbs, and the speaker's link for a survey quest. */
export function registerRatingTeamRoutes(scope: FastifyInstance, deps: RatingDeps): void {
  const run = <Row extends object>(
    request: Parameters<typeof organizerContextOf>[0],
    sql: string,
    values: unknown[],
  ) => ratingCall<Row>(deps, organizerContextOf(request), sql, values);
  const member = { config: { access: "member" } } as const;
  scope.get("/events/:eventId/quest-ratings", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const door = await run<{ answer: QuestRatingScores }>(
      request,
      "SELECT quest_rating_scores($1) AS answer",
      [eventId],
    );
    return questRatingScoresSchema.parse(door.answer);
  });
  scope.get("/events/:eventId/quests/:questId/survey-share", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId, questId } = parse(surveyParams, request.params);
    const door = await run<{ answer: unknown }>(
      request,
      "SELECT survey_share_state($1, $2) AS answer",
      [eventId, questId],
    );
    return surveyShareStateSchema.parse(door.answer);
  });
  // Making a link is not idempotent on purpose: a replayed answer would keep the token in the idempotency store. Each
  // call replaces the last link, so a retry only leaves the newest one working.
  scope.post("/events/:eventId/quests/:questId/survey-share", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId, questId } = parse(surveyParams, request.params);
    const link = generateToken();
    await run(request, "SELECT survey_share_save($1, $2, $3, $4)", [
      eventId,
      questId,
      link.hash,
      request.id,
    ]);
    return reply.code(201).send({ shared: true, token: link.token });
  });
  scope.delete("/events/:eventId/quests/:questId/survey-share", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId, questId } = parse(surveyParams, request.params);
    const door = await run<{ removed: boolean }>(
      request,
      "SELECT survey_share_revoke($1, $2, $3) AS removed",
      [eventId, questId, request.id],
    );
    return { shared: false, removed: door.removed };
  });
}

const player = { config: { access: "player" } } as const;

type RatingRead = Readonly<{ eventId: string; on: boolean; thumb: MemberQuestRating["thumb"] }>;

/** The player's side (T-508, FR-1211, FR-1623): whether to ask, and the rating. */
export function registerMemberRatingRoutes(app: FastifyInstance, deps: HomeDeps): void {
  const read = async (playerId: string, questId: string): Promise<RatingRead> => {
    const door = await ratingCall<{ answer: RatingRead | null }>(
      deps,
      { playerId },
      "SELECT member_quest_rating($1) AS answer",
      [questId],
    );
    if (door.answer === null) throw notFound();
    const config = await deps.settings.forEvent(door.answer.eventId, playerId);
    const platformOn =
      config.kind === "ok" && config.config.features["questRatings"]?.enabled === true;
    return { ...door.answer, on: door.answer.on && platformOn };
  };
  app.get("/v1/quests/:questId/rating", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { questId } = parse(questParams, request.params);
    if (request.player === undefined) throw unauthenticated();
    const { on, thumb } = await read(request.player.id, questId);
    return memberQuestRatingSchema.parse({ on, thumb });
  });
  app.put("/v1/quests/:questId/rating", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { questId } = parse(questParams, request.params);
    if (request.player === undefined) throw unauthenticated();
    const body = questRatingBodySchema.safeParse(request.body);
    if (!body.success) throw ratingError(422, "invalid_rating");
    const { on } = await read(request.player.id, questId);
    if (!on) throw ratingError(409, "ratings_off");
    const door = await ratingCall<{ thumb: string }>(
      deps,
      { playerId: request.player.id },
      "SELECT rate_quest($1, $2) AS thumb",
      [questId, body.data.thumb],
    );
    return memberQuestRatingSchema.parse({ on: true, thumb: door.thumb });
  });
}

/**
 * The speaker's door (T-508, FR-1210, ADR-376 (5)): anonymous, its own address bucket counted before the token is read
 * (so guessed tokens are throttled like real ones), never cached. The token arrives in the body, never in a path, so no
 * log holds it; the answer is one survey quest's results with the text answers that look like a contact detail left out.
 */
export function registerSurveyResultsOpenRoute(
  app: FastifyInstance,
  deps: Readonly<{ pool: RatingDeps["pool"]; keys: Pick<AuthKeys, "addressKey"> }>,
): void {
  app.post(
    "/v1/public/survey-results",
    { config: { access: "public" }, bodyLimit: 512 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      await holdBack(
        deps.pool,
        [{ limit: OPEN_LIMIT, key: deps.keys.addressKey(addressBucket(request.ip)) }],
        true,
        reply,
      );
      const { token } = parse(surveyResultsOpenBodySchema, request.body);
      const door = await ratingCall<{ answer: unknown }>(
        deps,
        {},
        "SELECT survey_shared_results($1) AS answer",
        [hashToken(token)],
      );
      if (door.answer === null) throw notFound();
      return withoutContactDetails(sharedSurveyResultsSchema.parse(door.answer));
    },
  );
}
