import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  alreadyAnswered,
  alreadyCompleted,
  alreadyVoted,
  badAnswer,
  categoryNotHidden,
  enrollmentInactive,
  featureOff,
  flashAlreadyLaunched,
  flashCommunityLocked,
  flashEventNotLive,
  flashNotStarted,
  flashScheduled,
  flashTooLate,
  gameRefused409,
  gameRefused422,
  idempotencyKeyReused,
  meetRefused403,
  meetRefused409,
  meetRefused422,
  notFound,
  notGameQuest,
  notFlashQuest,
  notMeetQuest,
  notPassportQuest,
  notQuizQuest,
  notShareQuest,
  notSurveyQuest,
  notLivePoll,
  notVoteQuest,
  operatorPlayOff,
  pollAlreadySent,
  pollCommunityLocked,
  pollEventNotLive,
  platformFeatureOff,
  pollNotSent,
  questCodeInvalid,
  questionClosed,
  questionNotServed,
  questNotOpen,
  quizNotStarted,
  tooManyAttempts,
  tooManyChoices,
  unauthenticated,
  unknownOption,
  updateRequired,
} from "#src/auth/http-errors";
import { callerOf, deviceOf, parse } from "#src/auth/request";
import { etagMatches } from "#src/etag";
import { locationQuestsOn } from "#src/completions/complete";
import { positionOf } from "#src/completions/routes";
import { organizerContextOf } from "#src/organizers/context";
import {
  readGame,
  sendResult,
  startRound,
  type GameDeps,
  type GameOutcome,
} from "#src/plays/games";
import {
  answerQuestion,
  nextQuestion,
  readQuiz,
  startQuiz,
  type QuizStep,
} from "#src/plays/quizzes";
import {
  issueMeetPass,
  meetPassState,
  meetPlayer,
  type MeetDeps,
  type MeetOutcome,
  type MeetReason,
} from "#src/plays/meet";
import { createLiveReader, liveEtagOf } from "#src/plays/live";
import type { FirstBonusCache } from "#src/quests/first-bonus";
import type { Done, PlayDeps, PlayRefusal } from "#src/plays/run";
import { readShare, shareQuest } from "#src/plays/shares";
import { answerSurvey, readSurvey, surveySummary } from "#src/plays/surveys";
import { castVote, readPoll, readVote, voteCounts } from "#src/plays/votes";
import { FLASH_MINUTES, endFlash, launchFlash, type FlashDone } from "#src/quests/flash";
import { closePoll, sendPoll, type PollDone } from "#src/quests/polls";
import type { Ranking } from "#src/ranking/ranking";
import type { SettingsService } from "#src/settings/service";

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
/** Twenty answers of up to 500 characters each, as JSON with escapes, fit in 64 KiB. */
const surveyIdempotent = { ...playerIdempotent, bodyLimit: 65_536 } as const;
const member = { config: { access: "member" } } as const;
const memberIdempotent = { config: { access: "member", idempotent: true } } as const;

const ITEM = /^[A-Za-z0-9_-]{1,40}$/;
const questParams = z.object({ questId: z.uuid() });
const teamParams = z.object({ eventId: z.uuid(), questId: z.uuid() });
const eventParams = z.object({ eventId: z.uuid() });
/** One option, or several on a live poll that takes several (the database checks which, FR-240). */
const voteBody = z.strictObject({ optionIds: z.array(z.string().regex(ITEM)).min(1).max(10) });
const answerBody = z.strictObject({
  questionId: z.string().regex(ITEM),
  choiceId: z.string().regex(ITEM),
});
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);
/** A survey's answers by question id: a choice id, a rating, text, or null for unanswered (the database checks each). */
const surveyBody = z.strictObject({
  answers: z
    .record(z.string().regex(ITEM), z.union([z.string().max(2000), z.number(), z.null()]))
    .refine((answers) => Object.keys(answers).length <= 20),
});

const playerIdOf = (request: FastifyRequest): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

