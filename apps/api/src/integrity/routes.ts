import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { invalidRequest, unauthenticated } from "#src/auth/http-errors";
import { deviceOf, parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { holdBack } from "#src/devices/limits";
import type { Holder } from "#src/integrity/challenge";
import { challengeFor, checkDevice, type IntegrityDeps } from "#src/integrity/service";
import type { AuthKeys } from "#src/auth/keys";

/** Challenges and checks, each at most 10 an hour per player (the app checks at launch, at most daily). */
export const CHALLENGE_LIMIT = {
  bucket: BUCKETS.integrityChallenge,
  max: 10,
  windowSeconds: 3600,
} as const;
export const CHECK_LIMIT = {
  bucket: BUCKETS.integrityCheck,
  max: 10,
  windowSeconds: 3600,
} as const;

const platform = z.enum(["ios", "android"]);
const challenge = z.string().min(1).max(100);
const base64 = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/_-]+={0,2}$/);
const challengeBody = z.strictObject({ platform });
const checkBody = z.union([
  z.strictObject({
    platform: z.literal("android"),
    challenge,
    token: z.string().min(1).max(16_384),
  }),
  z.strictObject({
    platform: z.literal("ios"),
    challenge,
    keyId: base64(64),
    attestation: base64(22_000),
  }),
  z.strictObject({
    platform: z.literal("ios"),
    challenge,
    keyId: base64(64),
    assertion: base64(4096),
  }),
]);

type Deps = IntegrityDeps & Readonly<{ authKeys: Pick<AuthKeys, "playerKey"> }>;

const noStore = (reply: FastifyReply) => reply.header("cache-control", "private, no-store");

/** The caller and its install (X-Device-Id); a request without an install id is refused, as nothing can be checked. */
function holderOf(request: FastifyRequest): Holder {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  const installId = deviceOf(request.headers["x-device-id"]);
  if (installId === undefined) throw invalidRequest({ field: "x-device-id" });
  return { playerId: request.player.id, installId };
}

/**
 * The device-integrity doors (T-812, FR-334): a challenge, then the proof. Neither refuses play: a verdict only raises a
 * flag for the event's team. The answer never says whether the phone passed. Logs carry the platform, the outcome and
 * reason codes only (no install id, token, key or player).
 */
export function registerIntegrityRoutes(app: FastifyInstance, deps: Deps): void {
  const player = { config: { access: "player" } } as const;

  app.post(
    "/v1/me/device-integrity/challenge",
    { ...player, bodyLimit: 256 },
    async (request, reply) => {
      noStore(reply);
      const body = parse(challengeBody, request.body);
      const holder = holderOf(request);
      await holdBack(
        deps.pool,
        [{ limit: CHALLENGE_LIMIT, key: deps.authKeys.playerKey(holder.playerId) }],
        true,
        reply,
      );
      return challengeFor(deps, holder, body.platform);
    },
  );

  app.post("/v1/me/device-integrity", { ...player, bodyLimit: 32_768 }, async (request, reply) => {
    noStore(reply);
    const body = parse(checkBody, request.body);
    const holder = holderOf(request);
    await holdBack(
      deps.pool,
      [{ limit: CHECK_LIMIT, key: deps.authKeys.playerKey(holder.playerId) }],
      true,
      reply,
    );
    const result = await checkDevice(deps, holder, body);
    request.log.info({ integrity: result.log }, "device integrity check");
    return { next: result.next };
  });
}
