import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  alreadyAnswered,
  alreadyCompleted,
  alreadyVoted,
  enrollmentInactive,
  idempotencyKeyReused,
  notFound,
  notQuizQuest,
  notVoteQuest,
  operatorPlayOff,
  questionClosed,
  questionNotServed,
  questNotOpen,
  quizNotStarted,
  unauthenticated,
  unknownOption,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import {
  answerQuestion,
  nextQuestion,
  readQuiz,
  startQuiz,
  type QuizPlay,
} from "#src/plays/quizzes";
import type { Done, PlayDeps, PlayRefusal } from "#src/plays/run";
import { castVote, readVote, voteCounts } from "#src/plays/votes";
import type { Ranking } from "#src/ranking/ranking";

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
const member = { config: { access: "member" } } as const;

const ITEM = /^[A-Za-z0-9_-]{1,40}$/;
const questParams = z.object({ questId: z.uuid() });
const teamParams = z.object({ eventId: z.uuid(), questId: z.uuid() });
const voteBody = z.strictObject({ optionId: z.string().regex(ITEM) });
const answerBody = z.strictObject({
  questionId: z.string().regex(ITEM),
  choiceId: z.string().regex(ITEM),
});
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);

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
    case "unknown_option":
      throw unknownOption();
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

/** A quiz step's answer, with the player's place once it paid; a ranking failure never fails the step. */
async function withRank<T extends QuizPlay>(deps: RankingDeps, playerId: string, play: T) {
  const rank =
    play.quiz.completionId === null
      ? null
      : await deps.ranking.afterCompletion(playerId, play.quiz.completionId);
  return { ...play, rank };
}

/**
 * The player's vote (FR-207) and quiz (FR-208 to FR-210). Every write needs an Idempotency-Key; a payment moves the
 * player's place like a completion.
 */
export function registerPlayRoutes(app: FastifyInstance, deps: PlayDeps & RankingDeps): void {
  app.get("/v1/quests/:questId/vote", player, async (request) => {
    const { questId } = parse(questParams, request.params);
    return valueOf(await readVote(deps, playerIdOf(request), questId));
  });

  app.post("/v1/quests/:questId/vote", playerIdempotent, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    const { optionId } = parse(voteBody, request.body);
    const playerId = playerIdOf(request);
    const key = request.headers["idempotency-key"];
    const voted = valueOf(
      await castVote(deps, { playerId, questId, optionId, idempotencyKey: String(key) }),
      true,
    );
    const rank = await deps.ranking.afterCompletion(playerId, voted.completionId);
    return reply.code(voted.replayed ? 200 : 201).send({ ...voted, rank });
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

/** The dashboard's vote counts, inside the organizer scope (owners and editors). */
export function registerPlayTeamRoutes(scope: FastifyInstance, deps: PlayDeps): void {
  scope.get("/events/:eventId/quests/:questId/votes", member, async (request) => {
    const { eventId, questId } = parse(teamParams, request.params);
    return valueOf(await voteCounts(deps, organizerContextOf(request), { eventId, questId }));
  });
}
