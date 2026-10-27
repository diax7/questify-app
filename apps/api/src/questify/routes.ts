import { gemPurchaseBodySchema } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { idempotencyKeyInvalid, unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { registerDailyRoutes } from "#src/daily/routes";
import { registerMarketingRoutes } from "#src/marketing/routes";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack } from "#src/devices/limits";
import { buyGemItem, readGemShop } from "#src/questify/gems";
import {
  readAchievements,
  readCities,
  readEvents,
  readQuestifyQuests,
  syncQuestify,
} from "#src/questify/questify";

const eventsQuery = z.strictObject({
  played: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
/** At most 20 syncs a minute per player (the app syncs on focus, on foreground and after completions). */
const SYNC_LIMIT = { bucket: BUCKETS.questifySync, max: 20, windowSeconds: 60 } as const;
/** At most 10 gem shop purchases a minute per player (a replayed key is answered before this and never counts). */
const PURCHASE_LIMIT = { bucket: BUCKETS.gemPurchase, max: 10, windowSeconds: 60 } as const;
const uuidKey = z.uuid();

/** The purchase's Idempotency-Key, which the database keeps with the purchase: a UUID (the app makes one per confirmation). */
function purchaseKeyOf(request: FastifyRequest): string {
  const key = uuidKey.safeParse(request.headers["idempotency-key"]);
  if (!key.success) throw idempotencyKeyInvalid();
  return key.data;
}

const own = (request: FastifyRequest) => {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/**
 * Questify-wide player doors (T-403, T-403b, T-404, T-406): the sync evaluator, achievements, Questify quests, the Event
 * Passport and history, the gem shop and its purchase door, the daily games, the marketing and preferences doors (T-407), and the public city list. Player routes take a player bearer token only, so a staff session never enters them.
 */
export function registerQuestifyRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; keys: Pick<AuthKeys, "playerKey" | "addressKey" | "optOutTag"> },
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
  app.get("/v1/me/questify-quests", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return as(own(request), readQuestifyQuests);
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
  app.get("/v1/me/gem-shop", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return as(own(request), readGemShop);
  });
  app.post(
    "/v1/me/gem-shop/purchases",
    { ...player, config: { ...player.config, idempotent: true } },
    async (request, reply) => {
      const id = own(request);
      reply.header("cache-control", "private, no-store");
      const requestKey = purchaseKeyOf(request);
      const body = parse(gemPurchaseBodySchema, request.body);
      await holdBack(
        deps.pool,
        [{ limit: PURCHASE_LIMIT, key: deps.keys.playerKey(id) }],
        true,
        reply,
      );
      return as(id, (client) => buyGemItem(client, { ...body, requestKey }));
    },
  );
  registerDailyRoutes(app, deps);
  registerMarketingRoutes(app, deps);
  app.get("/v1/cities", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return {
      cities: await withConnection(deps.pool, (client) =>
        withRequestContext(client, {}, () => readCities(client)),
      ),
    };
  });
}
