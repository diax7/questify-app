import {
  MARKETING_TEXT_VERSION,
  marketingBodySchema,
  optOutBodySchema,
  preferencesBodySchema,
} from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { consentTextOutdated, invalidOptOut, unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { addressBucket } from "#src/auth/normalize";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack } from "#src/devices/limits";
import {
  optOutChannel,
  readForYou,
  readInterests,
  readMarketing,
  readPreferences,
  setMarketing,
  setPreferences,
} from "#src/marketing/marketing";
import { readOptOutToken } from "#src/marketing/opt-out";

/** At most 60 consent and preference writes an hour per player (a screen needs a handful). */
const WRITE_LIMIT = { bucket: BUCKETS.marketingWrite, max: 60, windowSeconds: 3600 } as const;
/** At most 30 opt-out attempts an hour per address: a mail client's link scanner opens many, a person few. */
const OPT_OUT_LIMIT = { bucket: BUCKETS.marketingOptOut, max: 30, windowSeconds: 3600 } as const;

const own = (request: FastifyRequest) => {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

type Deps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "playerKey" | "addressKey" | "optOutTag">;
}>;

/**
 * Marketing consent, preferences and "For you" (T-407, FR-733 to FR-737, FR-1114): the caller's own consent per
 * channel, city and interests, the recommended events, the public interest list, and the opt-out link's door. No route
 * takes a player id; the link's token names the player and is signed. Every answer about a player is `no-store`.
 */
export function registerMarketingRoutes(app: FastifyInstance, deps: Deps): void {
  const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
  const as = <T>(id: string, work: (client: PoolClient) => Promise<T>) =>
    withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: id }, () => work(client)),
    );
  const writeBudget = (id: string, reply: FastifyReply) =>
    holdBack(deps.pool, [{ limit: WRITE_LIMIT, key: deps.keys.playerKey(id) }], true, reply);

  app.get("/v1/me/marketing", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return as(own(request), readMarketing);
  });

  app.put("/v1/me/marketing", player, async (request, reply) => {
    const id = own(request);
    reply.header("cache-control", "private, no-store");
    const body = parse(marketingBodySchema, request.body);
    // Only a yes needs the wording in force: turning channels off, from any app version, always saves.
    const grants = Object.values(body.channels).includes(true);
    if (grants && body.textVersion !== MARKETING_TEXT_VERSION) {
      throw consentTextOutdated({ textVersion: MARKETING_TEXT_VERSION });
    }
    await writeBudget(id, reply);
    return as(id, (client) => setMarketing(client, body));
  });

  app.get("/v1/me/preferences", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return as(own(request), readPreferences);
  });

  app.put("/v1/me/preferences", player, async (request, reply) => {
    const id = own(request);
    reply.header("cache-control", "private, no-store");
    const body = parse(preferencesBodySchema, request.body);
    await writeBudget(id, reply);
    return as(id, (client) => setPreferences(client, body));
  });

  app.get("/v1/me/for-you", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    return { events: await as(own(request), readForYou) };
  });

  app.get("/v1/interests", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    return {
      interests: await withConnection(deps.pool, (client) =>
        withRequestContext(client, {}, () => readInterests(client)),
      ),
    };
  });

  app.post(
    "/v1/public/marketing/opt-out",
    { config: { access: "public" }, bodyLimit: 512 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { token } = parse(optOutBodySchema, request.body);
      // Counted before the signature is read, so forged tokens are throttled like real ones.
      await holdBack(
        deps.pool,
        [{ limit: OPT_OUT_LIMIT, key: deps.keys.addressKey(addressBucket(request.ip)) }],
        true,
        reply,
      );
      const target = readOptOutToken(deps.keys, token);
      if (target === null) throw invalidOptOut();
      await withConnection(deps.pool, (client) =>
        withRequestContext(client, {}, () =>
          optOutChannel(client, target.playerId, target.channel),
        ),
      );
      return reply.code(204).send();
    },
  );
}
