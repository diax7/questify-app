import type { MessageKey } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";

type Text = Readonly<{ ar: string | null; en: string | null }>;

export type ReviewCodeKind = "quest" | "step" | "reveal" | "meet";

/** One printable code of the App Review demo event (T-710b, ADR-565): what the picker feeds to the scanner. */
export type ReviewCode = Readonly<{
  kind: ReviewCodeKind;
  id: string;
  questId: string | null;
  title: Text;
  label: Text | null;
  url: string | null;
}>;

/** What picking a code does: the scanner's QR handler, or a fresh meet code first. */
export type ReviewPick =
  | Readonly<{ kind: "scan"; data: string }>
  | Readonly<{ kind: "meet"; questId: string }>;

export const REVIEW_KIND_TEXT: Readonly<Record<ReviewCodeKind, MessageKey>> = {
  quest: "scanner.review.kind.quest",
  step: "scanner.review.kind.step",
  reveal: "scanner.review.kind.reveal",
  meet: "scanner.review.kind.meet",
};

const KINDS: ReadonlySet<string> = new Set(Object.keys(REVIEW_KIND_TEXT));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isString = (value: unknown): value is string => typeof value === "string";

const nullOr = (value: unknown, check: (value: unknown) => boolean): boolean =>
  value === null || check(value);

function readCode(value: unknown): ReviewCode | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const checks = [
    isString(value["kind"]) && KINDS.has(value["kind"]),
    isString(value["id"]),
    nullOr(value["questId"], isString),
    isText(value["title"]),
    nullOr(value["label"], isText),
    nullOr(value["url"], isString),
  ];
  return checks.every(Boolean) ? (value as ReviewCode) : undefined;
}

/** The picker's list; a code this build cannot read is left out rather than break the sheet. */
export function readReviewCodes(body: unknown): ReviewCode[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["codes"])) {
    return undefined;
  }
  return body["codes"].flatMap((value: unknown) => {
    const code = readCode(value);
    return code === undefined ? [] : [code];
  });
}

/** What picking a code does; undefined for a code the scanner cannot take (a printed code with no address). */
export function pickOf(code: ReviewCode): ReviewPick | undefined {
  if (code.kind === "meet") {
    return { kind: "meet", questId: code.id };
  }
  if (code.url === null) {
    return undefined;
  }
  return { kind: "scan", data: code.url };
}

export type ReviewCodesAnswer =
  | Readonly<{ kind: "codes"; codes: ReviewCode[] }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "signed_out" }>;

/** `GET /v1/events/{id}/review-codes`: only the reviewer gets an answer; anyone else is 404, read as failed. */
export async function fetchReviewCodes(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<ReviewCodesAnswer> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/review-codes`,
  });
  if (answer.kind === "signed_out") {
    return answer;
  }
  const codes = answer.kind === "ok" ? readReviewCodes(answer.body) : undefined;
  return codes === undefined ? { kind: "failed" } : { kind: "codes", codes };
}

export type ReviewMeetAnswer =
  | Readonly<{ kind: "code"; code: string }>
  | Readonly<{ kind: "none_left" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "signed_out" }>;

export function reviewMeetAnswerOf(answer: AuthedResult): ReviewMeetAnswer {
  if (answer.kind === "signed_out") {
    return answer;
  }
  if (answer.kind === "ok") {
    const body = answer.body;
    return isRecord(body) && typeof body["code"] === "string"
      ? { kind: "code", code: body["code"] }
      : { kind: "failed" };
  }
  return answer.kind === "error" && answer.status === 409
    ? { kind: "none_left" }
    : { kind: "failed" };
}

/** A fictional demo player's one-minute meet code, for the reviewer's scanner (`POST .../review-codes/meet`). */
export async function fetchReviewMeetCode(
  session: Pick<Session, "request">,
  eventId: string,
  questId: string,
): Promise<ReviewMeetAnswer> {
  return reviewMeetAnswerOf(
    await session.request({
      method: "POST",
      path: `/v1/events/${encodeURIComponent(eventId)}/review-codes/meet`,
      body: { questId },
    }),
  );
}
