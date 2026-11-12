import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { photoTooLarge, unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { PHOTO_BYTES_MAX } from "#src/storage/images";
import { PhotoRefused, uploadPhoto, type PhotoDeps, type PhotoUpload } from "#src/storage/upload";

/** The image types an upload may declare; the bytes are checked again, by their magic numbers. */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

const upload = {
  config: { access: "player", idempotent: true },
  bodyLimit: PHOTO_BYTES_MAX,
} as const;
const questParams = z.object({ questId: z.uuid() });
const eventParams = z.object({ eventId: z.uuid() });

const playerIdOf = (request: FastifyRequest): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

const keyOf = (request: FastifyRequest): string => String(request.headers["idempotency-key"]);

async function answer(reply: FastifyReply, work: Promise<{ photoId: string }>) {
  try {
    return reply.code(201).send(await work);
  } catch (error) {
    if (!(error instanceof PhotoRefused)) throw error;
    if (error.retryAfterSeconds !== undefined)
      reply.header("retry-after", String(error.retryAfterSeconds));
    throw error.error;
  }
}

const bodyOf = (request: FastifyRequest): Buffer =>
  Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

/**
 * The photo doors (T-301b): a player sends one image as the raw body (`Content-Type: image/jpeg|png|webp`, at most
 * 8 MB, an Idempotency-Key) and gets `201 {photoId}`, then sends that id with the submission or the ticket. Inside
 * their own plugin, so only these routes take an image body; every other route still takes JSON only.
 */
export function registerPhotoRoutes(app: FastifyInstance, deps: PhotoDeps): void {
  app.register(async (scope) => {
    scope.addContentTypeParser(
      [...PHOTO_TYPES],
      { parseAs: "buffer", bodyLimit: PHOTO_BYTES_MAX },
      (_request: FastifyRequest, body: Buffer, done: (error: null, body: Buffer) => void) =>
        done(null, body),
    );
    scope.setErrorHandler((error: FastifyError) => {
      throw error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? photoTooLarge() : error;
    });

    scope.post("/v1/quests/:questId/photo", upload, (request, reply) => {
      const { questId } = parse(questParams, request.params);
      const photo: PhotoUpload = {
        playerId: playerIdOf(request),
        purpose: "submission",
        eventId: null,
        questId,
        idempotencyKey: keyOf(request),
        body: bodyOf(request),
      };
      return answer(reply, uploadPhoto(deps, photo));
    });

    scope.post("/v1/events/:eventId/tickets/photo", upload, (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const photo: PhotoUpload = {
        playerId: playerIdOf(request),
        purpose: "ticket",
        eventId,
        questId: null,
        idempotencyKey: keyOf(request),
        body: bodyOf(request),
      };
      return answer(reply, uploadPhoto(deps, photo));
    });
  });
}
