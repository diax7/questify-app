import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { organizerContextOf } from "#src/organizers/context";
import { teamSeat } from "#src/organizers/store";
import type { ObjectStore } from "#src/storage/client";

/** How long a signed image read lasts: the media link's limit (client.ts), so a 302 is good for five minutes. */
export const IMAGE_URL_SECONDS = 300;
/** The app and the browser may keep the redirect a little less than the URL lasts. */
const IMAGE_CACHE = "private, max-age=240";

export type ImageReadDeps = Readonly<{ pool: Pool; storage?: ObjectStore | undefined }>;

const params = z.object({ eventId: z.uuid(), imageId: z.uuid() });

/**
 * The key a seat-checked door gives for this image, or undefined for every refusal: a bad id, a database refusal (not a
 * member, not the team's event, out of the editor's scope), or no such stored image of this event.
 */
async function keyOf(
  deps: ImageReadDeps,
  seat: RequestContext,
  door: "event_image_key" | "team_image_key",
  raw: unknown,
): Promise<string | undefined> {
  const parsed = params.safeParse(raw);
  if (!parsed.success) return undefined;
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, async () => {
        const { rows } = await client.query<{ key: string | null }>(
          `SELECT ${door}($1, $2) AS key`,
          [parsed.data.eventId, parsed.data.imageId.toLowerCase()],
        );
        return rows[0]?.key ?? undefined;
      }),
    );
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^(AM403|AN404|22P02|42501)$/.test(code)) return undefined;
    throw error;
  }
}

/**
 * Answers a 302 to a five-minute link of the key's object on the media route (ADR-840), served as the stored PNG or
 * JPEG; every refusal, and a server with no media store, is one 404, so a caller learns nothing about another event's
 * images.
 */
async function redirect(
  deps: ImageReadDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  key: string | undefined,
): Promise<FastifyReply> {
  if (deps.storage === undefined || key === undefined) throw notFound();
  const signed = deps.storage.signGet(key, IMAGE_URL_SECONDS);
  reply
    .header("cache-control", IMAGE_CACHE)
    .header("vary", "accept")
    .header("referrer-policy", "no-referrer");
  // The app asks for JSON (its client always does): it then loads the URL itself, so no redirect can carry its token
  // on to the media route (plan section 5). A browser's <img> asks for an image and follows the 302.
  if (wantsJson(request)) {
    return reply.send({ url: signed.url, expiresAt: signed.expiresAt.toISOString() });
  }
  return reply.code(302).header("location", signed.url).send();
}

const wantsJson = (request: FastifyRequest): boolean => {
  const accept = String(request.headers.accept ?? "");
  return accept.includes("application/json") && !accept.includes("image/");
};

const playerSeat = (request: FastifyRequest): RequestContext | undefined =>
  request.player === undefined ? undefined : { playerId: request.player.id };

/** The player's read door (ADR-829 (2)): an active member of the event, never a device. */
export function registerImageReadRoutes(app: FastifyInstance, deps: ImageReadDeps): void {
  app.get(
    "/v1/events/:eventId/images/:imageId",
    { config: { access: "player" } },
    async (request, reply) => {
      const seat = playerSeat(request);
      if (seat === undefined || deps.storage === undefined) throw notFound();
      return redirect(
        deps,
        request,
        reply,
        await keyOf(deps, seat, "event_image_key", request.params),
      );
    },
  );
}

/** The team's read door, for the dashboard's previews: owners and editors inside their event scope. */
export function registerImageTeamReadRoutes(scope: FastifyInstance, deps: ImageReadDeps): void {
  scope.get(
    "/events/:eventId/images/:imageId",
    { config: { access: "member" } },
    async (request, reply) => {
      if (deps.storage === undefined) throw notFound();
      const seat = teamSeat(organizerContextOf(request));
      return redirect(
        deps,
        request,
        reply,
        await keyOf(deps, seat, "team_image_key", request.params),
      );
    },
  );
}
