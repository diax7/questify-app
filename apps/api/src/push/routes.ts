import {
  notificationsQuerySchema,
  notificationsReadBodySchema,
  pushDeviceBodySchema,
  pushTopicsBodySchema,
} from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack } from "#src/devices/limits";
import { consentLanguage } from "#src/marketing/marketing";
import { sessionHashOf } from "#src/players/guard";
import {
  markRead,
  readCenter,
  readTopics,
  registerDevice,
  removeDevice,
  setTopics,
} from "#src/push/center";

/** At most 20 device registrations an hour per player (the app registers at launch, on a token change or daily). */
export const DEVICE_LIMIT = { bucket: BUCKETS.pushDevice, max: 20, windowSeconds: 3600 } as const;

type Deps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "playerKey"> }>;

const noStore = (reply: FastifyReply) => reply.header("cache-control", "private, no-store");

const own = (request: FastifyRequest): string => {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/** The hash of the request's own access token; the guard let it through, so it is always there. */
const sessionOf = (request: FastifyRequest): Buffer => {
  const hash = sessionHashOf(request.headers.authorization);
  // Stryker disable next-line all: the player guard has already refused a request without a bearer token
  if (hash === undefined) throw unauthenticated();
  return hash;
};

/**
 * Push, the notification center and the topic mutes (T-501, FR-1104, FR-1105, FR-1115): this sign-in's device, the
 * caller's own center rows rendered in the request's language, and the four topics. No route takes a player id; every
 * answer is `private, no-store`; a device token never reaches a log or an error (the bodies are not logged and the
 * errors name a field only).
 */
export function registerPushRoutes(app: FastifyInstance, deps: Deps): void {
  const player = { config: { access: "player" } } as const;
  const as = <T>(id: string, work: (client: PoolClient) => Promise<T>) =>
    withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: id }, () => work(client)),
    );

  app.put("/v1/me/push-device", { ...player, bodyLimit: 4096 }, async (request, reply) => {
    const id = own(request);
    noStore(reply);
    const body = parse(pushDeviceBodySchema, request.body);
    await holdBack(deps.pool, [{ limit: DEVICE_LIMIT, key: deps.keys.playerKey(id) }], true, reply);
    await as(id, (client) => registerDevice(client, sessionOf(request), body));
    return reply.code(204).send();
  });

  app.delete("/v1/me/push-device", player, async (request, reply) => {
    noStore(reply);
    await as(own(request), (client) => removeDevice(client, sessionOf(request)));
    return reply.code(204).send();
  });

  app.get("/v1/me/notifications", player, async (request, reply) => {
    noStore(reply);
    const query = parse(notificationsQuerySchema, request.query);
    const language = consentLanguage(request.headers["accept-language"]) ?? "ar";
    return as(own(request), (client) => readCenter(client, query, language));
  });

  app.post("/v1/me/notifications/read", { ...player, bodyLimit: 4096 }, async (request, reply) => {
    noStore(reply);
    const body = parse(notificationsReadBodySchema, request.body);
    const ids = "ids" in body ? body.ids : null;
    return { unread: await as(own(request), (client) => markRead(client, ids)) };
  });

  app.get("/v1/me/push-topics", player, async (request, reply) => {
    noStore(reply);
    return as(own(request), readTopics);
  });

  app.put("/v1/me/push-topics", { ...player, bodyLimit: 1024 }, async (request, reply) => {
    noStore(reply);
    const body = parse(pushTopicsBodySchema, request.body);
    return as(own(request), (client) => setTopics(client, body));
  });
}
