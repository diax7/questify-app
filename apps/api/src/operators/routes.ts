import { joinCard } from "@questify/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  alreadyOperator,
  emailUnavailable,
  eventClosed,
  idempotencyKeyReused,
  invalidOperator,
  inviteEmailMismatch,
  inviteExpired,
  inviteNotFound,
  inviteUsed,
  joinCardStale,
  mailCap,
  notFound,
  notOperator,
  operatorInvitesFull,
  operatorPlayOff,
  ownerOnly,
  tooManyResets,
  unauthenticated,
} from "#src/auth/http-errors";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import { callerOf, parse } from "#src/auth/request";
import { cardInForce } from "#src/join/routes";
import { organizerContextOf } from "#src/organizers/context";
import {
  ABILITIES,
  PRESETS,
  claimInvite,
  createInvites,
  enrollOperator,
  listOperators,
  operatorEvents,
  operatorStations,
  previewInvite,
  removeOperator,
  revokeInvite,
  updateOperator,
  type CreateResult,
  type InviteState,
  type OperatorsDeps,
} from "#src/operators/operators";
import { myQr, resetMyQr } from "#src/operators/my-qr";
import { operatorScan, type ScanDeps } from "#src/operators/scan";
import { verifyInviteCode, type MyCodeKey } from "#src/quests/qr";
import type { Ranking } from "#src/ranking/ranking";

const BODY_LIMIT = 4096;
const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const owner = { config: { access: "owner" }, bodyLimit: BODY_LIMIT } as const;
const ownerCreating = { ...owner, config: { ...owner.config, idempotent: true } } as const;
const player = { config: { access: "player" }, bodyLimit: 1024 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;

const eventParams = z.object({ eventId: z.uuid() });
const inviteParams = z.object({ eventId: z.uuid(), inviteId: z.uuid() });
const operatorParams = z.object({ eventId: z.uuid(), operatorId: z.uuid() });
const listQuery = z.strictObject({ lang: z.enum(["ar", "en"]).default("ar") });
const preset = z.enum(Object.keys(PRESETS) as [keyof typeof PRESETS]).default("full");
const label = z.string().trim().min(1).max(56);
const inviteBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal"), label, preset }),
  z.strictObject({
    kind: z.literal("batch"),
    label,
    count: z.number().int().min(1).max(100),
    preset,
  }),
  z.strictObject({
    kind: z.literal("email"),
    email: z.string().min(3).max(254),
    preset,
    lang: z.enum(["ar", "en"]).default("ar"),
  }),
]);
const operatorBody = z.strictObject({
  abilities: z.array(z.enum(ABILITIES)).max(ABILITIES.length),
  canPlay: z.boolean(),
  questIds: z.array(z.uuid()).max(300),
});
const tokenBody = z.strictObject({ token: z.string().min(1).max(200) });
const playBody = z.strictObject({ cardVersion: z.string().min(1).max(20) });
const scanBody = z.strictObject({ questId: z.uuid(), code: z.string().min(1).max(200) });

function answerCreate(reply: FastifyReply, result: CreateResult) {
  switch (result.kind) {
    case "created":
      return reply.code(201).send({ ids: result.ids });
    case "not_found":
      throw notFound();
    case "not_owner":
      throw ownerOnly();
    case "event_closed":
      throw eventClosed();
    case "full":
      throw operatorInvitesFull();
    case "mail_cap":
      throw mailCap();
    case "email_unavailable":
      throw emailUnavailable();
  }
}

/** The answer for an invite the caller cannot claim. */
function inviteRefusal(state: Exclude<InviteState, "ok">): never {
  switch (state) {
    case "not_found":
      throw inviteNotFound();
    case "used":
      throw inviteUsed();
    case "expired":
      throw inviteExpired();
    case "email_mismatch":
      throw inviteEmailMismatch();
    case "already_operator":
      throw alreadyOperator();
  }
}

/**
 * The owner manages the event's operators (T-204, ADR-057, ADR-138): invites by personal QR, batch or email, the
 * abilities, the quest limit, may-play, removal. Members read the list; only the owner sees the claim addresses.
 */
export function registerOperatorRoutes(scope: FastifyInstance, deps: OperatorsDeps): void {
  scope.get("/events/:eventId/operators", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { lang } = parse(listQuery, request.query);
    const context = organizerContextOf(request);
    const list = await listOperators(
      deps,
      { ...context, isOwner: context.organizer.role === "owner", lang },
      eventId,
    );
    if (list === null) {
      throw notFound();
    }
    return list;
  });

  scope.post("/events/:eventId/operators/invites", ownerCreating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(inviteBody, request.body);
    const context = organizerContextOf(request);
    if (body.kind === "email") {
      const email = normalizeEmail(body.email);
      if (!isPlausibleEmail(email)) {
        throw invalidOperator({ field: "email" });
      }
      return answerCreate(
        reply,
        await createInvites(
          deps,
          context,
          eventId,
          { kind: "email", email, preset: body.preset, lang: body.lang },
          callerOf(request),
        ),
      );
    }
    return answerCreate(
      reply,
      await createInvites(
        deps,
        context,
        eventId,
        {
          kind: "personal",
          label: body.label,
          preset: body.preset,
          count: body.kind === "batch" ? body.count : 1,
        },
        callerOf(request),
      ),
    );
  });

  scope.delete("/events/:eventId/operators/invites/:inviteId", owner, async (request, reply) => {
    const { eventId, inviteId } = parse(inviteParams, request.params);
    const outcome = await revokeInvite(
      deps,
      organizerContextOf(request),
      { eventId, inviteId },
      request.id,
    );
    switch (outcome) {
      case "revoked":
        return reply.code(204).send();
      case "not_found":
        throw notFound();
      case "not_owner":
        throw ownerOnly();
      case "not_open":
        throw inviteUsed();
    }
  });

  scope.put("/events/:eventId/operators/:operatorId", owner, async (request) => {
    const { eventId, operatorId } = parse(operatorParams, request.params);
    const body = parse(operatorBody, request.body);
    const outcome = await updateOperator(
      deps,
      organizerContextOf(request),
      { eventId, operatorId, ...body },
      request.id,
    );
    switch (outcome) {
      case "changed":
      case "unchanged":
        return { operator: { id: operatorId, ...body } };
      case "not_found":
        throw notFound();
      case "not_owner":
        throw ownerOnly();
      case "bad_quest":
        throw invalidOperator({ field: "questIds" });
    }
  });

  // FR-905: at once; a scan in flight finishes first, every later one is refused.
  scope.delete("/events/:eventId/operators/:operatorId", owner, async (request, reply) => {
    const { eventId, operatorId } = parse(operatorParams, request.params);
    const outcome = await removeOperator(
      deps,
      organizerContextOf(request),
      { eventId, operatorId },
      request.id,
    );
    switch (outcome) {
      case "removed":
        return reply.code(204).send();
      case "not_found":
        throw notFound();
      case "not_owner":
        throw ownerOnly();
    }
  });
}

