import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { invalidRequest, notFound, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { etagMatches } from "#src/etag";
import type { ConfigResult, SettingsService } from "#src/settings/service";

const query = z.strictObject({ event: z.uuid().optional() });
const eventParams = z.object({ eventId: z.uuid() });

/**
 * `GET /v1/config[?event=<id>]`: the composed configuration (shipped defaults, then platform settings, then the
 * event). Anyone may read it; an event the caller cannot see answers 404 exactly like one that does not exist.
 * The answer carries an ETag, so an unchanged configuration costs one tiny request (304).
 */
function answer(request: FastifyRequest, reply: FastifyReply, result: ConfigResult) {
  if (result.kind === "event_not_found") {
    throw notFound();
  }
  reply.header("etag", result.etag).header("cache-control", "no-cache");
  if (etagMatches(request.headers["if-none-match"], result.etag)) {
    return reply.code(304).send();
  }
  return result.config;
}

export function registerConfigRoutes(app: FastifyInstance, settings: SettingsService): void {
  app.get("/v1/config", { config: { access: "public" } }, async (request, reply) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      throw invalidRequest();
    }
    return answer(request, reply, await settings.forEvent(parsed.data.event));
  });

  // The same document for an event the player joined, which may be unlisted or private (its words, T-117).
  app.get(
    "/v1/events/:eventId/config",
    { config: { access: "player" } },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (request.player === undefined) {
        throw unauthenticated();
      }
      return answer(request, reply, await settings.forEvent(eventId, request.player.id));
    },
  );
}
