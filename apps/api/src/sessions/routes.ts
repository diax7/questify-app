import {
  announcementBodySchema,
  checkAnnouncement,
  sessionBodySchema,
  sessionRegistrationSchema,
  type MemberSession,
  type TeamSession,
} from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { unauthenticated } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import { requireEventFeature } from "#src/settings/feature-guard";
import type { SettingsService } from "#src/settings/service";
import {
  deleteRaceRefusal,
  sessionCall,
  sessionError,
  type SessionDeps,
} from "#src/sessions/store";

const eventParams = z.object({ eventId: z.uuid() });
const targetParams = eventParams.extend({ sessionId: z.uuid() });
const importBody = z.strictObject({ rows: z.array(sessionBodySchema).min(1).max(500) });
const messageBody = announcementBodySchema.omit({ sendAt: true });
const registerBody = z.union([
  z.strictObject({ confirmOverlap: z.boolean().optional() }),
  z.undefined(),
  z.null(),
]);
const noBody = z.union([z.strictObject({}), z.undefined(), z.null()]);

const member = { config: { access: "member" } } as const;
/** A write by the team: the caller's access to the event is asked again before a stored answer is replayed. */
const writing = (deps: SessionDeps, bodyLimit = 24_000) =>
  ({
    config: { access: "member", idempotent: true },
    bodyLimit,
    preValidation: async (request: FastifyRequest) => {
      const { eventId } = parse(eventParams, request.params);
      await sessionCall(deps, organizerContextOf(request), "SELECT session_authorize($1)", [
        eventId,
      ]);
    },
  }) as const;

/** The first failing field of a body the schema refused, in the words the dashboard maps to a message. */
function invalidSession(error: z.ZodError) {
  const field = error.issues[0]?.path[0];
  return sessionError(422, "invalid_session", {
    issue: typeof field === "string" ? field : "session",
  });
}

const draftOf = (body: unknown) => {
  const parsed = sessionBodySchema.safeParse(body);
  if (!parsed.success) throw invalidSession(parsed.error);
  return JSON.stringify(parsed.data);
};

/** The dashboard's side (T-505): list and report, add, edit, delete, registration, import and the message. */
export function registerSessionTeamRoutes(scope: FastifyInstance, deps: SessionDeps): void {
  const run = <Row extends object>(request: FastifyRequest, sql: string, values: unknown[]) =>
    sessionCall<Row>(deps, organizerContextOf(request), sql, values);
  scope.get("/events/:eventId/sessions", member, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    const result = await run<{ sessions: TeamSession[] }>(
      request,
      "SELECT session_list($1) AS sessions",
      [eventId],
    );
    return { sessions: result.sessions };
  });
  scope.post("/events/:eventId/sessions", writing(deps), async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const draft = draftOf(request.body);
    const result = await run<{ session: TeamSession }>(
      request,
      "SELECT session_save($1, $2::jsonb, NULL, $3) AS session",
      [eventId, draft, request.id],
    );
    return reply.code(201).send(result.session);
  });
  scope.put("/events/:eventId/sessions/:sessionId", writing(deps), async (request) => {
    const { eventId, sessionId } = parse(targetParams, request.params);
    const draft = draftOf(request.body);
    const result = await run<{ session: TeamSession }>(
      request,
      "SELECT session_save($1, $2::jsonb, $3, $4) AS session",
      [eventId, draft, sessionId, request.id],
    );
    return result.session;
  });
  scope.delete("/events/:eventId/sessions/:sessionId", writing(deps), async (request) => {
    const { eventId, sessionId } = parse(targetParams, request.params);
    const result = await run<{ lost: number }>(
      request,
      "SELECT session_delete($1, $2, $3) AS lost",
      [eventId, sessionId, request.id],
    ).catch(deleteRaceRefusal);
    return { registrationsLost: result.lost };
  });
  scope.put("/events/:eventId/sessions/:sessionId/registration", writing(deps), async (request) => {
    const { eventId, sessionId } = parse(targetParams, request.params);
    const body = sessionRegistrationSchema.safeParse(request.body);
    if (!body.success) throw invalidSession(body.error);
    const result = await run<{ session: TeamSession }>(
      request,
      "SELECT session_registration_set($1, $2, $3, $4, $5) AS session",
      [eventId, sessionId, body.data.open, body.data.seats, request.id],
    );
    return result.session;
  });
  scope.post(
    "/events/:eventId/sessions/import",
    writing(deps, 2_500_000),
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const body = importBody.safeParse(request.body);
      if (!body.success) throw invalidSession(body.error);
      const result = await run<{ created: number }>(
        request,
        "SELECT session_import($1, $2::jsonb, $3) AS created",
        [eventId, JSON.stringify(body.data.rows), request.id],
      );
      return reply.code(201).send({ created: result.created });
    },
  );
  scope.post(
    "/events/:eventId/sessions/:sessionId/message",
    writing(deps),
    async (request, reply) => {
      const { eventId, sessionId } = parse(targetParams, request.params);
      const parsed = messageBody.safeParse(request.body);
      if (!parsed.success) throw invalidSession(parsed.error);
      const checked = checkAnnouncement(parsed.data);
      if (!checked.ok) {
        throw sessionError(422, "invalid_session", { issue: checked.field, reason: checked.issue });
      }
      const result = await run<{ id: string; recipients: number; replayed: boolean }>(
        request,
        "SELECT * FROM session_message($1, $2, $3::jsonb, $4, $5)",
        [
          eventId,
          sessionId,
          JSON.stringify(checked.draft),
          String(request.headers["idempotency-key"]),
          request.id,
        ],
      );
      return reply
        .code(201)
        .send({ id: result.id, recipients: result.recipients, replayed: result.replayed });
    },
  );
}

function playerContext(request: FastifyRequest) {
  if (request.player === undefined) throw unauthenticated();
  return { playerId: request.player.id };
}

const player = { config: { access: "player" } } as const;
const playerIdempotent = { config: { access: "player", idempotent: true } } as const;

/** The player's side (T-505): the agenda with their own state, registering (with the overlap warning) and cancelling. */
export function registerMemberSessionRoutes(
  app: FastifyInstance,
  deps: SessionDeps & Readonly<{ settings: SettingsService }>,
): void {
  app.get("/v1/events/:eventId/sessions", player, async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    const { eventId } = parse(eventParams, request.params);
    await requireEventFeature(deps.settings, eventId, playerContext(request).playerId, "agenda");
    const result = await sessionCall<{ sessions: MemberSession[] }>(
      deps,
      playerContext(request),
      "SELECT member_sessions($1) AS sessions",
      [eventId],
    );
    return { sessions: result.sessions };
  });
  app.post(
    "/v1/events/:eventId/sessions/:sessionId/register",
    playerIdempotent,
    async (request) => {
      const { eventId, sessionId } = parse(targetParams, request.params);
      const body = parse(registerBody, request.body);
      await requireEventFeature(deps.settings, eventId, playerContext(request).playerId, "agenda");
      const result = await sessionCall<{ answer: unknown }>(
        deps,
        playerContext(request),
        "SELECT session_register($1, $2, $3) AS answer",
        [eventId, sessionId, body?.confirmOverlap === true],
      );
      return result.answer;
    },
  );
  app.post("/v1/events/:eventId/sessions/:sessionId/cancel", playerIdempotent, async (request) => {
    const { eventId, sessionId } = parse(targetParams, request.params);
    parse(noBody, request.body);
    const result = await sessionCall<{ status: string }>(
      deps,
      playerContext(request),
      "SELECT session_cancel($1, $2) AS status",
      [eventId, sessionId],
    );
    return { status: result.status };
  });
}
