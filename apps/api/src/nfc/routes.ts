import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  abilityOff,
  invalidProof,
  invalidTag,
  limitReached,
  notOperator,
  outsideOperatorQuests,
  platformFeatureOff,
  questNotNfc,
  tagAlreadyRegistered,
  tagEventClosed,
  tooManyAttempts,
  unauthenticated,
  unknownTag,
} from "#src/auth/http-errors";
import { callerOf, deviceOf, parse } from "#src/auth/request";
import { locationQuestsOn } from "#src/completions/complete";
import { positionOf } from "#src/completions/routes";
import { moveTag, questTags, revokeQuestTags, revokeTag, type TeamNfcDeps } from "#src/nfc/team";
import {
  confirmTag,
  operatorTags,
  prepareTag,
  tapTag,
  type NfcDeps,
  type NfcDone,
  type NfcRefusal,
} from "#src/nfc/tags";
import { organizerContextOf } from "#src/organizers/context";
import { refuse } from "#src/plays/routes";
import type { Ranking } from "#src/ranking/ranking";

const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
const member = { config: { access: "member" } } as const;
const writing = { config: { access: "member", idempotent: true }, bodyLimit: 1024 } as const;

/** Most stickers' ids are 4, 7 or 10 bytes; as lower-case hex. */
const uid = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{2}){4,10}$/)
  .transform((value) => value.toLowerCase());
const token = z.string().min(1).max(200);
const eventParams = z.object({ eventId: z.uuid() });
const questParams = z.object({ eventId: z.uuid(), questId: z.uuid() });
const tagParams = z.object({ eventId: z.uuid(), tagId: z.uuid() });
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);
/**
 * A tap: the token read from the tag, the sticker's id, and the phone's platform. `uidReason: "platform"` (the id could
 * not be read) is taken only from the iPhone build and only without an id (CTO A); the phone decides it, so the panel
 * counts such taps apart and they are never flagged.
 */
const tapBody = z
  .strictObject({
    code: token,
    uid: uid.nullable(),
    uidReason: z.literal("platform").optional(),
    platform: z.enum(["ios", "android"]),
    position: z.unknown().optional(),
  })
  .refine((body) => body.uidReason === undefined || (body.platform === "ios" && body.uid === null));
const confirmBody = z.strictObject({
  code: token,
  ticket: z.string().min(1).max(200),
  uid,
  label: z.string().max(200).default(""),
  locked: z.boolean(),
});
const moveBody = z.strictObject({ questId: z.uuid() });

const playerIdOf = (request: FastifyRequest): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

/** One HTTP answer per refusal (API.md, NFC tags); the completion door's own as a scan's. */
function refuseNfc(reply: FastifyReply, result: NfcRefusal): never {
  switch (result.kind) {
    case "unknown_tag":
      throw unknownTag();
    case "invalid_proof":
      throw invalidProof();
    case "not_operator":
      throw notOperator();
    case "ability_off":
      throw abilityOff();
    case "outside_quests":
      throw outsideOperatorQuests();
    case "event_closed":
      throw tagEventClosed();
    case "not_nfc":
      throw questNotNfc();
    case "limit_reached":
      throw limitReached();
    case "already_registered":
      throw tagAlreadyRegistered();
    case "invalid_tag":
      throw invalidTag({ field: result.field });
    case "platform_off":
      throw platformFeatureOff();
    case "too_many_attempts":
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    default:
      return refuse(result);
  }
}

const valueOf = <T>(reply: FastifyReply, result: NfcDone<T>): T =>
  result.kind === "done" ? result.value : refuseNfc(reply, result);

export type NfcRouteDeps = NfcDeps & Readonly<{ ranking: Ranking }>;

/**
 * NFC tags for players and operators (T-308, FR-312, FR-313, FR-621): a player's tap (Idempotency-Key required; the
 * place moves like a scan), and the operator's prepare, confirm and write page in staff mode. The platform switch
 * `nfcTags` off answers 403 feature_off; the quest's QR still works.
 */
