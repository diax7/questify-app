import type { Pool, PoolClient } from "pg";
import { playerDocuments, type StreakBonus } from "@questify/shared";
import { removedItemOf, type RemovedItem } from "#src/awards/awards";
import {
  boostApplied,
  bonusPaid,
  itemGiven,
  levelReached,
  type Boosted,
  type Bonus,
  type ItemGiven,
  type LevelUp,
} from "#src/completions/complete";
import { readInForce } from "#src/legal/in-force";
import { firstBonusPaid, type OwnFirstBonus } from "#src/quests/first-bonus";
import { streakBonusPaid } from "#src/streaks/streaks";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";
import type { ObjectStore } from "#src/storage/client";
import { signedPhoto } from "#src/storage/signed";
import { wallOn } from "#src/screen/photo-wall";

/** The pool, and the photo bucket when this server has one (T-301b): queue rows with a photo get a short signed URL. */
export type SubmissionDeps = Readonly<{ pool: Pool; storage?: ObjectStore | undefined }>;

/** Why a submission, a review or a removal was refused; each maps to one HTTP answer in the routes. */
export type SubmissionRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "enrollment_inactive"; reason: string }>
  | Readonly<{ kind: "quest_not_open"; reason: string }>
  | Readonly<{ kind: "operator_not_playing" }>
  | Readonly<{ kind: "not_submission_quest" }>
  | Readonly<{ kind: "invalid_text"; reason: string }>
  | Readonly<{ kind: "guidelines_required" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "key_reused" }>
  | Readonly<{ kind: "already_reviewed" }>
  | Readonly<{ kind: "not_approvable" }>
  | Readonly<{ kind: "results_final" }>
  | Readonly<{ kind: "reason_required" }>
  | Readonly<{ kind: "self_review" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "ability_off" }>
  | Readonly<{ kind: "outside_station" }>
  | Readonly<{ kind: "not_approved" }>
  | Readonly<{ kind: "already_removed" }>
  | Readonly<{ kind: "open_reservation" }>
  | Readonly<{ kind: "removal_closed" }>
  | Readonly<{ kind: "photo_unusable" }>
  | Readonly<{ kind: "photo_required" }>
  | Readonly<{ kind: "photo_not_accepted" }>;

export type Done<T> = Readonly<{ kind: "done"; value: T }> | SubmissionRefusal;

/** The SQLSTATEs of migration 0040's definers (and remove_award under remove_submission). */
const REFUSALS: Readonly<Record<string, (detail: string) => SubmissionRefusal>> = {
  QC404: () => ({ kind: "not_found" }),
  SN404: () => ({ kind: "not_found" }),
  AN404: () => ({ kind: "not_found" }),
  AE404: () => ({ kind: "not_found" }),
  QC403: (detail) => ({ kind: "enrollment_inactive", reason: detail }),
  QN403: (detail) => ({ kind: "quest_not_open", reason: detail }),
  QP403: () => ({ kind: "operator_not_playing" }),
  SQ422: () => ({ kind: "not_submission_quest" }),
  SV422: (detail) => ({ kind: "invalid_text", reason: detail }),
  SG403: () => ({ kind: "guidelines_required" }),
  SP409: () => ({ kind: "pending" }),
  QD409: (detail) => (detail === "closed" ? { kind: "closed" } : { kind: "already_completed" }),
  QK422: () => ({ kind: "key_reused" }),
  SK422: () => ({ kind: "key_reused" }),
  AK422: () => ({ kind: "key_reused" }),
  SR409: (detail) =>
    detail === "removed" ? { kind: "already_removed" } : { kind: "already_reviewed" },
  SE409: () => ({ kind: "not_approvable" }),
  RF409: () => ({ kind: "results_final" }),
  AR400: () => ({ kind: "reason_required" }),
  SS403: () => ({ kind: "self_review" }),
  OP403: () => ({ kind: "not_operator" }),
  OA403: () => ({ kind: "ability_off" }),
  OS403: () => ({ kind: "outside_station" }),
  AD409: () => ({ kind: "already_removed" }),
  AO409: () => ({ kind: "open_reservation" }),
  AS409: () => ({ kind: "removal_closed" }),
  // The photo (migration 0193): not the caller's stored, unused upload of this event, or not the kind the quest takes.
  SM404: () => ({ kind: "photo_unusable" }),
  SM422: (detail) =>
    detail === "photo_required" ? { kind: "photo_required" } : { kind: "photo_not_accepted" },
};

