import {
  EVENT_TICKET_KINDS,
  PLATFORM_TICKET_KINDS,
  TICKET_DEVICE_FACT,
  TICKET_DEVICE_MODEL_MAX,
  TICKET_KINDS,
  TICKET_OPEN_LIMIT,
  TICKET_TEXT_MAX,
  USERNAME_MAX,
  USERNAME_MIN,
  decodeCursor,
  encodeCursor,
} from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  abilityOff,
  featureOff,
  idempotencyKeyReused,
  invalidDevice,
  invalidRequest,
  notFound,
  notOperator,
  outsideOperatorQuests,
  selfAnswer,
  ticketAlreadyClosed,
  ticketAlreadyReported,
  ticketEventClosed,
  ticketMoved,
  ticketNotEscalated,
  ticketNotMember,
  ticketNotOpen,
  ticketSelfReport,
  ticketSendingClosed,
  ticketText,
  ticketUnknownPlayer,
  ticketUnknownQuest,
  ticketUsernameRequired,
  tooManyLookups,
  tooManyOpenTickets,
  tooManyTickets,
  unauthenticated,
} from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack, type DeviceLimit } from "#src/devices/limits";
import { organizerContextOf } from "#src/organizers/context";
import type { SettingsService } from "#src/settings/service";
import {
  markTicketsSeen,
  openPlatformTicket,
  openTicket,
  operatorAnswer,
  operatorInbox,
  operatorInboxCount,
  operatorTicket,
  ownTickets,
  staffAnswer,
  staffEscalate,
  staffTickets,
  type Answered,
  type Done,
  type InboxPosition,
  type TicketDeps,
  type TicketRefusal,
} from "#src/tickets/tickets";

const BODY_LIMIT = 8192;
const player = { config: { access: "player" }, bodyLimit: BODY_LIMIT } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const memberIdempotent = { ...member, config: { ...member.config, idempotent: true } } as const;

const ID = /^[1-9][0-9]{0,17}$/;
const eventParams = z.object({ eventId: z.uuid() });
const ticketParams = z.object({ eventId: z.uuid(), ticketId: z.string().regex(ID) });
// The database cleans and measures the text (NFC, trimmed); this only bounds the body.
const textField = z.string().max(TICKET_TEXT_MAX * 4);
// A username only on a report, and a report never about a quest (the database checks both again).
const sendBody = z
  .strictObject({
    kind: z.enum(EVENT_TICKET_KINDS),
    questId: z.uuid().optional(),
    reportedUsername: z.string().min(USERNAME_MIN).max(USERNAME_MAX).optional(),
    text: textField,
  })
  .refine((body) => body.kind === "report_player" || body.reportedUsername === undefined)
  .refine((body) => body.kind !== "report_player" || body.questId === undefined);
const deviceBody = z.strictObject({
  appVersion: z.string().regex(TICKET_DEVICE_FACT),
  platform: z.enum(["ios", "android"]),
  osVersion: z.string().regex(TICKET_DEVICE_FACT),
  model: z
    .string()
    .max(TICKET_DEVICE_MODEL_MAX * 4)
    .nullable(),
});
// An app problem carries the phone's facts; a suggestion never keeps any.
const platformBody = z
  .strictObject({
    kind: z.enum(PLATFORM_TICKET_KINDS),
    text: textField,
    device: deviceBody.optional(),
  })
  .refine((body) => body.kind !== "app_problem" || body.device !== undefined);