/** One HTTP answer per refusal (API.md, votes and quizzes). A vote's spent cap is "already voted". */
export function refuse(result: PlayRefusal, voting = false): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "enrollment_inactive":
      throw enrollmentInactive({ reason: result.reason });
    case "quest_not_open":
      throw questNotOpen({ reason: result.reason });
    case "operator_not_playing":
      throw operatorPlayOff();
    case "not_vote_quest":
      throw notVoteQuest();
    case "not_quiz_quest":
      throw notQuizQuest();
    case "not_survey_quest":
      throw notSurveyQuest();
    case "not_share_quest":
      throw notShareQuest();
    case "not_passport_quest":
      throw notPassportQuest();
    case "not_meet_quest":
      throw notMeetQuest();
    case "not_game_quest":
      throw notGameQuest();
    case "game_refused":
      throw gameRefused409({
        reason: result.reason,
        ...(result.retryAt === null ? {} : { retryAt: result.retryAt }),
      });
    case "not_hidden":
      throw categoryNotHidden();
    case "invalid_code":
      // One answer whatever the problem, as a quest code's (completions/routes.ts); the log keeps the difference.
      throw questCodeInvalid();
    case "bad_answer":
      throw badAnswer({ question: result.question });
    case "feature_off":
      throw featureOff();
    case "unknown_option":
      throw unknownOption();
    case "too_many_choices":
      throw tooManyChoices();
    case "already_completed":
      throw voting ? alreadyVoted() : alreadyCompleted();
    case "key_reused":
      throw idempotencyKeyReused();
    case "quiz_not_started":
      throw quizNotStarted();
    case "already_answered":
      throw alreadyAnswered();
    case "question_closed":
      throw questionClosed();
    case "question_not_served":
      throw questionNotServed();
  }
}

const valueOf = <T>(result: Done<T>, voting = false): T =>
  result.kind === "done" ? result.value : refuse(result, voting);

type RankingDeps = Readonly<{ ranking: Ranking }>;

/**
 * A quiz step's answer, with the player's place when this step paid (a replay or a later step moves nothing); a
 * ranking failure never fails the step.
 */
async function withRank<T extends QuizStep>(deps: RankingDeps, playerId: string, step: T) {
  const { paid, ...play } = step;
  const rank =
    paid && play.quiz.completionId !== null
      ? await deps.ranking.afterCompletion(playerId, play.quiz.completionId)
      : null;
  return { ...play, rank };
}

/**
 * The player's vote (FR-207) and quiz (FR-208 to FR-210). Every write needs an Idempotency-Key; a payment moves the
 * player's place like a completion.
 */
