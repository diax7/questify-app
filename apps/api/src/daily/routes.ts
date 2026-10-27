import { dailyAnswerBodySchema, dailyGuessBodySchema } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { submitAnswer, submitGuess, readDaily } from "#src/daily/daily";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack } from "#src/devices/limits";

/** At most 30 answers and 30 guesses a minute per player (a game needs 3 and at most 6, plus retries). */
const ANSWER_LIMIT = { bucket: BUCKETS.dailyAnswer, max: 30, windowSeconds: 60 } as const;
const GUESS_LIMIT = { bucket: BUCKETS.dailyGuess, max: 30, windowSeconds: 60 } as const;

const own = (request: FastifyRequest) => {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/**
 * The daily challenge and the daily word (T-406, FR-730, FR-1810): the caller's games and the two move doors. Player
 * routes take a player bearer token only, so a staff session never enters them; no route takes a player id. Logs name
 * the move's shape only, never the guess, the word or the player.
 */
export function registerDailyRoutes(
  app: FastifyInstance,
  deps: Readonly<{ pool: Pool; keys: Pick<AuthKeys, "playerKey"> }>,
) {
  const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
  const as = <T>(id: string, work: (client: PoolClient) => Promise<T>) =>
    withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: id }, () => work(client)),
    );

  app.get("/v1/me/daily", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return as(own(request), readDaily);
  });

  app.post("/v1/me/daily/challenge/answers", player, async (request, reply) => {
    const id = own(request);
    reply.header("cache-control", "private, no-store");
    const body = parse(dailyAnswerBodySchema, request.body);
    await holdBack(deps.pool, [{ limit: ANSWER_LIMIT, key: deps.keys.playerKey(id) }], true, reply);
    const answer = await as(id, (client) => submitAnswer(client, body));
    request.log.info({
      event: "daily.answer",
      position: answer.answer.position,
      correct: answer.answer.correct,
      finished: answer.finished !== null,
      replayed: answer.replayed,
    });
    return answer;
  });

  app.post("/v1/me/daily/word/guesses", player, async (request, reply) => {
    const id = own(request);
    reply.header("cache-control", "private, no-store");
    const body = parse(dailyGuessBodySchema, request.body);
    await holdBack(deps.pool, [{ limit: GUESS_LIMIT, key: deps.keys.playerKey(id) }], true, reply);
    const guess = await as(id, (client) => submitGuess(client, body));
    request.log.info({
      event: "daily.guess",
      attempt: guess.guess.attempt,
      solved: guess.finished?.solved === true,
      finished: guess.finished !== null,
      replayed: guess.replayed,
    });
    return guess;
  });
}