/** Runs one call in `context`; a refusal the database raises becomes its result, anything else is thrown. */
async function run<T>(
  deps: SubmissionDeps,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<Done<T>> {
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = REFUSALS[String(pg.code)];
    if (refusal === undefined) {
      throw error;
    }
    return refusal(pg.detail ?? "");
  }
}

const staffSeat = (context: OrganizerContext): RequestContext => teamSeat(context);

/** The community guidelines version in force: a first submission needs it accepted (FR-1706). */
async function guidelinesVersion(client: PoolClient): Promise<string> {
  const found = playerDocuments(await readInForce(client)).find(
    (document) => document.id === "community_guidelines",
  );
  // Stryker disable next-line ConditionalExpression,BlockStatement: the migration seeds the guidelines and versions only add
  if (found === undefined) {
    throw new Error("The community guidelines have no version in force.");
  }
  return found.version;
}

export type Sent = Readonly<{
  submissionId: string;
  status: "pending" | "approved";
  points: number;
  /** Set when the quest approves at once (auto-approve): the completion that paid it. */
  completionId: string | null;
  score: number;
  balance: number;
  replayed: boolean;
  levelUp: LevelUp | null;
  /** The category bonus an auto-approved send paid (T-304), or null. */
  bonus: Bonus | null;
  /** The quest item an auto-approved send gave or missed (T-304d), or null. */
  item: ItemGiven | null;
  /** The boost that doubled an auto-approved send (T-307), or null; `points` is then what it paid. */
  boost: Boosted | null;
  /** The first-N bonus an auto-approved send earned, or missed when `place` is null (T-313). */
  firstBonus: OwnFirstBonus | null;
  /** The event streak bonus an auto-approved send paid with its streak day (T-405), or null. */
  streakBonus: StreakBonus | null;
}>;

type SentRow = {
  submission_id: string;
  status: "pending" | "approved";
  points: number;
  completion_id: string | null;
  score: string;
  balance: string;
  replayed: boolean;
};

type PaidExtras = Pick<Sent, "levelUp" | "bonus" | "item" | "boost" | "firstBonus" | "streakBonus">;

/** What an auto-approved send's completion earned besides its points, read in this order; all null when pending. */
async function paidExtras(
  client: PoolClient,
  completionId: string | null,
  boost: Boosted | null,
): Promise<PaidExtras> {
  if (completionId === null) {
    return { levelUp: null, bonus: null, item: null, boost, firstBonus: null, streakBonus: null };
  }
  return {
    levelUp: await levelReached(client, completionId),
    bonus: await bonusPaid(client, completionId),
    item: await itemGiven(client, completionId),
    boost,
    firstBonus: await firstBonusPaid(client, completionId),
    streakBonus: await streakBonusPaid(client, completionId),
  };
}

/**
 * The player sends text, a photo (an id from the photo door), or a photo with a caption for a submission quest (FR-204,
 * FR-206, FR-327): pending until reviewed, or paid at once on an auto-approve quest. `submit_quest` checks every rule
 * (migrations 0040, 0193).
 */
export function sendSubmission(
  deps: SubmissionDeps,
  request: Readonly<{
    playerId: string;
    questId: string;
    text: string | null;
    photoId: string | null;
    onScreen: boolean;
    idempotencyKey: string;
  }>,
): Promise<Done<Sent>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<SentRow>(
      "SELECT * FROM submit_quest($1, $2, $3, $4, $5, $6)",
      [
        request.questId,
        request.text,
        await guidelinesVersion(client),
        request.idempotencyKey,
        request.photoId,
        request.onScreen,
      ],
    );
    const row = rows[0] as SentRow;
    const boost = row.completion_id === null ? null : await boostApplied(client, row.completion_id);
    return {
      submissionId: row.submission_id,
      status: row.status,
      points: row.points * (boost?.multiplier ?? 1),
      completionId: row.completion_id,
      score: Number(row.score),
      balance: Number(row.balance),
      replayed: row.replayed,
      ...(await paidExtras(client, row.completion_id, boost)),
    };
  });
}

export type SubmissionKind = "text" | "photo";

export type OwnSubmission = Readonly<{
  id: string;
  questId: string;
  status: "pending" | "approved" | "rejected" | "removed";
  points: number;
  kind: SubmissionKind;
  /** A photo submission's caption, or a text submission's text. */
  text: string | null;
  /** The photo was deleted (a rejection, a removal, the retention purge): the history says so. */
  photoGone: boolean;
  /** The player allows this photo on the big screen and the event's photo wall (T-504b); false for text. */
  onScreen: boolean;
  /** The reviewer's words, or a code when the system closed it (`left_event`). */
  reason: string | null;
  reasonSystem: boolean;
  /** The quest takes another submission after a rejection (FR-1709). */
  resubmit: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
}>;