export function registerPlayRoutes(
  app: FastifyInstance,
  deps: PlayDeps &
    RankingDeps &
    Readonly<{ settings: SettingsService; firstBonus: FirstBonusCache }>,
): void {
  app.get("/v1/quests/:questId/vote", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readVote(deps, playerIdOf(request), questId));
  });

  app.post("/v1/quests/:questId/vote", playerIdempotent, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    const { optionIds } = parse(voteBody, request.body);
    const playerId = playerIdOf(request);
    const key = request.headers["idempotency-key"];
    const voted = valueOf(
      await castVote(deps, { playerId, questId, optionIds, idempotencyKey: String(key) }),
      true,
    );
    const rank = await deps.ranking.afterCompletion(playerId, voted.completionId);
    return reply.code(voted.replayed ? 200 : 201).send({ ...voted, rank });
  });

  app.get("/v1/quests/:questId/poll", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readPoll(deps, playerIdOf(request), questId));
  });

  const live = createLiveReader(deps);
  // What is live in the event for the player (ADR-221): polled every few seconds, so a weak ETag over the body without
  // `serverNow` answers 304 while nothing changed; the server's clock rides in a header on both answers.
  app.get("/v1/events/:eventId/live", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const playerId = playerIdOf(request);
    const wait = live.allow(playerId);
    if (wait !== undefined) {
      reply.header("retry-after", String(wait));
      throw tooManyAttempts({ retryAfterSeconds: wait });
    }
    const state = await live.read(playerId, eventId);
    const etag = liveEtagOf(state);
    const serverNow = new Date().toISOString();
    reply.header("etag", etag).header("server-now", serverNow).header("cache-control", "no-cache");
    if (etagMatches(request.headers["if-none-match"], etag.slice(2))) {
      return reply.code(304).send();
    }
    return { ...state, serverNow };
  });

  app.get("/v1/quests/:questId/survey", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readSurvey(deps, playerIdOf(request), questId));
  });

  app.post("/v1/quests/:questId/survey", surveyIdempotent, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    const { answers } = parse(surveyBody, request.body);
    const playerId = playerIdOf(request);
    const key = String(request.headers["idempotency-key"]);
    const paid = valueOf(
      await answerSurvey(deps, { playerId, questId, answers, idempotencyKey: key }),
    );
    const rank = await deps.ranking.afterCompletion(playerId, paid.completionId);
    return reply.code(paid.replayed ? 200 : 201).send({ ...paid, rank });
  });

  app.get("/v1/quests/:questId/share", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readShare(deps, playerIdOf(request), questId));
  });

  app.post("/v1/quests/:questId/share", playerIdempotent, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    parse(emptyBody, request.body);
    const playerId = playerIdOf(request);
    const key = String(request.headers["idempotency-key"]);
    const paid = valueOf(await shareQuest(deps, { playerId, questId, idempotencyKey: key }));
    const rank = await deps.ranking.afterCompletion(playerId, paid.completionId);
    return reply.code(paid.replayed ? 200 : 201).send({ ...paid, rank });
  });

  app.get("/v1/quests/:questId/quiz", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readQuiz(deps, playerIdOf(request), questId));
  });

  app.post("/v1/quests/:questId/quiz/start", playerIdempotent, async (request) => {
    const { questId } = parse(questParams, request.params);
    parse(emptyBody, request.body);
    const playerId = playerIdOf(request);
    return withRank(deps, playerId, valueOf(await startQuiz(deps, { playerId, questId })));
  });

  app.post("/v1/quests/:questId/quiz/next", playerIdempotent, async (request) => {
    const { questId } = parse(questParams, request.params);
    parse(emptyBody, request.body);
    const playerId = playerIdOf(request);
    return withRank(deps, playerId, valueOf(await nextQuestion(deps, { playerId, questId })));
  });

  app.post("/v1/quests/:questId/quiz/answer", playerIdempotent, async (request) => {
    const { questId } = parse(questParams, request.params);
    const { questionId, choiceId } = parse(answerBody, request.body);
    const playerId = playerIdOf(request);
    const answered = valueOf(
      await answerQuestion(deps, { playerId, questId, questionId, choiceId }),
    );
    return withRank(deps, playerId, answered);
  });
}

const meetBody = z.strictObject({
  code: z.string().min(1).max(200),
  position: z.unknown().optional(),
});
const passParams = z.object({ passId: z.string().regex(/^[1-9][0-9]{0,17}$/) });

/** Which answer each meet refusal gets: the code itself (422), a limit or the pair (409), who may meet (403). */
const MEET_STATUS: Readonly<Record<MeetReason, typeof meetRefused422>> = {
  bad_code: meetRefused422,
  expired: meetRefused422,
  used: meetRefused422,
  self: meetRefused422,
  same_device: meetRefused422,
  already_met: meetRefused409,
  daily_cap: meetRefused409,
  their_daily_cap: meetRefused409,
  done: meetRefused409,
  their_done: meetRefused409,
  not_in_event: meetRefused403,
  not_for_them: meetRefused403,
};

/** A meet call's answer, or its refusal thrown (API.md, meet-someone). */
function meetValueOf<T>(reply: FastifyReply, result: MeetOutcome<T>): T {
  switch (result.kind) {
    case "done":
      return result.value;
    case "meet_refused":
      throw MEET_STATUS[result.reason]({
        reason: result.reason,
        ...(result.name === null ? {} : { name: result.name }),
        ...(result.cap === null ? {} : { cap: result.cap }),
      });
    case "too_many_attempts":
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    default:
      return refuse(result);
  }
}

