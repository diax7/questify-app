import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { revealCodeInvalid, unauthenticated } from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { refuse } from "#src/plays/routes";
import { revealCategory, type RevealDeps } from "#src/reveal/reveal";

const revealBody = z.strictObject({ code: z.string().min(1).max(200) });
const categoryParams = z.object({ categoryId: z.uuid() });

/**
 * Hidden categories (T-304c, FR-237): `POST /v1/categories/:categoryId/reveal` finds a hidden category with its secret
 * code's token. It pays nothing and a second find writes nothing, so it takes no Idempotency-Key (ADR-204).
 */
export function registerRevealRoutes(app: FastifyInstance, deps: RevealDeps): void {
  app.post(
    "/v1/categories/:categoryId/reveal",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request) => {
      const { categoryId } = parse(categoryParams, request.params);
      const { code } = parse(revealBody, request.body);
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (request.player === undefined) {
        throw unauthenticated();
      }
      const result = await revealCategory(
        deps,
        { playerId: request.player.id, categoryId, code },
        callerOf(request),
      );
      if (result.kind === "invalid_code") {
        throw revealCodeInvalid();
      }
      return result.kind === "done" ? result.value : refuse(result);
    },
  );
}
