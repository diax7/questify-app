import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { parse } from "#src/auth/request";
import { notFound, unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack } from "#src/devices/limits";
import { itemRefusal, readLocker } from "#src/players/items";

const querySchema = z.strictObject({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const seenSchema = z.strictObject({
  itemIds: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});
const usernameSchema = z.object({ username: z.string().min(1).max(120) });
const own = (request: FastifyRequest) => {
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/** Own locker and separate public DTO. Staff sessions cannot enter these player-only doors. */
export function registerItemRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; keys: Pick<AuthKeys, "playerKey"> },
) {
  const options = { config: { access: "player" }, bodyLimit: 8192 } as const;
  const as = <T>(id: string, work: (client: import("pg").PoolClient) => Promise<T>) =>
    withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: id }, () => work(client)),
    );
  app.get("/v1/me/locker", options, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const query = parse(querySchema, request.query);
    return as(own(request), (client) => readLocker(client, query.cursor, query.limit));
  });
  app.post("/v1/me/locker/seen", options, async (request, reply) => {
    const body = parse(seenSchema, request.body);
    try {
      await as(own(request), (client) =>
        client.query("SELECT see_owned_items($1)", [body.itemIds]),
      );
    } catch (error) {
      itemRefusal(error);
    }
    return reply.code(204).send();
  });
  app.get("/v1/players/:username", options, async (request, reply) => {
    const id = own(request);
    const { username } = parse(usernameSchema, request.params);
    await holdBack(
      deps.pool,
      [
        {
          limit: { bucket: BUCKETS.profileRead, max: 60, windowSeconds: 60 },
          key: deps.keys.playerKey(id),
        },
      ],
      true,
      reply,
    );
    const body = await as(id, async (client) => {
      const { rows } = await client.query<{ profile: unknown }>(
        "SELECT public_player_profile($1) AS profile",
        [username],
      );
      return rows[0]?.profile;
    });
    reply.header("cache-control", "private, no-store");
    if (body === null || body === undefined) throw notFound();
    return body;
  });
}
