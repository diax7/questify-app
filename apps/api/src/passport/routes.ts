import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import { callerOf, deviceOf, parse } from "#src/auth/request";
import { readPassport, stampStep, type PassportDeps } from "#src/passport/stamp";
import { refuse } from "#src/plays/routes";
import type { Ranking } from "#src/ranking/ranking";
import { logStreakBonus } from "#src/streaks/streaks";

const stampBody = z.strictObject({ code: z.string().min(1).max(200) });
const stepParams = z.object({ stepId: z.uuid() });
const questParams = z.object({ questId: z.uuid() });

/**
 * Passport quests (T-304b, FR-224): `POST /v1/steps/:stepId/stamp` stamps a step with its printed code's token (an
 * Idempotency-Key on every call; the stamp that finishes the passport pays it and moves the player's place), and
 * `GET /v1/quests/:questId/passport` lists its steps with the ones this player stamped.
 */
export function registerPassportRoutes(
  app: FastifyInstance,
  deps: PassportDeps & Readonly<{ ranking: Ranking }>,
): void {
  app.post(
    "/v1/steps/:stepId/stamp",
    { config: { access: "player", idempotent: true }, bodyLimit: 1024 },
    async (request) => {
      const { stepId } = parse(stepParams, request.params);
      const { code } = parse(stampBody, request.body);
      const key = request.headers["idempotency-key"];
      // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: the player guard and the idempotency convention answer first
      if (request.player === undefined || typeof key !== "string") {
        throw unauthenticated();
      }
      const result = await stampStep(
        deps,
        {
          playerId: request.player.id,
          stepId,
          code,
          idempotencyKey: key,
          deviceId: deviceOf(request.headers["x-device-id"]),
        },
        callerOf(request),
      );
      if (result.kind !== "done") {
        return refuse(result);
      }
      const { completed } = result.value;
      logStreakBonus(request.log, completed);
      // The player's place after the paying stamp: null when not ranked or when Redis could not answer (T-106).
      const rank =
        completed === null
          ? null
          : await deps.ranking.afterCompletion(request.player.id, completed.completionId);
      return { ...result.value, rank };
    },
  );

  app.get("/v1/quests/:questId/passport", { config: { access: "player" } }, async (request) => {
    const { questId } = parse(questParams, request.params);
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (request.player === undefined) {
      throw unauthenticated();
    }
    const result = await readPassport(deps, request.player.id, questId);
    return result.kind === "done" ? result.value : refuse(result);
  });
}
