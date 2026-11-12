import { SUBMISSION_TEXT_MAX } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { refusalThrower } from "#src/refusal-table";
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
  photoNotAccepted,
  photoRequired,
  photoUnusable,
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
import { logStreakBonus } from "#src/streaks/streaks";
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
// The database cleans and measures the text (NFC, trimmed); this only bounds the body. Text, a photo from the photo
// door (T-301b), or both: a photo's text is its caption.
const sendBody = z
  .strictObject({
    text: z
      .string()
      .max(SUBMISSION_TEXT_MAX * 4)
      .optional(),
    photoId: z.uuid().optional(),
    // T-504b: the player allows this photo on the big screen and the event's photo wall; absent (an older app) is no.
    onScreen: z.boolean().optional(),
  })
  .refine((body) => body.text !== undefined || body.photoId !== undefined);
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

const refuseSubmission = refusalThrower<SubmissionRefusal>({
  not_found: () => notFound(),
  enrollment_inactive: (result) => enrollmentInactive({ reason: result.reason }),
  quest_not_open: (result) => questNotOpen({ reason: result.reason }),
  operator_not_playing: () => operatorPlayOff(),
  not_submission_quest: () => notSubmissionQuest(),
  invalid_text: (result) => submissionText({ reason: result.reason }),
  guidelines_required: () => guidelinesRequired(),
  pending: () => submissionPending(),
  closed: () => submissionClosed(),
  already_completed: () => alreadyCompleted(),
  key_reused: () => idempotencyKeyReused(),
  already_reviewed: () => alreadyReviewed(),
  not_approvable: () => notApprovable(),
  results_final: () => resultsFinal(),
  reason_required: () => reasonRequired(),
  self_review: () => selfReview(),
  not_operator: () => notOperator(),
  ability_off: () => abilityOff(),
  outside_station: () => outsideStation(),
  not_approved: () => notApproved(),
  already_removed: () => alreadyRemoved(),
  open_reservation: () => openReservation(),
  removal_closed: () => removalClosed(),
  photo_unusable: () => photoUnusable(),
  photo_required: () => photoRequired(),
  photo_not_accepted: () => photoNotAccepted(),
});

/** One HTTP answer per refusal (API.md, submissions). */
export function refuse(result: SubmissionRefusal): never {
  return refuseSubmission(result);
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
    const body = parse(sendBody, request.body);
    const playerId = playerIdOf(request);
    const sent = valueOf(
      await sendSubmission(deps, {
        playerId,
        questId,
        text: body.text ?? null,
        photoId: body.photoId ?? null,
        onScreen: body.onScreen === true,
        idempotencyKey: keyOf(request),
      }),
    );
    logStreakBonus(request.log, sent);
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

  app.get("/v1/operator/events/:eventId/submissions", player, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    // The rows carry signed photo URLs: never kept by a cache (the dashboard's scope already sends no-store).
    reply.header("cache-control", "no-store");
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
