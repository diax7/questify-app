import { MESSAGES, decodeCursor, encodeCursor, joinCard, parseLimit } from "@questify/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  cannotLeave,
  eventEnded,
  eventFull,
  joinDeclined,
  invalidJoinAnswers,
  invalidRequest,
  joinCardStale,
  joinDomainRequired,
  joinInviteOnly,
  joinMethodOff,
  joinNotAllowed,
  membersOnly,
  notFound,
  rehearsing,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  findByCode,
  isThrottled,
  joinByCode,
  joinInvited,
  leaveEvent,
  listPublicEvents,
  myEvents,
  myInvitations,
  questsByCode,
  rulesByCode,
  type JoinAnswers,
  type JoinDeps,
  type JoinOutcome,
} from "#src/join/join";
import type { SettingsService } from "#src/settings/service";

/** The join routes' dependencies: the settings hide a switched-off quest type from the public quest list (T-303). */
type BrowseDeps = JoinDeps & Readonly<{ settings: SettingsService }>;

type Throttled = Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

const CODE = /^[A-Za-z0-9]{4,12}$/;
const VERSION = z.string().regex(/^[0-9]+(\.[0-9]+){0,2}$/);

const codeParams = z.object({ joinCode: z.string() });
const eventParams = z.object({ eventId: z.uuid() });
const listQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.string().optional(),
});
/** At most one answer per field, and an event has at most five (migration 0028). */
const MAX_ANSWERS = 5;
const joinBody = z.strictObject({
  // A code for every way in but an invitation, which names the event instead (FR-133).
  joinCode: z.string().max(12).optional(),
  eventId: z.uuid().optional(),
  via: z.enum(["code", "qr", "link", "public_list", "invite"]),
  // The join card's version the player was shown (FR-121): the consent kept with the enrollment.
  cardVersion: VERSION,
  answers: z
    .record(z.uuid(), z.string().max(400))
    .refine((answers) => Object.keys(answers).length <= MAX_ANSWERS)
    .optional(),
  // FR-1821: join the waiting list of a full event (asked after an `event_full` answer).
  waitlist: z.boolean().optional(),
});

/** The join card in force, in both languages, as the app shows it before Join; with the answers when asked. */
export function cardInForce(withAnswers = false) {
  const card = joinCard(withAnswers);
  return {
    version: card.version,
    title: MESSAGES[card.title],
    receives: card.receives.map((key) => MESSAGES[key]),
  };
}

/** Trims each answer and leaves out the blank ones: an optional field left empty is not answered (FR-130). */
export function cleanAnswers(raw: Readonly<Record<string, string>> | undefined): JoinAnswers {
  return Object.fromEntries(
    Object.entries(raw ?? {})
      .map(([field, value]) => [field, value.normalize("NFC").trim()] as const)
      .filter(([, value]) => value !== ""),
  );
}

/** Maps a join's outcome to its answer, or to the refusal it is. */
function joinAnswer(result: JoinOutcome | Throttled, reply: FastifyReply) {
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
    case "invite_only":
      throw joinInviteOnly();
    case "domain_required":
      throw joinDomainRequired(result.domains);
    case "invalid_answers":
      throw invalidJoinAnswers({ field: result.field });
    case "full":
      // The app offers the waiting list (FR-1821): the same join with `waitlist: true`.
      throw eventFull({ waitlist: true });
    case "declined":
      throw joinDeclined();
    case "rehearsing":
      throw rehearsing();
    case "joined":
    case "already":
      return {
        enrollmentId: result.enrollmentId,
        eventId: result.eventId,
        status: result.status,
        alreadyMember: result.kind === "already",
        welcome: result.welcome,
        waitlisted: result.waitlisted,
      };
  }
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
function registerBrowseRoutes(app: FastifyInstance, deps: BrowseDeps): void {
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
      return { event, card: cardInForce(event.join.fields.length > 0) };
    },
  );

  app.get(
    "/v1/public/events/:joinCode/rules",
    { config: { access: "public" } },
    async (request, reply) => {
      const found = await rulesByCode(deps, request.ip, codeOf(request.params));
      if (isThrottled(found)) {
        return throttled(reply, found.retryAfterSeconds);
      }
      if (found === null || found.rules === null) {
        throw notFound();
      }
      return { rules: found.rules };
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
export function registerJoinRoutes(app: FastifyInstance, deps: BrowseDeps): void {
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
      const answers = cleanAnswers(body.answers);
      if (body.via === "invite") {
        if (body.eventId === undefined || body.joinCode !== undefined) {
          throw invalidRequest();
        }
        const invited = await joinInvited(deps, {
          playerId: player.id,
          eventId: body.eventId,
          cardVersion: body.cardVersion,
          answers,
          waitlist: body.waitlist ?? false,
        });
        return joinAnswer(invited, reply);
      }
      if (body.joinCode === undefined || body.eventId !== undefined) {
        throw invalidRequest();
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
        answers,
        waitlist: body.waitlist ?? false,
      });
      return joinAnswer(result, reply);
    },
  );

  // FR-133: the events whose guest list holds one of the player's verified identifiers, each with its card.
  app.get("/v1/me/invitations", { config: { access: "player" } }, async (request) => {
    const player = request.player;
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (player === undefined) {
      throw unauthenticated();
    }
    const invitations = await myInvitations(deps, player.id);
    return {
      invitations: invitations.map((invitation) => ({
        event: invitation,
        card: cardInForce(invitation.join.fields.length > 0),
      })),
    };
  });

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
