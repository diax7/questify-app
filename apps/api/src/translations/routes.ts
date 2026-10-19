import type { FastifyInstance } from "fastify";
import { etagMatches } from "#src/etag";
import type { TranslationService } from "#src/translations/service";

/**
 * `GET /v1/translations`: the texts a Questify admin changed, `{ ar: {key: text}, en: {key: text} }`. Anyone may
 * read it. The app lays these over the texts shipped inside it, so a key that is missing here, or a blank one, shows
 * the shipped text. The answer carries an ETag (an unchanged bundle costs one tiny request, 304).
 */
export function registerTranslationRoutes(app: FastifyInstance, service: TranslationService): void {
  app.get("/v1/translations", async (request, reply) => {
    const { overrides, etag } = await service.bundle();
    reply.header("etag", etag).header("cache-control", "no-cache");
    if (etagMatches(request.headers["if-none-match"], etag)) {
      return reply.code(304).send();
    }
    return overrides;
  });
}
