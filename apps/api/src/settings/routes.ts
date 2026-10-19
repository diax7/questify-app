import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidRequest, notFound } from "#src/auth/http-errors";
import { etagMatches } from "#src/etag";
import type { SettingsService } from "#src/settings/service";

const query = z.strictObject({ event: z.uuid().optional() });

/**
 * `GET /v1/config[?event=<id>]`: the composed configuration (shipped defaults, then platform settings, then the
 * event). Anyone may read it; an event the caller cannot see answers 404 exactly like one that does not exist.
 * The answer carries an ETag, so an unchanged configuration costs one tiny request (304).
 */
export function registerConfigRoutes(app: FastifyInstance, settings: SettingsService): void {
  app.get("/v1/config", async (request, reply) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) {
      throw invalidRequest();
    }
    const result = await settings.forEvent(parsed.data.event);
    if (result.kind === "event_not_found") {
      throw notFound();
    }
    reply.header("etag", result.etag).header("cache-control", "no-cache");
    if (etagMatches(request.headers["if-none-match"], result.etag)) {
      return reply.code(304).send();
    }
    return result.config;
  });
}
