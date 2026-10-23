import { decodeCursor, encodeCursor, parseLimit } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  abilityOff,
  alreadyCompleted,
  alreadyRemoved,
  enrollmentInactive,
  idempotencyKeyReused,
  invalidRequest,
  notFound,
  notOperator,
  notRemovable,
  openReservation,
  operatorPlayOff,
  outsideStation,
  overCap,
  ownerOnly,
  questNotOpen,
  reasonRequired,
  removalClosed,
  selfAward,
  tooManyAttempts,
  tooManyLines,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  awardForm,
  bulkAward,
  findPlayer,
  memberLedger,
  operatorAward,
  previewList,
  previewQuest,
  removeAward,
  report,
  setCaps,
  staffAward,
  type AwardDone,
  type AwardRefusal,
  type AwardWhat,
  type AwardsDeps,
  type PoolDeps,
} from "#src/awards/awards";
import { parseBulkLines } from "#src/awards/lines";
import { organizerContextOf } from "#src/organizers/context";
import { normalizeSaudiMobile } from "#src/players/phone";

const player = { config: { access: "player" }, bodyLimit: 2048 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
const member = { config: { access: "member" }, bodyLimit: 2048 } as const;
const memberIdempotent = { ...member, config: { ...member.config, idempotent: true } } as const;
const owner = { config: { access: "owner" }, bodyLimit: 1024 } as const;
/** A pasted list of 2000 lines, or 2000 member ids. */
const BULK_BODY_LIMIT = 128 * 1024;
const memberBulk = { config: { access: "member" }, bodyLimit: BULK_BODY_LIMIT } as const;
const memberBulkIdempotent = {
  ...memberBulk,
  config: { ...memberBulk.config, idempotent: true },
} as const;

const eventParams = z.object({ eventId: z.uuid() });
const playerParams = z.object({ eventId: z.uuid(), enrollmentId: z.uuid() });
const entryParams = z.object({
  eventId: z.uuid(),
  entryId: z.string().regex(/^[1-9][0-9]{0,17}$/),
});
const pageQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.string().optional(),
});
const points = z.number().int().min(1).max(100000);
const reason = z.string().max(1000);
const what = z.union([
  z.strictObject({ questId: z.uuid(), reason }),
  z.strictObject({ points, reason }),
]);
const operatorAwardBody = z.union([
  z.strictObject({ eventId: z.uuid(), enrollmentId: z.uuid(), questId: z.uuid(), reason }),
  z.strictObject({ eventId: z.uuid(), enrollmentId: z.uuid(), points, reason }),
]);
const findBody = z.strictObject({ query: z.string().trim().min(1).max(40) });
const removeBody = z.strictObject({ reason });
const previewBody = z.union([
  z.strictObject({ lines: z.string().max(BULK_BODY_LIMIT) }),
  z.strictObject({ questId: z.uuid() }),
]);
const bulkBody = z.union([
  z.strictObject({ enrollmentIds: z.array(z.uuid()).min(1).max(2000), points, reason }),
  z.strictObject({ questId: z.uuid(), points, reason }),
]);
const capsBody = z
  .strictObject({
    each: z.number().int().min(1).max(100000),
    day: z.number().int().min(1).max(1000000),
  })
  .refine((caps) => caps.day >= caps.each);

const whatOf = (body: { questId?: string; points?: number }): AwardWhat =>
  body.questId === undefined
    ? { questId: null, points: body.points ?? 0 }
    : { questId: body.questId, points: null };

const playerIdOf = (request: FastifyRequest): string => {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
  if (request.player === undefined) {
    throw unauthenticated();
  }
  return request.player.id;
};

const keyOf = (request: FastifyRequest): string => {
  const key = request.headers["idempotency-key"];
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the idempotency convention answers first
  if (typeof key !== "string") {
    throw unauthenticated();
  }
  return key;
};

function pageOf(query: z.infer<typeof pageQuery>): { beforeId: string | null; limit: number } {
  try {
    const beforeId =
      query.cursor === undefined
        ? null
        : z
            .string()
            .regex(/^[1-9][0-9]{0,17}$/)
            .parse(decodeCursor(query.cursor)["id"]);
    return { beforeId, limit: parseLimit(query.limit) };
  } catch {
    throw invalidRequest();
  }
}

const nextCursor = (lines: readonly { id: string }[], limit: number): string | null => {
  const last = lines.at(-1);
  return lines.length === limit && last !== undefined ? encodeCursor({ id: last.id }) : null;
};

/** One HTTP answer per refusal (API.md, manual awards). */
export function refuse(result: AwardRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "not_operator":
      throw notOperator();
    case "ability_off":
      throw abilityOff();
    case "outside_station":
      throw outsideStation();
    case "self_award":
      throw selfAward();
    case "enrollment_inactive":
      throw enrollmentInactive({ reason: result.reason });
    case "quest_not_open":
      throw questNotOpen({ reason: result.reason });
    case "already_completed":
      throw alreadyCompleted();
    case "operator_not_playing":
      throw operatorPlayOff();
    case "over_cap":
      throw overCap({ cap: result.cap, limit: result.limit, left: result.left });
    case "reason_required":
      throw reasonRequired();
    case "invalid_amount":
      throw invalidRequest();
    case "key_reused":
      throw idempotencyKeyReused();
    case "already_removed":
      throw alreadyRemoved();
    case "open_reservation":
      throw openReservation();
    case "not_removable":
      throw notRemovable();
    case "removal_closed":
      throw removalClosed();
    case "too_many_lines":
      throw tooManyLines();
  }
}

