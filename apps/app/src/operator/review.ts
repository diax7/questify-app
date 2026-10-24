import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

/** One pending submission in the operator's queue (`GET /v1/operator/events/{id}/submissions`, T-301). */
export type ReviewItem = Readonly<{
  id: string;
  questTitle: Bilingual;
  username: string | null;
  avatar: string;
  text: string | null;
  points: number;
  /** A word-list hit (FR-1628): read it carefully. */
  marked: boolean;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nullableText = (value: unknown) => value === null || typeof value === "string";

const isItem = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isRecord(value["questTitle"]) &&
  nullableText(value["questTitle"]["ar"]) &&
  nullableText(value["questTitle"]["en"]) &&
  nullableText(value["username"]) &&
  typeof value["avatar"] === "string" &&
  nullableText(value["text"]) &&
  typeof value["points"] === "number" &&
  typeof value["marked"] === "boolean";

/** Reads the queue; anything malformed reads as nothing, so the screen shows a load failure instead of a guess. */
export function reviewQueueOf(body: unknown): ReviewItem[] | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body["submissions"]) ||
    !body["submissions"].every(isItem)
  ) {
    return undefined;
  }
  return (body["submissions"] as Record<string, unknown>[]).map((item) => ({
    id: item["id"] as string,
    questTitle: item["questTitle"] as Bilingual,
    username: item["username"] as string | null,
    avatar: item["avatar"] as string,
    text: item["text"] as string | null,
    points: item["points"] as number,
    marked: item["marked"] as boolean,
  }));
}

export type ReviewAnswer =
  | Readonly<{ kind: "done" }>
  /** Someone else reviewed it first, or it is gone: move on to the next one. */
  | Readonly<{ kind: "gone"; message: LocalizedText | null }>
  | Readonly<{ kind: "refused"; message: LocalizedText | null }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const MOVED_ON = new Set(["already_reviewed", "not_found", "not_approvable"]);

export function reviewAnswer(answer: AuthedResult): ReviewAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    return MOVED_ON.has(answer.code)
      ? { kind: "gone", message: answer.message }
      : { kind: "refused", message: answer.message };
  }
  return { kind: "done" };
}

/** The queue with one submission moved to the front (the one the Inbox opened); unchanged when it is not there. */
export function firstOf(queue: readonly ReviewItem[], id: string | undefined): ReviewItem[] {
  const picked = queue.find((item) => item.id === id);
  return picked === undefined ? [...queue] : [picked, ...queue.filter((item) => item !== picked)];
}

/** A rejection needs a reason of 1 to 300 characters (FR-325); an approval none. */
export const canReject = (reason: string): boolean => {
  const length = reason.trim().length;
  return length >= 1 && length <= 300;
};

export async function fetchReviewQueue(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<ReviewItem[] | undefined> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/operator/events/${encodeURIComponent(eventId)}/submissions`,
  });
  return answer.kind === "ok" ? reviewQueueOf(answer.body) : undefined;
}

export async function sendReview(
  session: Pick<Session, "request">,
  request: Readonly<{
    eventId: string;
    submissionId: string;
    decision: "approve" | "reject";
    reason: string;
    key: string;
  }>,
): Promise<ReviewAnswer> {
  return reviewAnswer(
    await session.request({
      method: "POST",
      path: `/v1/operator/events/${encodeURIComponent(request.eventId)}/submissions/${encodeURIComponent(request.submissionId)}/review`,
      body:
        request.decision === "approve"
          ? { decision: "approve" }
          : { decision: "reject", reason: request.reason.trim() },
      headers: { "idempotency-key": request.key },
    }),
  );
}
