import { blocksAnswerSchema, type BlocksAnswer } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { blockLimit, notFound, unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack, type DeviceLimit } from "#src/devices/limits";

/** 60 blocks and unblocks an hour per player. */
export const BLOCK_CHANGE_LIMIT = {
  bucket: BUCKETS.playerBlock,
  max: 60,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const blockBody = z.strictObject({ username: z.string().min(1).max(120) });
const usernameParams = z.object({ username: z.string().min(1).max(120) });

export type BlockDeps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "playerKey"> }>;

const own = (request: FastifyRequest): string => {
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

const asPlayer = <T>(deps: BlockDeps, id: string, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId: id }, () => work(client)),
  );

/** One block or unblock: the door's outcome, as the player may be told it. */
async function changeBlock(
  deps: BlockDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  change: Readonly<{ sql: string; username: string }>,
): Promise<string> {
  const id = own(request);
  await holdBack(
    deps.pool,
    [{ limit: BLOCK_CHANGE_LIMIT, key: deps.keys.playerKey(id) }],
    true,
    reply,
  );
  const outcome = await asPlayer(deps, id, async (client) => {
    const { rows } = await client.query<{ r: string }>(change.sql, [change.username]);
    return rows[0]?.r ?? "not_found";
  });
  if (outcome === "not_found") {
    throw notFound();
  }
  if (outcome === "limit") {
    throw blockLimit();
  }
  return outcome;
}

/**
 * A player's own block list (FR-1415, T-705, ADR-431). A blocked player is hidden from the blocker's boards and
 * profile reads in the database; nothing tells the blocked player. An unknown name, an erased account and the caller
 * all answer 404. The username in the DELETE path is replaced in the access log (app.ts, `loggerOptions`).
 */
export function registerBlockRoutes(app: FastifyInstance, deps: BlockDeps): void {
  const read = { config: { access: "player" } } as const;
  const change = { config: { access: "player", idempotent: true }, bodyLimit: 1024 } as const;

  app.get("/v1/me/blocks", read, async (request, reply): Promise<BlocksAnswer> => {
    reply.header("cache-control", "private, no-store");
    const blocks = await asPlayer(deps, own(request), async (client) => {
      const { rows } = await client.query<{ r: unknown }>("SELECT own_blocks() AS r");
      return rows[0]?.r;
    });
    return blocksAnswerSchema.parse({ blocks });
  });

  app.post("/v1/me/blocks", change, async (request, reply) => {
    const { username } = parse(blockBody, request.body);
    await changeBlock(deps, request, reply, { sql: "SELECT block_player($1) AS r", username });
    return reply.code(204).send();
  });

  app.delete("/v1/me/blocks/:username", change, async (request, reply) => {
    const { username } = parse(usernameParams, request.params);
    await changeBlock(deps, request, reply, { sql: "SELECT unblock_player($1) AS r", username });
    return reply.code(204).send();
  });
}
