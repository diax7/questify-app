import {
  dailyAnswerReplySchema,
  dailyChallengeSchema,
  dailyConflictSchema,
  dailyGuessReplySchema,
  dailyWordGameSchema,
  invalidGuessSchema,
  type DailyAnswerBody,
  type DailyAnswerReply,
  type DailyConflictReason,
  type DailyGuessBody,
  type DailyGuessRefusal,
  type DailyGuessReply,
  type OwnDaily,
} from "@questify/shared";
import type { Reader } from "#src/questify/questify-api.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The caller's two games from a `GET /v1/me/daily` body. Each game is read on its own, so one the app cannot read (an
 * API newer or older than the app) is simply absent and never hides the other; a body that is not an object is null.
 */
export function ownDailyOf(body: unknown): OwnDaily | null {
  if (!isRecord(body)) return null;
  const challenge = dailyChallengeSchema.safeParse(body["challenge"]);
  const word = dailyWordGameSchema.safeParse(body["word"]);
  return {
    challenge: challenge.success ? challenge.data : null,
    word: word.success ? word.data : null,
  };
}

/** The caller's games, or null when the answer is missing or not an object (a failed read is never "no games"). */
export async function fetchOwnDaily(session: Reader): Promise<OwnDaily | null> {
  const answer = await session.request({ method: "GET", path: "/v1/me/daily" });
  return answer.kind === "ok" ? ownDailyOf(answer.body) : null;
}

/** What one move (an answer or a guess) came to (T-406b, ADR-309). */
export type MoveOutcome<Reply> =
  | Readonly<{ kind: "ok"; reply: Reply }>
  /** The server refused for the game's state: the period ended, the content changed, or the move is out of turn. */
  | Readonly<{ kind: "conflict"; reason: DailyConflictReason }>
  /** A guess the server does not accept; no try was used. */
  | Readonly<{ kind: "refused"; reason: DailyGuessRefusal }>
  /** The game is switched off or has no content any more. */
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "limited" }>
  /** Any other refusal or an answer the app cannot read. Nothing is lost: a move is safe to send again. */
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

type Schema<T> = Readonly<{
  safeParse: (value: unknown) => Readonly<{ success: true; data: T } | { success: false }>;
}>;

const FAILED = { kind: "failed" } as const;
const BY_STATUS: Readonly<Record<number, MoveOutcome<never>>> = {
  429: { kind: "limited" },
  404: { kind: "unavailable" },
};
type Details = Readonly<Record<string, unknown>>;
/** What a refusal's code and details mean; a code or a reason the app does not know is a failure. */
const BY_CODE: Readonly<Record<string, (details: Details) => MoveOutcome<never>>> = {
  daily_conflict: (details) => {
    const conflict = dailyConflictSchema.safeParse(details);
    return conflict.success ? { kind: "conflict", reason: conflict.data.reason } : FAILED;
  },
  invalid_guess: (details) => {
    const refusal = invalidGuessSchema.safeParse(details);
    return refusal.success ? { kind: "refused", reason: refusal.data.reason } : FAILED;
  },
};

async function postMove<Reply>(
  session: Reader,
  path: string,
  body: unknown,
  schema: Schema<Reply>,
): Promise<MoveOutcome<Reply>> {
  const answer = await session.request({ method: "POST", path, body });
  if (answer.kind === "signed_out" || answer.kind === "network") return { kind: answer.kind };
  if (answer.kind === "ok") {
    const reply = schema.safeParse(answer.body);
    return reply.success ? { kind: "ok", reply: reply.data } : FAILED;
  }
  return BY_STATUS[answer.status] ?? BY_CODE[answer.code]?.(answer.details) ?? FAILED;
}

/**
 * Answers one question. The server keys an answer by its position, so sending the same one again after a lost reply
 * returns the stored result and pays nothing twice: no idempotency key is needed.
 */
export function postAnswer(
  session: Reader,
  body: DailyAnswerBody,
): Promise<MoveOutcome<DailyAnswerReply>> {
  return postMove(session, "/v1/me/daily/challenge/answers", body, dailyAnswerReplySchema);
}

/** Plays one guess; the same attempt and guess sent again return the stored marks. */
export function postGuess(
  session: Reader,
  body: DailyGuessBody,
): Promise<MoveOutcome<DailyGuessReply>> {
  return postMove(session, "/v1/me/daily/word/guesses", body, dailyGuessReplySchema);
}