const noteBody = z.strictObject({ note: textField });
const answerBody = z.strictObject({
  reply: z
    .string()
    .max(TICKET_TEXT_MAX * 4)
    .optional(),
});
const seenBody = z.strictObject({ ids: z.array(z.string().regex(ID)).min(1).max(50) });
const teamQuery = z.strictObject({
  status: z.enum(["open", "with_questify", "closed"]).default("open"),
  kind: z.enum(TICKET_KINDS).optional(),
  cursor: z.string().regex(ID).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const inboxQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const inboxCursor = z.strictObject({
  p: z.string().regex(/^-?[0-9]{1,19}$/),
  k: z.enum(["submission", "ticket"]),
  i: z.string().regex(ID),
});

type Deps = TicketDeps &
  Readonly<{ settings: SettingsService; keys: Pick<AuthKeys, "playerKey" | "playerQuestKey"> }>;

/**
 * Per-player limits on the help desk's reads and seen marks (CTO code review, NIT 6): the app reads a few a minute (on
 * open, after a send, the badge every 30 seconds); a client in a loop gets 429 `too_many_attempts` with Retry-After.
 */
export const TICKET_LIMITS = {
  playerReads: { bucket: BUCKETS.ticketRead, max: 60, windowSeconds: 60 },
  operatorReads: { bucket: BUCKETS.inboxRead, max: 60, windowSeconds: 60 },
  /**
   * Usernames a report names that are not in the event, per player and event (T-312, CTO 8): the lookup can tell a
   * member is in the event even where the board would not show them, so failed lookups are capped. No name is kept.
   */
  lookupMisses: { bucket: BUCKETS.ticketLookup, max: 10, windowSeconds: 3600 },
} as const satisfies Readonly<Record<string, DeviceLimit>>;

const hold = (deps: Deps, limit: DeviceLimit, request: FastifyRequest, reply: FastifyReply) =>
  holdBack(deps.pool, [{ limit, key: deps.keys.playerKey(playerIdOf(request)) }], true, reply);

const playerIdOf = (request: FastifyRequest): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

export const keyOf = (request: FastifyRequest): string => {
  const key = request.headers["idempotency-key"];
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the idempotency convention answers first
  if (typeof key !== "string") {
    throw unauthenticated();
  }
  return key;
};

/** The seconds until a player may name another username in this event's reports, or undefined when free now. */
async function lookupWait(deps: Deps, key: Buffer): Promise<number | undefined> {
  const limit = TICKET_LIMITS.lookupMisses;
  const window = await withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, () =>
      countRecent(client, limit.bucket, key, limit.windowSeconds),
    ),
  );
  return window.count >= limit.max ? window.retryAfterSeconds : undefined;
}

/** Counts one username a report named that is not in the event. */
async function recordLookupMiss(deps: Deps, key: Buffer): Promise<void> {
  await withConnection(deps.pool, (client) =>
    withRequestContext(client, {}, () => record(client, TICKET_LIMITS.lookupMisses.bucket, key)),
  );
}

/** One HTTP answer per refusal (API.md, Help desk); logged by its reason only, never the text. */
export function refuse(request: FastifyRequest, reply: FastifyReply, result: TicketRefusal): never {
  request.log.info({ event: "ticket.refused", reason: result.kind });
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "not_member":
      throw ticketNotMember();
    case "feature_off":
      throw featureOff();
    case "sending_closed":
      throw ticketSendingClosed();
    case "unknown_quest":
      throw ticketUnknownQuest();
    case "invalid_kind":
      throw invalidRequest();
    case "invalid_text":
      throw ticketText({ problem: result.problem });
    case "too_many_open":
      throw tooManyOpenTickets({ limit: TICKET_OPEN_LIMIT });
    case "too_many_tickets":
      reply.header("retry-after", String(result.retryAfterSeconds));
      throw tooManyTickets();
    case "key_reused":
      throw idempotencyKeyReused();
    case "already_closed":
      throw ticketAlreadyClosed();
    case "event_closed":
      throw ticketEventClosed();
    case "self_answer":
      throw selfAnswer();
    case "outside_quests":
      throw outsideOperatorQuests();
    case "not_operator":
      throw notOperator();
    case "ability_off":
      throw abilityOff();
    case "unknown_player":
      throw ticketUnknownPlayer();
    case "self_report":
      throw ticketSelfReport();
    case "already_reported":
      throw ticketAlreadyReported();
    case "username_required":
      throw ticketUsernameRequired();
    case "invalid_device":
      throw invalidDevice({ field: result.field });
    case "not_open":
      throw ticketNotOpen();
    case "moved":
      throw ticketMoved();
    case "not_escalated":
      throw ticketNotEscalated();
  }
}

export const valueOf = <T>(request: FastifyRequest, reply: FastifyReply, result: Done<T>): T =>
  result.kind === "done" ? result.value : refuse(request, reply, result);

/** The inbox's opaque cursor: base64url of the last item's (created_at in microseconds, kind, id). */
export function inboxCursorOf(position: InboxPosition): string {
  return encodeCursor({ p: position.position, k: position.kind, i: position.id });
}

/** Reads an inbox cursor; anything else is a 400, so a forged cursor never reaches the database. */
export function inboxPositionOf(cursor: string | undefined): InboxPosition | null {
  if (cursor === undefined) {
    return null;
  }
  try {
    const parsed = inboxCursor.safeParse(decodeCursor(cursor));
    if (parsed.success) {
      return { position: parsed.data.p, kind: parsed.data.k, id: parsed.data.i };
    }
  } catch {
    // An unreadable cursor answers like a malformed one, below.
  }
  throw invalidRequest();
}

