import { SUBMISSION_TEXT_MAX } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  abilityOff,
  alreadyCompleted,
  alreadyRemoved,
  alreadyReviewed,
  enrollmentInactive,
  guidelinesRequired,
  idempotencyKeyReused,
  notApprovable,
  notApproved,
  notFound,
  notOperator,
  notSubmissionQuest,
  openReservation,
  operatorPlayOff,
  outsideStation,
  questNotOpen,
  reasonRequired,
  removalClosed,
  resultsFinal,
  selfReview,
  submissionClosed,
  submissionPending,
  submissionText,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import type { Ranking } from "#src/ranking/ranking";
import {
  markSeen,
  operatorQueue,
  operatorReview,
  ownSubmissions,
  removeSubmission,
  sendSubmission,
  staffQueue,
  staffReview,
  type Done,
  type Reviewed,
  type ReviewOutcome,
  type SubmissionDeps,
  type SubmissionRefusal,
} from "#src/submissions/submissions";

const player = { config: { access: "player" }, bodyLimit: 8192 } as const;
const playerIdempotent = { ...player, config: { ...player.config, idempotent: true } } as const;
const member = { config: { access: "member" }, bodyLimit: 8192 } as const;
const memberIdempotent = { ...member, config: { ...member.config, idempotent: true } } as const;

