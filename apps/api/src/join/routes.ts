import { MESSAGES, decodeCursor, encodeCursor, joinCard, parseLimit } from "@questify/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  cannotLeave,
  eventEnded,
  invalidRequest,
  joinCardStale,
  joinMethodOff,
  joinNotAllowed,
  membersOnly,
  notFound,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  findByCode,
  isThrottled,
  joinByCode,
  leaveEvent,
  listPublicEvents,
  myEvents,
  questsByCode,
  type JoinDeps,
} from "#src/join/join";

const CODE = /^[A-Za-z0-9]{4,12}$/;
const VERSION = z.string().regex(/^[0-9]+(\.[0-9]+){0,2}$/);

const codeParams = z.object({ joinCode: z.string() });
const eventParams = z.object({ eventId: z.uuid() });
const listQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.string().optional(),
});
const joinBody = z.strictObject({
  joinCode: z.string().max(12),
  via: z.enum(["code", "qr", "link", "public_list"]),
  // The join card's version the player was shown (FR-121): the consent kept with the enrollment.
  cardVersion: VERSION,
});

/** The join card in force, in both languages, as the app shows it before Join. */
export function cardInForce() {
  const card = joinCard();
  return {
    version: card.version,
    title: MESSAGES[card.title],
    receives: card.receives.map((key) => MESSAGES[key]),
  };
}

function throttled(reply: FastifyReply, retryAfterSeconds: number): never {
  reply.header("retry-after", String(retryAfterSeconds));
  throw tooManyAttempts({ retryAfterSeconds });
}

/** The code from the path, or 404 without a lookup: a malformed code can name no event. */
function codeOf(params: unknown): string {
  const { joinCode } = parse(codeParams, params);
  if (!CODE.test(joinCode)) {
    throw notFound();
  }
  return joinCode;
}

/** The list's cursor: the last event's id, opaque to the app. */
function afterIdOf(cursor: string | undefined): string | null {
  if (cursor === undefined) {
    return null;
  }
  try {
    const { id } = decodeCursor(cursor);
    return z.uuid().parse(id);
  } catch {
    throw invalidRequest();
  }
}

/**
 * Browsing before sign-in (FR-104, FR-105, FR-111): the public list, one event's join card by its code, and a public
 * or unlisted event's quests. Wrong codes count against the address; right ones cost nothing (T-111).
 */
function registerBrowseRoutes(app: FastifyInstance, deps: JoinDeps): void {
  app.get("/v1/public/events", { config: { access: "public" } }, async (request) => {
    const query = parse(listQuery, request.query);
    let limit: number;
    try {
      limit = parseLimit(query.limit);
    } catch {
      throw invalidRequest();
    }
    const events = await listPublicEvents(deps, afterIdOf(query.cursor), limit);
    const last = events.at(-1);
    return {
      events,
      nextCursor:
        events.length === limit && last !== undefined ? encodeCursor({ id: last.id }) : null,
    };
  });

  app.get(
    "/v1/public/events/:joinCode",
    { config: { access: "public" } },
    async (request, reply) => {
      const event = await findByCode(deps, request.ip, codeOf(request.params));
      if (isThrottled(event)) {
        return throttled(reply, event.retryAfterSeconds);
      }
      if (event === null) {
        throw notFound();
      }
      return { event, card: cardInForce() };
    },
  );

  app.get(
    "/v1/public/events/:joinCode/quests",
    { config: { access: "public" } },
    async (request, reply) => {
      const categories = await questsByCode(deps, request.ip, codeOf(request.params));
      if (isThrottled(categories)) {
        return throttled(reply, categories.retryAfterSeconds);
      }
      if (categories === null) {
        throw notFound();
      }
      if (categories === "private") {
        throw membersOnly();
      }
      return { categories };
    },
  );
}

/**
 * `POST /v1/join` (FR-101 to 105, FR-112, FR-121): a signed-in player joins by the event's code, sending how they came
 * and the join card's version they saw. Idempotent by its natural key: joining again answers the same enrollment.
 * `GET /v1/me/events` (FR-122): the player's events for the switcher.
 */
export function registerJoinRoutes(app: FastifyInstance, deps: JoinDeps): void {
  registerBrowseRoutes(app, deps);

  app.post(
    "/v1/join",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request, reply) => {
      const body = parse(joinBody, request.body);
      const player = request.player;
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (player === undefined) {
        throw unauthenticated();
      }
      if (body.cardVersion !== joinCard().version) {
        throw joinCardStale({ card: cardInForce() });
      }
      if (!CODE.test(body.joinCode)) {
        throw notFound();
      }
      const result = await joinByCode(deps, {
        playerId: player.id,
        address: request.ip,
        code: body.joinCode,
        via: body.via,
        cardVersion: body.cardVersion,
      });
      switch (result.kind) {
        case "throttled":
          return throttled(reply, result.retryAfterSeconds);
        case "not_found":
          throw notFound();
        case "ended":
          throw eventEnded();
        case "method_off":
          throw joinMethodOff();
        case "not_allowed":
          throw joinNotAllowed();
        case "joined":
        case "already":
          return {
            enrollmentId: result.enrollmentId,
            eventId: result.eventId,
            status: result.status,
            alreadyMember: result.kind === "already",
          };
      }
    },
  );

  // FR-1703: the app confirms first; the player stops playing and the event's pushes stop (push task: active only).
  app.post(
    "/v1/events/:eventId/leave",
    { config: { access: "player" } },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const player = request.player;
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (player === undefined) {
        throw unauthenticated();
      }
      switch (await leaveEvent(deps, player.id, eventId)) {
        case "left":
          return reply.code(204).send();
        case "not_found":
          throw notFound();
        case "cannot_leave":
          throw cannotLeave();
      }
    },
  );

  app.get("/v1/me/events", { config: { access: "player" } }, async (request) => {
    const player = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (player === undefined) {
      throw unauthenticated();
    }
    return { events: await myEvents(deps, player.id) };
  });
}