export const logAnswer = (
  request: FastifyRequest,
  answered: Answered,
  via: "operator" | "staff" | "admin",
) => {
  request.log.info({
    event: "ticket.answered",
    outcome: answered.outcome,
    via,
    replayed: answered.replayed,
  });
  return answered;
};

/** Whether the composed config (the platform's switch and the event's) leaves the help desk on. */
async function helpDeskOn(deps: Deps, eventId: string, playerId: string): Promise<boolean> {
  const config = await deps.settings.forEvent(eventId, playerId);
  return config.kind !== "ok" || config.config.features["helpDesk"]?.enabled !== false;
}

/**
 * The player's side of the help desk (FR-337 to FR-339): send a question or a problem report with an Idempotency-Key,
 * read their own requests (in one event, or every event's for the profile) and mark answers seen. Reading never
 * depends on the switch or the enrollment's status; only sending does.
 */
function registerTicketPlayerRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/v1/events/:eventId/tickets", playerIdempotent, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(sendBody, request.body);
    const playerId = playerIdOf(request);
    if (!(await helpDeskOn(deps, eventId, playerId))) {
      refuse(request, reply, { kind: "feature_off" });
    }
    const lookupKey = deps.keys.playerQuestKey(playerId, eventId);
    if (body.kind === "report_player") {
      const wait = await lookupWait(deps, lookupKey);
      if (wait !== undefined) {
        request.log.info({ event: "ticket.refused", reason: "too_many_lookups" });
        reply.header("retry-after", String(wait));
        throw tooManyLookups({ retryAfterSeconds: wait });
      }
    }
    const result = await openTicket(deps, {
      playerId,
      eventId,
      kind: body.kind,
      questId: body.questId ?? null,
      reportedUsername: body.reportedUsername ?? null,
      text: body.text,
      idempotencyKey: keyOf(request),
    });
    if (result.kind === "unknown_player") {
      await recordLookupMiss(deps, lookupKey);
    }
    const opened = valueOf(request, reply, result);
    request.log.info({
      event: "ticket.opened",
      kind: body.kind,
      queue: "event",
      hasQuest: body.questId !== undefined,
      marked: opened.marked,
      replayed: opened.replayed,
    });
    return reply.code(opened.replayed ? 200 : 201).send({
      ticket: { id: opened.ticketId, status: opened.status, createdAt: opened.createdAt },
    });
  });

  app.get("/v1/events/:eventId/tickets/mine", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    await hold(deps, TICKET_LIMITS.playerReads, request, reply);
    const tickets = await ownTickets(deps, playerIdOf(request), eventId);
    return {
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        kind: ticket.kind,
        quest: ticket.quest,
        text: ticket.text,
        status: ticket.status,
        outcome: ticket.outcome,
        reply: ticket.reply,
        closedAt: ticket.closedAt,
        createdAt: ticket.createdAt,
        unread: ticket.unread,
        withQuestify: ticket.withQuestify,
        answeredBy: ticket.answeredBy,
        reportedUsername: ticket.reportedUsername,
      })),
      open: tickets.filter((ticket) => ticket.status === "open").length,
      limit: { open: TICKET_OPEN_LIMIT },
    };
  });

  // An app problem or a suggestion to Questify, with no event (FR-1822): a player in no event can write.
  app.post("/v1/me/tickets", playerIdempotent, async (request, reply) => {
    const body = parse(platformBody, request.body);
    const opened = valueOf(
      request,
      reply,
      await openPlatformTicket(deps, {
        playerId: playerIdOf(request),
        kind: body.kind,
        text: body.text,
        device: body.kind === "app_problem" ? (body.device ?? null) : null,
        idempotencyKey: keyOf(request),
      }),
    );
    request.log.info({
      event: "ticket.opened",
      kind: body.kind,
      queue: "questify",
      hasQuest: false,
      marked: opened.marked,
      replayed: opened.replayed,
    });
    return reply.code(opened.replayed ? 200 : 201).send({
      ticket: { id: opened.ticketId, status: opened.status, createdAt: opened.createdAt },
    });
  });

  app.get("/v1/me/tickets", player, async (request, reply) => {
    await hold(deps, TICKET_LIMITS.playerReads, request, reply);
    return { tickets: await ownTickets(deps, playerIdOf(request), null) };
  });

  app.post("/v1/events/:eventId/tickets/seen", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const { ids } = parse(seenBody, request.body);
    await hold(deps, TICKET_LIMITS.playerReads, request, reply);
    await markTicketsSeen(deps, playerIdOf(request), { eventId, ids });
    return reply.code(204).send();
  });

  // The profile's Your requests lists every event's tickets, so it marks them in one call (CTO note 1).
  app.post("/v1/me/tickets/seen", player, async (request, reply) => {
    const { ids } = parse(seenBody, request.body);
    await hold(deps, TICKET_LIMITS.playerReads, request, reply);
    await markTicketsSeen(deps, playerIdOf(request), { eventId: null, ids });
    return reply.code(204).send();
  });
}