const ID = /^[1-9][0-9]{0,17}$/;
const questParams = z.object({ questId: z.uuid() });
const eventParams = z.object({ eventId: z.uuid() });
const itemParams = z.object({ eventId: z.uuid(), submissionId: z.string().regex(ID) });
// The database cleans and measures the text (NFC, trimmed); this only bounds the body.
const sendBody = z.strictObject({ text: z.string().max(SUBMISSION_TEXT_MAX * 4) });
const reviewBody = z.union([
  z.strictObject({ decision: z.literal("approve") }),
  z.strictObject({ decision: z.literal("reject"), reason: z.string().max(1000) }),
]);
const removeBody = z.strictObject({ reason: z.string().max(1000) });
const seenBody = z.strictObject({ ids: z.array(z.string().regex(ID)).min(1).max(100) });
const queueQuery = z.strictObject({
  filter: z.enum(["pending", "unseen", "marked", "done"]).default("pending"),
  cursor: z.string().regex(ID).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const operatorQueueQuery = queueQuery.omit({ filter: true });

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

/** One HTTP answer per refusal (API.md, submissions). */
export function refuse(result: SubmissionRefusal): never {
  switch (result.kind) {
    case "not_found":
      throw notFound();
    case "enrollment_inactive":
      throw enrollmentInactive({ reason: result.reason });
    case "quest_not_open":
      throw questNotOpen({ reason: result.reason });
    case "operator_not_playing":
      throw operatorPlayOff();
    case "not_submission_quest":
      throw notSubmissionQuest();
    case "invalid_text":
      throw submissionText({ reason: result.reason });
    case "guidelines_required":
      throw guidelinesRequired();
    case "pending":
      throw submissionPending();
    case "closed":
      throw submissionClosed();
    case "already_completed":
      throw alreadyCompleted();
    case "key_reused":
      throw idempotencyKeyReused();
    case "already_reviewed":
      throw alreadyReviewed();
    case "not_approvable":
      throw notApprovable();
    case "results_final":
      throw resultsFinal();
    case "reason_required":
      throw reasonRequired();
    case "self_review":
      throw selfReview();
    case "not_operator":
      throw notOperator();
    case "ability_off":
      throw abilityOff();
    case "outside_station":
      throw outsideStation();
    case "not_approved":
      throw notApproved();
    case "already_removed":
      throw alreadyRemoved();
    case "open_reservation":
      throw openReservation();
    case "removal_closed":
      throw removalClosed();
  }
}

const valueOf = <T>(result: Done<T>): T => (result.kind === "done" ? result.value : refuse(result));

/** A full page's last id, where the next page starts; null after a short page. */
const nextCursor = (items: readonly { id: string }[], limit: number): string | null =>
  items[limit - 1]?.id ?? null;

const reasonOf = (body: z.infer<typeof reviewBody>): string | null =>
  // Stryker disable next-line ConditionalExpression: equivalent: an approval has no reason, and undefined reaches the database as null
  body.decision === "reject" ? body.reason : null;

type RankingDeps = Readonly<{ ranking: Ranking }>;

/** An approval moves the player's place like any completion; a ranking failure never fails the review. */
async function answerReview(deps: RankingDeps, result: Done<ReviewOutcome>): Promise<Reviewed> {
  const { reviewed, paid } = valueOf(result);
  if (paid !== null) {
    await deps.ranking.afterCompletion(paid.playerId, paid.completionId);
  }
  return reviewed;
}

/**
 * The player's side (FR-206, FR-327, FR-409, FR-1709) and the operator's review (FR-324, FR-325). Sending needs an
 * Idempotency-Key; an auto-approved submission moves the player's place like a completion.
 */
export function registerSubmissionPlayerRoutes(
  app: FastifyInstance,
  deps: SubmissionDeps & RankingDeps,
): void {
  app.post("/v1/quests/:questId/submit", playerIdempotent, async (request, reply) => {
    const { questId } = parse(questParams, request.params);
    const { text } = parse(sendBody, request.body);
    const playerId = playerIdOf(request);
    const sent = valueOf(
      await sendSubmission(deps, { playerId, questId, text, idempotencyKey: keyOf(request) }),
    );
    const rank =
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent: a pending send's null completion has no ranking entry, so the place is null either way
      sent.completionId === null
        ? null
        : await deps.ranking.afterCompletion(playerId, sent.completionId);
    return reply.code(sent.replayed ? 200 : 201).send({ ...sent, rank });
  });

  app.get("/v1/events/:eventId/submissions/mine", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    return ownSubmissions(deps, playerIdOf(request), eventId);
  });

  app.get("/v1/operator/events/:eventId/submissions", player, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const query = parse(operatorQueueQuery, request.query);
    const items = valueOf(
      await operatorQueue(deps, playerIdOf(request), {
        eventId,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
    return { submissions: items, nextCursor: nextCursor(items, query.limit) };
  });

  app.post(
    "/v1/operator/events/:eventId/submissions/:submissionId/review",
    playerIdempotent,
    async (request) => {
      const { eventId, submissionId } = parse(itemParams, request.params);
      const body = parse(reviewBody, request.body);
      return answerReview(
        deps,
        await operatorReview(deps, playerIdOf(request), {
          eventId,
          submissionId,
          decision: body.decision,
          reason: reasonOf(body),
          idempotencyKey: keyOf(request),
        }),
      );
    },
  );
}

/** The dashboard's queue, review, removal and seen marks, inside the organizer scope (owners and editors). */
export function registerSubmissionTeamRoutes(
  scope: FastifyInstance,
  deps: SubmissionDeps & RankingDeps,
): void {
  scope.get("/events/:eventId/submissions", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const query = parse(queueQuery, request.query);
    const items = valueOf(
      await staffQueue(deps, organizerContextOf(request), {
        eventId,
        filter: query.filter,
        cursor: query.cursor ?? null,
        limit: query.limit,
      }),
    );
    return { submissions: items, nextCursor: nextCursor(items, query.limit) };
  });

  scope.post(
    "/events/:eventId/submissions/:submissionId/review",
    memberIdempotent,
    async (request) => {
      const { eventId, submissionId } = parse(itemParams, request.params);
      const body = parse(reviewBody, request.body);
      return answerReview(
        deps,
        await staffReview(deps, organizerContextOf(request), {
          eventId,
          submissionId,
          decision: body.decision,
          reason: reasonOf(body),
          idempotencyKey: keyOf(request),
          requestId: request.id,
        }),
      );
    },
  );

  scope.post(
    "/events/:eventId/submissions/:submissionId/remove",
    memberIdempotent,
    async (request) => {
      const { eventId, submissionId } = parse(itemParams, request.params);
      const { reason } = parse(removeBody, request.body);
      return valueOf(
        await removeSubmission(deps, organizerContextOf(request), {
          eventId,
          submissionId,
          reason,
          idempotencyKey: keyOf(request),
          requestId: request.id,
        }),
      );
    },
  );

  scope.post("/events/:eventId/submissions/seen", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { ids } = parse(seenBody, request.body);
    return { marked: valueOf(await markSeen(deps, organizerContextOf(request), { eventId, ids })) };
  });
}