const playerIdOf = (request: { player?: { id: string } | undefined }): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

export type OperatorPlayerDeps = OperatorsDeps &
  ScanDeps &
  Readonly<{ myKey: MyCodeKey; ranking: Ranking }>;

/**
 * The person's side (T-204, T-205): claim an invite, list the events they staff, pick a station, scan, join as a player
 * when allowed, and their own My QR.
 */
export function registerOperatorPlayerRoutes(app: FastifyInstance, deps: OperatorPlayerDeps): void {
  const inviteOf = (token: string): string => {
    const check = verifyInviteCode(deps.inviteKey, token);
    if (check.kind !== "valid") {
      throw inviteNotFound();
    }
    return check.inviteId;
  };

  // FR-903: what the confirm screen shows; nothing is written.
  app.post("/v1/operator-invites/preview", player, async (request) => {
    const { token } = parse(tokenBody, request.body);
    const preview = await previewInvite(deps, playerIdOf(request), inviteOf(token));
    if (preview.state !== "ok" || preview.event === null) {
      return inviteRefusal(preview.state === "ok" ? "not_found" : preview.state);
    }
    return { event: preview.event, abilities: preview.abilities };
  });

  app.post("/v1/operator-invites/claim", playerIdempotent, async (request) => {
    const { token } = parse(tokenBody, request.body);
    const claimed = await claimInvite(deps, playerIdOf(request), inviteOf(token), request.id);
    if (claimed.outcome !== "claimed" || claimed.eventId === null) {
      return inviteRefusal(
        claimed.outcome === "claimed" || claimed.outcome === "ok" ? "not_found" : claimed.outcome,
      );
    }
    return { eventId: claimed.eventId };
  });

  app.get("/v1/me/operator-events", player, async (request) => ({
    events: (await operatorEvents(deps, playerIdOf(request))).map((event) => ({
      ...event,
      startsAt: event.startsAt?.toISOString() ?? null,
      endsAt: event.endsAt?.toISOString() ?? null,
    })),
  }));

  app.get("/v1/operator/events/:eventId/stations", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const stations = await operatorStations(deps, playerIdOf(request), eventId);
    if (stations === null) {
      throw notOperator();
    }
    return { stations };
  });

  // FR-907: an operator the owner allows to play joins as a player (the join card they saw is the consent).
  app.post("/v1/events/:eventId/operator/play", playerIdempotent, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { cardVersion } = parse(playBody, request.body);
    if (cardVersion !== joinCard().version) {
      throw joinCardStale({ card: cardInForce() });
    }
    const joined = await enrollOperator(deps, playerIdOf(request), eventId, cardVersion);
    switch (joined.outcome) {
      case "joined":
      case "already":
        return { enrollmentId: joined.enrollmentId };
      case "ended":
        throw eventClosed();
      case "not_allowed":
        throw operatorPlayOff();
    }
  });

  app.get("/v1/me/qr", player, async (request) => ({
    token: await myQr(deps, playerIdOf(request)),
  }));

  app.post("/v1/me/qr/reset", playerIdempotent, async (request) => {
    const token = await resetMyQr(deps, playerIdOf(request), request.id);
    if (token === null) {
      throw tooManyResets();
    }
    return { token };
  });

  // FR-923, FR-924: one result for the three colours; a removed operator gets 403 and leaves operator mode.
  app.post("/v1/operator/scan", playerIdempotent, async (request) => {
    const body = parse(scanBody, request.body);
    const key = request.headers["idempotency-key"];
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the idempotency convention answers first
    if (typeof key !== "string") {
      throw unauthenticated();
    }
    const result = await operatorScan(
      deps,
      {
        operatorId: playerIdOf(request),
        questId: body.questId,
        code: body.code,
        idempotencyKey: key,
      },
      callerOf(request),
    );
    switch (result.kind) {
      case "not_operator":
        throw notOperator();
      case "key_reused":
        throw idempotencyKeyReused();
      case "completed":
        // The player's place moves like a self-scan; a ranking failure never fails the scan.
        await deps.ranking.afterCompletion(result.playerId, result.completionId);
        return {
          result: "completed",
          player: result.player,
          points: result.points,
          occurrence: result.occurrence,
          replayed: result.replayed,
        };
      case "already_completed":
        return { result: "already_completed", player: result.player };
      case "refused":
        return {
          result: "refused",
          reason: result.reason,
          ...(result.detail === undefined ? {} : { detail: result.detail }),
          player: result.player,
        };
    }
  });
}
