import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack } from "#src/devices/limits";
import { readAchievements, readCities, readEvents, syncQuestify } from "#src/questify/questify";

const eventsQuery = z.strictObject({
  played: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
/** At most 20 syncs a minute per player (the app syncs on focus, on foreground and after completions). */
const SYNC_LIMIT = { bucket: BUCKETS.questifySync, max: 20, windowSeconds: 60 } as const;

const own = (request: FastifyRequest) => {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/**
 * Questify-wide player doors (T-403): the sync evaluator, achievements, the Event Passport and history, and the
 * public city list. Player routes take a player bearer token only, so a staff session never enters them.
 */
export function registerQuestifyRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; keys: Pick<AuthKeys, "playerKey"> },
) {
  const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
  const as = <T>(id: string, work: (client: PoolClient) => Promise<T>) =>
    withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: id }, () => work(client)),
    );
  app.post("/v1/me/questify/sync", player, async (request, reply) => {
    const id = own(request);
    await holdBack(deps.pool, [{ limit: SYNC_LIMIT, key: deps.keys.playerKey(id) }], true, reply);
    reply.header("cache-control", "private, no-store");
    return as(id, syncQuestify);
  });
  app.get("/v1/me/achievements", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return { achievements: await as(own(request), readAchievements) };
  });
  app.get("/v1/me/event-history", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const query = parse(eventsQuery, request.query);
    return as(own(request), (client) =>
      readEvents(client, {
        played: query.played === "true",
        cursor: query.cursor,
        limit: query.limit,
      }),
    );
  });
  app.get("/v1/cities", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return {
      cities: await withConnection(deps.pool, (client) =>
        withRequestContext(client, {}, () => readCities(client)),
      ),
    };
  });
}