const valueOf = <T>(result: AwardDone<T>): T =>
  result.kind === "done" ? result.value : refuse(result);

/** Manual awards in operator mode (FR-308 to FR-310): find a member, the form, the award. */
export function registerOperatorAwardRoutes(app: FastifyInstance, deps: AwardsDeps): void {
  app.post(
    "/v1/operator/events/:eventId/find-player",
    player,
    async (request, reply: FastifyReply) => {
      const { eventId } = parse(eventParams, request.params);
      const { query } = parse(findBody, request.body);
      const phone = normalizeSaudiMobile(query) ?? null;
      const result = await findPlayer(deps, playerIdOf(request), {
        eventId,
        username: phone === null ? query.replace(/^@/, "") : null,
        phone,
      });
      if (result.kind === "throttled") {
        reply.header("retry-after", String(result.retryAfterSeconds));
        throw tooManyAttempts();
      }
      return { player: valueOf(result) };
    },
  );

  app.get("/v1/operator/events/:eventId/award", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return valueOf(await awardForm(deps, playerIdOf(request), eventId));
  });

  app.post("/v1/operator/award", playerIdempotent, async (request) => {
    const body = parse(operatorAwardBody, request.body);
    const done = valueOf(
      await operatorAward(deps, playerIdOf(request), {
        eventId: body.eventId,
        enrollmentId: body.enrollmentId,
        what: whatOf(body),
        reason: body.reason,
        idempotencyKey: keyOf(request),
      }),
    );
    return { points: done.points, replayed: done.replayed };
  });
}

/**
 * Manual awards on the dashboard (FR-311, FR-320, FR-1027, FR-1712), inside the organizer scope: owners and editors
 * award, remove and bulk-award; the owner sets the caps. The database checks the membership, the event limit, the
 * role and the caps again.
 */
export function registerAwardRoutes(scope: FastifyInstance, deps: PoolDeps): void {
  scope.get("/events/:eventId/players/:enrollmentId/entries", member, async (request) => {
    const { eventId, enrollmentId } = parse(playerParams, request.params);
    const { beforeId, limit } = pageOf(parse(pageQuery, request.query));
    const entries = valueOf(
      await memberLedger(deps, organizerContextOf(request), {
        eventId,
        enrollmentId,
        beforeId,
        limit,
      }),
    );
    return { entries, nextCursor: nextCursor(entries, limit) };
  });

  scope.post(
    "/events/:eventId/players/:enrollmentId/awards",
    memberIdempotent,
    async (request, reply) => {
      const { eventId, enrollmentId } = parse(playerParams, request.params);
      const body = parse(what, request.body);
      const done = valueOf(
        await staffAward(deps, organizerContextOf(request), {
          eventId,
          enrollmentId,
          what: whatOf(body),
          reason: body.reason,
          idempotencyKey: keyOf(request),
          requestId: request.id,
        }),
      );
      return reply.code(201).send(done);
    },
  );

  scope.post("/events/:eventId/entries/:entryId/remove", memberIdempotent, async (request) => {
    const { eventId, entryId } = parse(entryParams, request.params);
    const body = parse(removeBody, request.body);
    return valueOf(
      await removeAward(deps, organizerContextOf(request), {
        eventId,
        entryId,
        reason: body.reason,
        idempotencyKey: keyOf(request),
        requestId: request.id,
      }),
    );
  });

  scope.get("/events/:eventId/awards", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { beforeId, limit } = pageOf(parse(pageQuery, request.query));
    const done = valueOf(
      await report(deps, organizerContextOf(request), { eventId, beforeId, limit }),
    );
    return { caps: done.caps, awards: done.lines, nextCursor: nextCursor(done.lines, limit) };
  });

  scope.put("/events/:eventId/award-caps", owner, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const caps = parse(capsBody, request.body);
    const outcome = valueOf(
      await setCaps(deps, organizerContextOf(request), { eventId, ...caps, requestId: request.id }),
    );
    // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: unreachable: the scope's hook refuses an editor first
    if (outcome === "not_owner") {
      throw ownerOnly();
    }
    return caps;
  });

  scope.post("/events/:eventId/bulk-awards/preview", memberBulk, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(previewBody, request.body);
    const context = organizerContextOf(request);
    if ("questId" in body) {
      return {
        count: valueOf(await previewQuest(deps, context, { eventId, questId: body.questId })),
      };
    }
    const lines = parseBulkLines(body.lines);
    if (lines === "too_many") {
      throw tooManyLines();
    }
    const preview = valueOf(await previewList(deps, context, { eventId, lines }));
    return { ...preview, count: preview.matched.length };
  });

  scope.post("/events/:eventId/bulk-awards", memberBulkIdempotent, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(bulkBody, request.body);
    const done = valueOf(
      await bulkAward(deps, organizerContextOf(request), {
        eventId,
        target:
          "questId" in body
            ? { enrollmentIds: null, questId: body.questId }
            : { enrollmentIds: body.enrollmentIds, questId: null },
        points: body.points,
        reason: body.reason,
        idempotencyKey: keyOf(request),
        requestId: request.id,
      }),
    );
    return reply.code(201).send(done);
  });
}