type OwnRow = {
  id: string;
  quest_id: string;
  status: OwnSubmission["status"];
  points: number;
  body: string | null;
  reason: string | null;
  reason_system: boolean;
  resubmit: boolean;
  created_at: Date;
  reviewed_at: Date | null;
  kind: SubmissionKind;
  photo_gone: boolean;
  on_screen: boolean;
};

/** The points all of the calling player's pending submissions in an event will pay (FR-409). */
export async function readPendingPoints(client: PoolClient, eventId: string): Promise<number> {
  const { rows } = await client.query<{ points: string }>(
    "SELECT own_pending_points($1) AS points",
    [eventId],
  );
  return Number(rows[0]?.points ?? 0);
}

/** The calling player's own submissions in an event, newest first (FR-205: never anyone else's). */
export async function readOwnSubmissions(
  client: PoolClient,
  eventId: string,
): Promise<OwnSubmission[]> {
  const { rows } = await client.query<OwnRow>("SELECT * FROM own_submissions($1)", [eventId]);
  return rows.map((row) => ({
    id: row.id,
    questId: row.quest_id,
    status: row.status,
    points: row.points,
    kind: row.kind,
    text: row.body,
    photoGone: row.photo_gone,
    onScreen: row.on_screen,
    reason: row.reason,
    reasonSystem: row.reason_system,
    resubmit: row.resubmit,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  }));
}

/** The player's own submissions (at most 200, newest first) and the points all their pending ones will pay. */
export function ownSubmissions(
  deps: SubmissionDeps,
  playerId: string,
  eventId: string,
): Promise<Readonly<{ submissions: OwnSubmission[]; pendingPoints: number; photoWall: boolean }>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => ({
      submissions: await readOwnSubmissions(client, eventId),
      pendingPoints: await readPendingPoints(client, eventId),
      // T-504b: the send form offers "show on screen" only while the event's wall runs (never without a bucket).
      photoWall: await wallOn(deps, client, eventId),
    })),
  );
}

export type QueueFilter = "pending" | "unseen" | "marked" | "done";

export type QueueItem = Readonly<{
  id: string;
  questId: string;
  questTitle: Readonly<{ ar: string | null; en: string | null }>;
  enrollmentId: string;
  /** Null for a deleted account. */
  username: string | null;
  avatar: string;
  kind: SubmissionKind;
  /** Null once the account is deleted, and for a photo sent without a caption. */
  text: string | null;
  /** A signed read of the photo on the bucket's host, for 5 minutes; null without a photo (or once it is gone). */
  photoUrl: string | null;
  photoExpiresAt: Date | null;
  photoGone: boolean;
  /** The player allowed this photo on the event's screen (T-504b); false for text. */
  onScreen: boolean;
  points: number;
  status: OwnSubmission["status"];
  auto: boolean;
  marked: boolean;
  reason: string | null;
  reasonSystem: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
  seenAt: Date | null;
}>;

type QueueRow = {
  id: string;
  quest_id: string;
  quest_title_ar: string | null;
  quest_title_en: string | null;
  enrollment_id: string;
  username: string | null;
  avatar: string;
  body: string | null;
  points: number;
  status: OwnSubmission["status"];
  auto: boolean;
  marked: boolean;
  reason: string | null;
  reason_system: boolean;
  created_at: Date;
  reviewed_at: Date | null;
  seen_at: Date | null;
  kind: SubmissionKind;
  photo_key: string | null;
  photo_gone: boolean;
  on_screen: boolean;
};

/** One queue row; its photo URL is signed here, only for the key the seat-checked reader returned. */
const itemOf = async (deps: SubmissionDeps, row: QueueRow): Promise<QueueItem> => ({
  id: row.id,
  questId: row.quest_id,
  questTitle: { ar: row.quest_title_ar, en: row.quest_title_en },
  enrollmentId: row.enrollment_id,
  username: row.username,
  avatar: row.avatar,
  kind: row.kind,
  text: row.body,
  ...(await signedPhoto(deps.storage, row.photo_key)),
  photoGone: row.photo_gone,
  onScreen: row.on_screen,
  points: row.points,
  status: row.status,
  auto: row.auto,
  marked: row.marked,
  reason: row.reason,
  reasonSystem: row.reason_system,
  createdAt: row.created_at,
  reviewedAt: row.reviewed_at,
  seenAt: row.seen_at,
});

export type Page = Readonly<{ cursor: string | null; limit: number }>;

