import type { PostResult } from "#src/lib/post-json.ts";

/**
 * Accept all in calls (T-501d, ADR-353 (5)): the API accepts at most 1,000 requests a call (250 on a hard-limited
 * event) under its 5 s statement limit, so the dashboard calls again while a call accepted some and requests are still
 * waiting, at most this many calls per press. Each call is a new HTTP request, so the API gives it a new request id.
 */
export const ACCEPT_ALL_CALLS = 10;

/** How far a press got: requests accepted by its calls so far, and requests still waiting after the last call. */
export type AcceptAllProgress = Readonly<{ accepted: number; remaining: number }>;

export type AcceptAllOutcome =
  /** `more`: the press ran out of calls while its last call still accepted some and requests wait. */
  | Readonly<{ kind: "done"; accepted: number; remaining: number; more: boolean }>
  /** A call failed: the earlier calls' acceptances stand (`accepted`); `body` is the failed call's answer. */
  | Readonly<{ kind: "failed"; accepted: number; body: unknown }>
  /** The page was left: no further call was made. */
  | Readonly<{ kind: "stopped"; accepted: number }>;

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

/** What a press calls with: the API call, the running total's listener and whether the page was left. */
export type AcceptAllCalls = Readonly<{
  post: () => Promise<PostResult>;
  progress: (sofar: AcceptAllProgress) => void;
  stopped: () => boolean;
}>;

/** One call's result: its answer, a failure (with the failed call's answer) or a left page. */
type Step =
  | Readonly<{ kind: "answer"; answer: AcceptAllProgress }>
  | Readonly<{ kind: "failed"; body: unknown }>
  | Readonly<{ kind: "stopped" }>;

/** One call, unless the page was left before it; a page left while it ran counts as left. */
async function step(deps: AcceptAllCalls): Promise<Step> {
  if (deps.stopped()) return { kind: "stopped" };
  const result = await deps.post();
  if (deps.stopped()) return { kind: "stopped" };
  const answer = result.ok ? answerOf(result.body) : null;
  return answer === null ? { kind: "failed", body: result.body } : { kind: "answer", answer };
}

/**
 * Presses Accept all: calls the API until a call accepts nothing or nothing is waiting, at most `calls` times, telling
 * `progress` the running total after each call. A failed call (or an answer that is not a count) ends the press with
 * what the earlier calls accepted; a left page ends it before the next call, telling nothing more.
 */
export async function acceptAllInCalls(
  deps: AcceptAllCalls,
  calls: number = ACCEPT_ALL_CALLS,
): Promise<AcceptAllOutcome> {
  let accepted = 0;
  let remaining = 0;
  let last = 0;
  for (let call = 0; call < calls; call += 1) {
    const next = await step(deps);
    if (next.kind === "stopped") return { kind: "stopped", accepted };
    if (next.kind === "failed") return { kind: "failed", accepted, body: next.body };
    accepted += next.answer.accepted;
    remaining = next.answer.remaining;
    last = next.answer.accepted;
    deps.progress({ accepted, remaining });
    if (last === 0 || remaining === 0) break;
  }
  return { kind: "done", accepted, remaining, more: last > 0 && remaining > 0 };
}
