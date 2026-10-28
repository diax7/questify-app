import type { PostResult } from "#src/lib/post-json.ts";

/**
 * Accept all in calls (T-501d, ADR-353 (5)): the API accepts at most 1,000 requests a call (under its 5 s statement
 * limit), so the dashboard calls again while a call accepted some and requests are still waiting, at most this many
 * calls (10,000 requests) per press. Each call is a new HTTP request, so the API gives it a new request id.
 */
export const ACCEPT_ALL_CALLS = 10;

/** How far a press got: requests accepted by its calls so far, and requests still waiting after the last call. */
export type AcceptAllProgress = Readonly<{ accepted: number; remaining: number }>;

export type AcceptAllOutcome =
  | Readonly<{ kind: "done"; accepted: number; remaining: number }>
  /** A call failed: the earlier calls' acceptances stand (`accepted`); `body` is the failed call's answer. */
  | Readonly<{ kind: "failed"; accepted: number; body: unknown }>;

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

/** One call's `{accepted, remaining}`, or null for an answer that is not one. */
function answerOf(body: unknown): AcceptAllProgress | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const accepted = countOf(record["accepted"]);
  const remaining = countOf(record["remaining"]);
  return accepted === null || remaining === null ? null : { accepted, remaining };
}

/**
 * Presses Accept all: calls `post` until a call accepts nothing or nothing is waiting, at most `calls` times, telling
 * `progress` the running total after each call. A failed call (or an answer that is not a count) ends the press with
 * what the earlier calls accepted.
 */
export async function acceptAllInCalls(
  post: () => Promise<PostResult>,
  progress: (sofar: AcceptAllProgress) => void,
  calls: number = ACCEPT_ALL_CALLS,
): Promise<AcceptAllOutcome> {
  let accepted = 0;
  let remaining = 0;
  for (let call = 0; call < calls; call += 1) {
    const result = await post();
    const answer = result.ok ? answerOf(result.body) : null;
    if (answer === null) return { kind: "failed", accepted, body: result.body };
    accepted += answer.accepted;
    remaining = answer.remaining;
    progress({ accepted, remaining });
    if (answer.accepted === 0 || answer.remaining === 0) break;
  }
  return { kind: "done", accepted, remaining };
}