/**
 * Meet-someone (T-303c, FR-212, FR-213): the shown player asks for a one-minute code and polls its state; the scanner
 * posts it (Idempotency-Key required) and both are paid. Both players' places move after a paying meeting. The code
 * travels only in the body; a malformed position is dropped, and passed on only while location quests are on.
 */
export function registerMeetRoutes(
  app: FastifyInstance,
  deps: MeetDeps & RankingDeps & Readonly<{ settings: SettingsService }>,
): void {
  app.post("/v1/quests/:questId/meet-pass", player, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    parse(emptyBody, request.body);
    const pass = meetValueOf(
      reply,
      await issueMeetPass(deps, {
        playerId: playerIdOf(request),
        questId,
        deviceId: deviceOf(request.headers["x-device-id"]),
      }),
    );
    return reply.code(201).send(pass);
  });

  app.get("/v1/meet-passes/:passId", player, async (request, reply) => {
    const { passId } = parse(passParams, request.params);
    return meetValueOf(reply, await meetPassState(deps, { playerId: playerIdOf(request), passId }));
  });

  app.post("/v1/meet", playerIdempotent, async (request, reply) => {
    const body = parse(meetBody, request.body);
    const playerId = playerIdOf(request);
    const reading = positionOf(body.position);
    const position =
      reading === null || reading === "bad" || !(await locationQuestsOn(deps.settings))
        ? null
        : reading;
    const { answer, other } = meetValueOf(
      reply,
      await meetPlayer(
        deps,
        {
          playerId,
          code: body.code,
          idempotencyKey: String(request.headers["idempotency-key"]),
          deviceId: deviceOf(request.headers["x-device-id"]),
          position,
        },
        callerOf(request),
      ),
    );
    const rank = await deps.ranking.afterCompletion(playerId, answer.completionId);
    if (!answer.replayed) {
      await deps.ranking.afterCompletion(other.playerId, other.completionId);
    }
    return { ...answer, rank };
  });
}

/** Send's and Close's answer, or their refusal thrown (API.md, live polls). */
function pollValueOf(result: PollDone) {
  switch (result.kind) {
    case "done":
      return result.value;
    case "not_found":
      throw notFound();
    case "not_live_poll":
      throw notLivePoll();
    case "already_sent":
      throw pollAlreadySent();
    case "not_sent":
      throw pollNotSent();
    case "event_not_live":
      throw pollEventNotLive();
    case "community_locked":
      throw pollCommunityLocked();
  }
}

/** Launch's and End now's answer, or their refusal thrown (API.md, flash quests). */
function flashValueOf(result: FlashDone) {
  switch (result.kind) {
    case "done":
      return result.value;
    case "not_found":
      throw notFound();
    case "not_flash":
      throw notFlashQuest();
    case "event_not_live":
      throw flashEventNotLive();
    case "feature_off":
      throw platformFeatureOff();
    case "already_launched":
      throw flashAlreadyLaunched();
    case "scheduled":
      throw flashScheduled();
    case "community_locked":
      throw flashCommunityLocked();
    case "too_late":
      throw flashTooLate();
    case "not_started":
      throw flashNotStarted();
  }
}

const launchBody = z.strictObject({
  minutes: z.number().int().min(FLASH_MINUTES.min).max(FLASH_MINUTES.max),
});

/**
 * The dashboard's vote counts and survey results, Send and Close of a live poll (T-306), and Launch and End now of a
 * flash quest (T-307), inside the organizer scope (owners and editors; the writes need an Idempotency-Key).
 */
