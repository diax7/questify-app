import { announcementBodySchema, checkAnnouncement, type AnnouncementView } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import {
  announcementCall,
  announcementError,
  type AnnouncementDeps,
} from "#src/announcements/store";

const eventParams = z.object({ eventId: z.uuid() });
const targetParams = eventParams.extend({ announcementId: z.uuid() });
const listQuery = z
  .object({
    pending: z.enum(["true", "false"]).default("false"),
    afterAt: z.iso.datetime({ offset: true }).optional(),
    afterId: z.uuid().optional(),
  })
  .refine((query) => (query.afterAt === undefined) === (query.afterId === undefined))
  .refine((query) => query.pending === "true" || query.afterAt === undefined);
const member = { config: { access: "member" } } as const;
const writing = (deps: AnnouncementDeps) =>
  ({
    config: { access: "member", idempotent: true },
    bodyLimit: 24_000,
    preValidation: async (request: FastifyRequest) => {
      const { eventId } = parse(eventParams, request.params);
      await announcementCall(
        deps,
        organizerContextOf(request),
        "SELECT * FROM announcement_preview($1)",
        [eventId],
      );
    },
  }) as const;

export function registerAnnouncementTeamRoutes(
  scope: FastifyInstance,
  deps: AnnouncementDeps,
): void {
  scope.get("/events/:eventId/announcements", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const query = parse(listQuery, request.query);
    const result = await announcementCall<{ announcements: AnnouncementView[] }>(
      deps,
      organizerContextOf(request),
      "SELECT announcement_list($1, $2, $3, $4) AS announcements",
      [eventId, query.pending === "true", query.afterAt ?? null, query.afterId ?? null],
    );
    const announcements = result.announcements.slice(0, 30);
    const last = announcements.at(-1);
    return {
      announcements,
      next:
        result.announcements.length > 30 && last !== undefined
          ? { afterAt: last.sendAt, afterId: last.id }
          : null,
    };
  });
  scope.get("/events/:eventId/announcements/preview", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    return announcementCall(
      deps,
      organizerContextOf(request),
      "SELECT * FROM announcement_preview($1)",
      [eventId],
    );
  });
  scope.post("/events/:eventId/announcements", writing(deps), async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const parsed = announcementBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw announcementError(422, "invalid_announcement", {
        field: parsed.error.issues[0]?.path[0] ?? "announcement",
        issue: "invalid",
      });
    }
    const checked = checkAnnouncement(parsed.data);
    if (!checked.ok)
      throw announcementError(422, "invalid_announcement", {
        field: checked.field,
        issue: checked.issue,
      });
    const result = await announcementCall<{
      id: string | null;
      status: string;
      send_at: Date;
      replayed: boolean;
    }>(
      deps,
      organizerContextOf(request),
      "SELECT * FROM announcement_send($1, $2::jsonb, $3, $4, $5)",
      [
        eventId,
        JSON.stringify(checked.draft),
        parsed.data.sendAt ?? null,
        String(request.headers["idempotency-key"]),
        request.id,
      ],
    );
    if (result.id === null) {
      request.log.error({ event: "push.announcement_not_written", eventId });
      throw announcementError(503, "announcement_unavailable");
    }
    return reply.code(201).send({
      id: result.id,
      status: result.status,
      sendAt: result.send_at.toISOString(),
      replayed: result.replayed,
    });
  });
  scope.post(
    "/events/:eventId/announcements/:announcementId/cancel",
    writing(deps),
    async (request) => {
      const { eventId, announcementId } = parse(targetParams, request.params);
      parse(z.union([z.strictObject({}), z.undefined(), z.null()]), request.body);
      return announcementCall(
        deps,
        organizerContextOf(request),
        "SELECT announcement_cancel($1, $2, $3) AS status",
        [eventId, announcementId, request.id],
      );
    },
  );
}

export function registerMemberAnnouncementRoutes(
  app: FastifyInstance,
  deps: AnnouncementDeps,
): void {
  app.get(
    "/v1/events/:eventId/announcements",
    { config: { access: "player" } },
    async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const { eventId } = parse(eventParams, request.params);
      const { size } = parse(
        z.object({ size: z.coerce.number().int().min(1).max(50).default(50) }),
        request.query,
      );
      if (request.player === undefined) throw unauthenticated();
      return announcementCall(
        deps,
        { playerId: request.player.id },
        "SELECT member_announcements($1, $2) AS announcements",
        [eventId, size],
      );
    },
  );
}