export function registerNfcRoutes(app: FastifyInstance, deps: NfcRouteDeps): void {
  app.post("/v1/taps", playerIdempotent, async (request, reply) => {
    const body = parse(tapBody, request.body);
    const playerId = playerIdOf(request);
    const reading = positionOf(body.position);
    const position =
      reading === null || reading === "bad" || !(await locationQuestsOn(deps.settings))
        ? null
        : reading;
    const answer = valueOf(
      reply,
      await tapTag(
        deps,
        {
          playerId,
          code: body.code,
          uid: body.uid,
          uidUnreadable: body.uidReason === "platform",
          position,
          idempotencyKey: String(request.headers["idempotency-key"]),
          deviceId: deviceOf(request.headers["x-device-id"]),
        },
        callerOf(request),
      ),
    );
    const rank = await deps.ranking.afterCompletion(playerId, answer.completionId);
    return { ...answer, rank };
  });

  app.post(
    "/v1/operator/events/:eventId/quests/:questId/nfc-tags/prepare",
    player,
    async (request, reply) => {
      const { eventId, questId } = parse(questParams, request.params);
      parse(emptyBody, request.body);
      return valueOf(
        reply,
        await prepareTag(deps, { operatorId: playerIdOf(request), eventId, questId }),
      );
    },
  );

  app.post(
    "/v1/operator/events/:eventId/quests/:questId/nfc-tags",
    playerIdempotent,
    async (request, reply) => {
      const { eventId, questId } = parse(questParams, request.params);
      const body = parse(confirmBody, request.body);
      const registered = valueOf(
        reply,
        await confirmTag(deps, {
          operatorId: playerIdOf(request),
          eventId,
          questId,
          ...body,
          requestId: request.id,
        }),
      );
      return reply.code(201).send(registered);
    },
  );

  app.get("/v1/operator/events/:eventId/nfc-tags", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    return valueOf(reply, await operatorTags(deps, playerIdOf(request), eventId));
  });
}

/**
 * A quest's Tags panel in the organizer scope (T-308): the list for members, and Move, Revoke and Revoke all with an
 * Idempotency-Key. All four stay open while the platform switch is off (accepted, CTO code review 4): the team can
 * still take tags out of use or move them; a moved tag pays only once the switch is on again.
 */
export function registerNfcTeamRoutes(scope: FastifyInstance, deps: TeamNfcDeps): void {
  scope.get("/events/:eventId/quests/:questId/nfc-tags", member, async (request, reply) => {
    const target = parse(questParams, request.params);
    return { tags: valueOf(reply, await questTags(deps, organizerContextOf(request), target)) };
  });

  scope.post("/events/:eventId/nfc-tags/:tagId/move", writing, async (request, reply) => {
    const { eventId, tagId } = parse(tagParams, request.params);
    const { questId } = parse(moveBody, request.body);
    valueOf(
      reply,
      await moveTag(deps, organizerContextOf(request), {
        eventId,
        tagId,
        questId,
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });

  scope.post("/events/:eventId/nfc-tags/:tagId/revoke", writing, async (request, reply) => {
    const { eventId, tagId } = parse(tagParams, request.params);
    parse(emptyBody, request.body);
    valueOf(
      reply,
      await revokeTag(deps, organizerContextOf(request), { eventId, tagId, requestId: request.id }),
    );
    return reply.code(204).send();
  });

  scope.post(
    "/events/:eventId/quests/:questId/nfc-tags/revoke-all",
    writing,
    async (request, reply) => {
      const { eventId, questId } = parse(questParams, request.params);
      parse(emptyBody, request.body);
      const revoked = valueOf(
        reply,
        await revokeQuestTags(deps, organizerContextOf(request), {
          eventId,
          questId,
          requestId: request.id,
        }),
      );
      return { revoked };
    },
  );
}