export function registerPlayTeamRoutes(scope: FastifyInstance, deps: PlayDeps): void {
  scope.post("/events/:eventId/quests/:questId/send", memberIdempotent, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    parse(emptyBody, request.body);
    const target = { eventId, questId, requestId: request.id };
    return pollValueOf(await sendPoll(deps, organizerContextOf(request), target));
  });

  scope.post("/events/:eventId/quests/:questId/close", memberIdempotent, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    parse(emptyBody, request.body);
    const target = { eventId, questId, requestId: request.id };
    return pollValueOf(await closePoll(deps, organizerContextOf(request), target));
  });

  scope.post("/events/:eventId/quests/:questId/launch", memberIdempotent, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    const { minutes } = parse(launchBody, request.body);
    const target = { eventId, questId, minutes, requestId: request.id };
    return flashValueOf(await launchFlash(deps, organizerContextOf(request), target));
  });

  scope.post("/events/:eventId/quests/:questId/end", memberIdempotent, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    parse(emptyBody, request.body);
    const target = { eventId, questId, requestId: request.id };
    return flashValueOf(await endFlash(deps, organizerContextOf(request), target));
  });

  scope.get("/events/:eventId/quests/:questId/votes", member, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    return valueOf(await voteCounts(deps, organizerContextOf(request), { eventId, questId }));
  });

  scope.get("/events/:eventId/quests/:questId/survey", member, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    return valueOf(await surveySummary(deps, organizerContextOf(request), { eventId, questId }));
  });
}

const roundParams = z.object({ roundId: z.string().regex(/^[1-9][0-9]{0,17}$/) });
/** The engine version the app carries for each game it knows. */
const roundBody = z.strictObject({
  engineVersions: z
    .record(z.string().regex(/^[a-z_]{1,40}$/), z.number().int().min(0).max(1000))
    .refine((versions) => Object.keys(versions).length <= 20),
});
/**
 * A round's result: shaped by the engine on the server, never here, so a malformed one is a refused round written by
 * finish_game_round (the attempt counted), not a bare 400 that leaves the round open for a second try.
 */
const resultBody = z.strictObject({
  inputs: z.unknown().optional(),
  claimed: z.unknown().optional(),
});
/** A round's inputs fit far inside 64 KiB: memory match's 400 flips or the slide puzzle's 1,000 taps, as JSON. */
const resultIdempotent = { ...playerIdempotent, bodyLimit: 65_536 } as const;

/** A game call's answer, or its refusal thrown (API.md, mini-games). */
function gameValueOf<T>(reply: FastifyReply, result: GameOutcome<T>): T {
  switch (result.kind) {
    case "done":
      return result.value;
    case "update_required":
      throw updateRequired();
    case "impossible":
      throw gameRefused422({ reason: "impossible", attemptsLeft: result.attemptsLeft });
    case "too_many_attempts":
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    default:
      return refuse(result);
  }
}

/**
 * Mini-games (T-305, FR-1804 to FR-1809): the quest sheet's state, a round issued on Play (Idempotency-Key required; an
 * attempt used), and its result replayed on the server and paid once on the first pass, which moves the player's place.
 */
export function registerGameRoutes(app: FastifyInstance, deps: GameDeps & RankingDeps): void {
  app.get("/v1/quests/:questId/game", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readGame(deps, playerIdOf(request), questId));
  });

  app.post("/v1/quests/:questId/game-rounds", playerIdempotent, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    const { engineVersions } = parse(roundBody, request.body);
    const round = gameValueOf(
      reply,
      await startRound(deps, {
        playerId: playerIdOf(request),
        questId,
        idempotencyKey: String(request.headers["idempotency-key"]),
        deviceId: deviceOf(request.headers["x-device-id"]),
        engineVersions,
      }),
    );
    return reply.code(round.replayed ? 200 : 201).send(round);
  });

  app.post("/v1/game-rounds/:roundId/result", resultIdempotent, async (request, reply) => {
    const { roundId } = parse(roundParams, request.params);
    const { inputs, claimed } = parse(resultBody, request.body);
    const playerId = playerIdOf(request);
    const answer = gameValueOf(
      reply,
      await sendResult(
        deps,
        {
          playerId,
          roundId,
          idempotencyKey: String(request.headers["idempotency-key"]),
          inputs,
          claimed,
        },
        callerOf(request),
      ),
    );
    const rank =
      answer.completionId !== null && !answer.replayed
        ? await deps.ranking.afterCompletion(playerId, answer.completionId)
        : null;
    return { ...answer, rank };
  });
}
