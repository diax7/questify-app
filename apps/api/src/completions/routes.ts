import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  alreadyCompleted,
  enrollmentInactive,
  idempotencyKeyReused,
  locationRefused,
  notFound,
  platformFeatureOff,
  questCodeInvalid,
  questNotOpen,
  screenCodeExpired,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { callerOf, deviceOf, parse } from "#src/auth/request";
import {
  completeQuest,
  type CompletionDeps,
  type CompletionResult,
  type Position,
} from "#src/completions/complete";
import type { Ranking } from "#src/ranking/ranking";
import { refusalThrower } from "#src/refusal-table";
import { logStreakBonus } from "#src/streaks/streaks";

/** A reading as the database takes it (migration 0048's position_of holds the same rules). */
const positionShape = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().gt(0).max(10_000),
  ageS: z.number().min(0).max(86_400),
  mocked: z.boolean().optional(),
});
// A position's shape is judged after the body: a bad one on a scan is dropped, never a 400 (CTO 3).
const reading = z.unknown().optional();
const completeBody = z.strictObject({
  proof: z.discriminatedUnion("type", [
    // The token the app read from the QR's /q/{token} address.
    z.strictObject({ type: z.literal("qr"), code: z.string().min(1).max(200), position: reading }),
    z.strictObject({ type: z.literal("code"), code: z.string().min(1).max(64), position: reading }),
    z.strictObject({ type: z.literal("location"), position: reading }),
    // The token the app read from a station's /s/{token} address (T-309).
    z.strictObject({
      type: z.literal("screen"),
      code: z.string().min(1).max(200),
      position: reading,
    }),
  ]),
});

/** A well-formed reading, or null: never the numbers in an error (the parse's issues are dropped unread). */
export function positionOf(value: unknown): Position | null | "bad" {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = positionShape.safeParse(value);
  return parsed.success ? parsed.data : "bad";
}
const questParams = z.object({ questId: z.uuid() });

/** One HTTP answer per completion refusal; a rate limit also sets `retry-after`. Exported for its test. */
export const refuseCompletion = refusalThrower<
  Exclude<CompletionResult, { kind: "completed" }>,
  [reply: FastifyReply]
>({
  not_found: () => notFound(),
  enrollment_inactive: (result) => enrollmentInactive({ reason: result.reason }),
  quest_not_open: (result) => questNotOpen({ reason: result.reason }),
  already_completed: (result) => alreadyCompleted({ cap: result.cap }),
  // A screen code past its window asks for a fresh scan (T-309); any other problem gets one answer, since the
  // player can do nothing different, and the log keeps the difference.
  invalid_code: (result) =>
    result.problem === "expired" ? screenCodeExpired() : questCodeInvalid(),
  key_reused: () => idempotencyKeyReused(),
  too_many_attempts: (result, reply) => {
    reply.header("retry-after", String(result.retryAfterSeconds));
    return tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
  },
  location_refused: (result) =>
    locationRefused({
      reason: result.reason,
      ...(result.distanceM === null ? {} : { distanceM: result.distanceM }),
    }),
  feature_off: () => platformFeatureOff(),
});

/**
 * `POST /v1/quests/:questId/complete` (FR-201, 211, 215, 216, 302, 304, 314): a player with a live session completes a
 * quest with its QR's token, a station's rotating code, its typed code or a location check-in. A scan may carry the phone's position (a bad one is
 * dropped); a check-in must (a bad one is 422 location_refused bad_position). Every call needs an Idempotency-Key; a
 * retry with the same key gets the first answer.
 */
export function registerCompletionRoutes(
  app: FastifyInstance,
  deps: CompletionDeps & Readonly<{ ranking: Ranking }>,
): void {
  app.post(
    "/v1/quests/:questId/complete",
    { config: { access: "player", idempotent: true }, bodyLimit: 1024 },
    async (request, reply) => {
      const { questId } = parse(questParams, request.params);
      const { proof } = parse(completeBody, request.body);
      const position = positionOf(proof.position);
      if (position === "bad" && proof.type === "location") {
        throw locationRefused({ reason: "bad_position" });
      }
      const player = request.player;
      const key = request.headers["idempotency-key"];
      // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: the player guard and the idempotency convention answer first
      if (player === undefined || typeof key !== "string") {
        throw unauthenticated();
      }
      const result = await completeQuest(
        deps,
        {
          playerId: player.id,
          questId,
          proof:
            proof.type === "location"
              ? { type: "location" }
              : { type: proof.type, code: proof.code },
          position: position === "bad" ? null : position,
          idempotencyKey: key,
          deviceId: deviceOf(request.headers["x-device-id"]),
        },
        callerOf(request),
      );
      if (result.kind !== "completed") {
        return refuseCompletion(result, reply);
      }
      // The player's place after this completion: null when not ranked or when Redis could not answer (T-106).
      logStreakBonus(request.log, result.value);
      const rank = await deps.ranking.afterAnswer(result.entries);
      return { ...result.value, rank };
    },
  );
}