/** Staff mode's Inbox and ticket screen (FR-927, FR-338): an operator of the event with the right ability. */
function registerTicketOperatorRoutes(app: FastifyInstance, deps: Deps): void {
  app.get("/v1/operator/events/:eventId/inbox", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const query = parse(inboxQuery, request.query);
    await hold(deps, TICKET_LIMITS.operatorReads, request, reply);
    const inbox = valueOf(
      request,
      reply,
      await operatorInbox(deps, playerIdOf(request), {
        eventId,
        after: inboxPositionOf(query.cursor),
        limit: query.limit,
      }),
    );
    return {
      items: inbox.items,
      nextCursor: inbox.next === null ? null : inboxCursorOf(inbox.next),
      abilities: inbox.abilities,
    };
  });

  app.get("/v1/operator/events/:eventId/inbox/count", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    await hold(deps, TICKET_LIMITS.operatorReads, request, reply);
    return valueOf(request, reply, await operatorInboxCount(deps, playerIdOf(request), eventId));
  });

  app.get("/v1/operator/events/:eventId/tickets/:ticketId", player, async (request, reply) => {
    const { eventId, ticketId } = parse(ticketParams, request.params);
    await hold(deps, TICKET_LIMITS.operatorReads, request, reply);
    return {
      ticket: valueOf(
        request,
        reply,
        await operatorTicket(deps, playerIdOf(request), { eventId, ticketId }),
      ),
    };
  });

  app.post(
    "/v1/operator/events/:eventId/tickets/:ticketId/answer",
    playerIdempotent,
    async (request, reply) => {
      const { eventId, ticketId } = parse(ticketParams, request.params);
      const body = parse(answerBody, request.body);
      const answered = valueOf(
        request,
        reply,
        await operatorAnswer(deps, playerIdOf(request), {
          eventId,
          ticketId,
          reply: body.reply ?? null,
          idempotencyKey: keyOf(request),
        }),
      );
      return logAnswer(request, answered, "operator");
    },
  );
}

/** The player's and the operator's help-desk routes. */
export function registerTicketRoutes(app: FastifyInstance, deps: Deps): void {
  registerTicketPlayerRoutes(app, deps);
  registerTicketOperatorRoutes(app, deps);
}

/** The dashboard's Help desk page, inside the organizer scope (owners and editors in their event limit). */
export function registerTicketTeamRoutes(scope: FastifyInstance, deps: TicketDeps): void {
  scope.get("/events/:eventId/tickets", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const query = parse(teamQuery, request.query);
    const page = valueOf(
      request,
      reply,
      await staffTickets(deps, organizerContextOf(request), {
        eventId,
        status: query.status,
        kind: query.kind ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
    return {
      tickets: page.tickets,
      nextCursor: page.tickets[query.limit - 1]?.id ?? null,
      counts: page.counts,
    };
  });

  scope.post(
    "/events/:eventId/tickets/:ticketId/answer",
    memberIdempotent,
    async (request, reply) => {
      const { eventId, ticketId } = parse(ticketParams, request.params);
      const body = parse(answerBody, request.body);
      const answered = valueOf(
        request,
        reply,
        await staffAnswer(deps, organizerContextOf(request), {
          eventId,
          ticketId,
          reply: body.reply ?? null,
          idempotencyKey: keyOf(request),
          requestId: request.id,
        }),
      );
      return logAnswer(request, answered, "staff");
    },
  );

  // Owners and editors only (operators have no door): the ticket moves whole to Questify's queue (FR-1823).
  scope.post(
    "/events/:eventId/tickets/:ticketId/escalate",
    memberIdempotent,
    async (request, reply) => {
      const { eventId, ticketId } = parse(ticketParams, request.params);
      const { note } = parse(noteBody, request.body);
      const escalated = valueOf(
        request,
        reply,
        await staffEscalate(deps, organizerContextOf(request), {
          eventId,
          ticketId,
          note,
          requestId: request.id,
        }),
      );
      request.log.info({ event: "ticket.escalated", replayed: escalated.replayed });
      return escalated;
    },
  );
}
