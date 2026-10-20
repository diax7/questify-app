import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  eventNotDraft,
  eventNotLive,
  eventTimesLocked,
  invalidEvent,
  notFound,
  scopeLimited,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import type {
  CreateResult,
  EndResult,
  Events,
  RemoveResult,
  UpdateResult,
} from "#src/events/events";
import type { EventRecord } from "#src/events/store";
import { organizerContextOf } from "#src/organizers/context";
import type { SettingsService } from "#src/settings/service";

const BODY_LIMIT = 8192;

/** The event's wall clock, read in its zone: no seconds, no `Z`, no offset. */
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const bilingual = (max: number) =>
  z.strictObject({ ar: z.string().max(max).optional(), en: z.string().max(max).optional() });

// Strict: a field the API never writes (status, join code) is refused, not silently dropped.
const eventFields = {
  name: bilingual(120).optional(),
  kind: z.enum(["physical", "virtual", "workplace"]).optional(),
  venue: bilingual(200).optional(),
  access: z.enum(["public", "unlisted", "private"]).optional(),
  joinMethods: z
    .array(z.enum(["code", "qr", "link", "public_list"]))
    // An empty list reaches merge, which names the field (422 joinMethods) rather than a bare 400.
    .max(4)
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  dayStartHour: z.number().int().min(0).max(23).optional(),
  startsAt: localTime.optional(),
  endsAt: localTime.optional(),
};
const patchBody = z.strictObject(eventFields);
const createBody = z.strictObject({ ...eventFields, startsAt: localTime, endsAt: localTime });
const endBody = z.strictObject({ confirm: z.literal(true) });
const rankingBody = z.strictObject({ enabled: z.boolean() });
const eventParams = z.object({ eventId: z.uuid() });

const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;

/** What the dashboard sees of an event: instants as UTC ISO, the zone to show them in. */
const view = (event: EventRecord) => ({
  id: event.id,
  joinCode: event.joinCode,
  name: event.name,
  kind: event.kind,
  venue: event.venue,
  access: event.access,
  joinMethods: event.joinMethods,
  timezone: event.timezone,
  dayStartHour: event.dayStartHour,
  startsAt: event.startsAt?.toISOString() ?? null,
  endsAt: event.endsAt?.toISOString() ?? null,
  status: event.status,
  statusNow: event.statusNow,
  createdAt: event.createdAt.toISOString(),
  ranking: event.rankingOn,
});

function answerCreate(reply: FastifyReply, result: CreateResult) {
  switch (result.kind) {
    case "created":
      return reply.code(201).send({ event: view(result.event) });
    case "invalid":
      throw invalidEvent({ field: result.field });
    case "scope_limited":
      throw scopeLimited();
  }
}

function answerUpdate(result: UpdateResult) {
  switch (result.kind) {
    case "updated":
      return { event: view(result.event) };
    case "invalid":
      throw invalidEvent({ field: result.field });
    case "not_found":
      throw notFound();
    case "times_locked":
      throw eventTimesLocked();
  }
}

function answerGone(reply: FastifyReply, result: RemoveResult | EndResult) {
  switch (result.kind) {
    case "deleted":
    case "ended":
      return reply.code(204).send();
    case "not_found":
      throw notFound();
    case "not_draft":
      throw eventNotDraft();
    case "not_live":
      throw eventNotLive();
  }
}

/**
 * The event builder's routes, registered inside the organizer scope (its hook has already checked the session and
 * the membership). An editor limited to chosen events sees only those: the database applies the limit.
 */
export function registerEventRoutes(
  scope: FastifyInstance,
  events: Events,
  settings: SettingsService,
): void {
  scope.get("/events", member, async (request) => {
    const list = await events.list(organizerContextOf(request));
    return { events: list.map(view) };
  });

  // A double click must not make two events: the Idempotency-Key replays the first answer.
  scope.post(
    "/events",
    { ...member, config: { ...member.config, idempotent: true } },
    async (request, reply) => {
      const body = parse(createBody, request.body);
      return answerCreate(
        reply,
        await events.create(organizerContextOf(request), body, callerOf(request)),
      );
    },
  );

  scope.get("/events/:eventId", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const event = await events.get(organizerContextOf(request), eventId);
    if (event === undefined) {
      throw notFound();
    }
    return { event: view(event) };
  });

  scope.patch("/events/:eventId", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(patchBody, request.body);
    return answerUpdate(
      await events.update(organizerContextOf(request), eventId, body, callerOf(request)),
    );
  });

  scope.delete("/events/:eventId", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    return answerGone(
      reply,
      await events.remove(organizerContextOf(request), eventId, callerOf(request)),
    );
  });

  // The dashboard asks the owner to confirm; the body says they did.
  scope.post("/events/:eventId/end", owner, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    parse(endBody, request.body);
    return answerGone(
      reply,
      await events.endEarly(organizerContextOf(request), eventId, callerOf(request)),
    );
  });

  // FR-607: the owner turns the event's ranking off and on; the event's other switches stay as they are.
  scope.put("/events/:eventId/ranking", owner, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { enabled } = parse(rankingBody, request.body);
    const context = organizerContextOf(request);
    const saved = await settings.saveEventSwitch(
      { staffUserId: context.staffUserId, organizerId: context.organizerId },
      eventId,
      "ranking",
      enabled,
      { requestId: request.id },
    );
    if (!saved.ok) {
      throw notFound();
    }
    return { ranking: enabled };
  });
}