/** The team's review queue (FR-324): owners and editors in the event's scope. */
export function staffQueue(
  deps: SubmissionDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; filter: QueueFilter }> & Page,
): Promise<Done<QueueItem[]>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<QueueRow>(
      "SELECT * FROM event_submissions($1, $2, $3, $4)",
      [request.eventId, request.filter, request.cursor, request.limit],
    );
    return Promise.all(rows.map((row) => itemOf(deps, row)));
  });
}

/** The operator's queue in the app: pending only, inside their quests, never their own. */
export function operatorQueue(
  deps: SubmissionDeps,
  playerId: string,
  request: Readonly<{ eventId: string }> & Page,
): Promise<Done<QueueItem[]>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<QueueRow>(
      "SELECT * FROM operator_submissions($1, $2, $3)",
      [request.eventId, request.cursor, request.limit],
    );
    return Promise.all(rows.map((row) => itemOf(deps, row)));
  });
}

export type ReviewRequest = Readonly<{
  eventId: string;
  submissionId: string;
  decision: "approve" | "reject";
  reason: string | null;
  idempotencyKey: string;
}>;

export type Reviewed = Readonly<{
  submissionId: string;
  status: OwnSubmission["status"];
  points: number;
  replayed: boolean;
}>;

/** A review's answer, with the completion an approval paid and its player (for the ranking; never sent out). */
export type ReviewOutcome = Readonly<{
  reviewed: Reviewed;
  paid: Readonly<{ playerId: string; completionId: string }> | null;
}>;

type ReviewedRow = {
  submission_id: string;
  status: Reviewed["status"];
  points: number;
  replayed: boolean;
  completion_id: string | null;
  player_id: string;
};

const reviewedOf = (rows: readonly ReviewedRow[]): ReviewOutcome => {
  const row = rows[0] as ReviewedRow;
  return {
    reviewed: {
      submissionId: row.submission_id,
      status: row.status,
      points: row.points,
      replayed: row.replayed,
    },
    paid:
      row.completion_id === null
        ? null
        : { playerId: row.player_id, completionId: row.completion_id },
  };
};

/** Approve, or reject with a reason, from the dashboard (FR-325). Audited by the database. */
export function staffReview(
  deps: SubmissionDeps,
  context: OrganizerContext,
  request: ReviewRequest & Readonly<{ requestId: string }>,
): Promise<Done<ReviewOutcome>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<ReviewedRow>(
      "SELECT * FROM staff_review_submission($1, $2, $3, $4, $5, $6)",
      [
        request.eventId,
        request.submissionId,
        request.decision,
        request.reason,
        request.idempotencyKey,
        request.requestId,
      ],
    );
    return reviewedOf(rows);
  });
}

/** Approve, or reject with a reason, as an operator with the review ability (FR-324). */
export function operatorReview(
  deps: SubmissionDeps,
  playerId: string,
  request: ReviewRequest,
): Promise<Done<ReviewOutcome>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<ReviewedRow>(
      "SELECT * FROM operator_review_submission($1, $2, $3, $4, $5)",
      [
        request.eventId,
        request.submissionId,
        request.decision,
        request.reason,
        request.idempotencyKey,
      ],
    );
    return reviewedOf(rows);
  });
}

export type Removed = Readonly<{
  entryId: string;
  scoreDelta: number;
  balanceDelta: number;
  replayed: boolean;
  /** The credit's quest item (T-304d): cancelled by this removal, handed over already (it stays), or null. */
  item: RemovedItem;
}>;

/** Removes an approved submission's points (FR-328) through the one removal path, remove_award. */
export function removeSubmission(
  deps: SubmissionDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    submissionId: string;
    reason: string;
    idempotencyKey: string;
    requestId: string;
  }>,
): Promise<Done<Removed>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT * FROM remove_submission($1, $2, $3, $4, $5)",
      [
        request.eventId,
        request.submissionId,
        request.reason,
        request.idempotencyKey,
        request.requestId,
      ],
    );
    const row = rows[0] ?? {};
    return {
      entryId: String(row["entry_id"]),
      scoreDelta: Number(row["score_delta"]),
      balanceDelta: Number(row["balance_delta"]),
      replayed: row["replayed"] === true,
      item: removedItemOf(row["item"]),
    };
  });
}

/** Marks auto-approved items as seen by the team (ADR-187); answers how many were newly marked. */
export function markSeen(
  deps: SubmissionDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; ids: readonly string[] }>,
): Promise<Done<number>> {
  return run(deps, staffSeat(context), async (client) => {
    const { rows } = await client.query<{ marked: number }>(
      "SELECT mark_submissions_seen($1, $2::bigint[]) AS marked",
      [request.eventId, request.ids],
    );
    return rows[0]?.marked ?? 0;
  });
}
