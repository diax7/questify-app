import type { AckOutcome } from "#src/push/doors";
import type { PushMessage, PushProvider, PushResult } from "#src/push/provider";
import type { TargetState } from "#src/push/targets";

/** One request's own limit: an attempt starts only when it can end this long before the round's deadline. */
export const ATTEMPT_MS = 10_000;
/** The most tries one row gets inside one lease (with the waits, about 33 s of the 58 s). */
export const TRIES_PER_LEASE = 3;
/** Requests written for one row before it fails for good (push_send.attempts). */
export const MAX_ATTEMPTS = 8;
/** The waits between in-lease tries after a definite 5xx, unless the provider's Retry-After fits. */
const RETRY_WAITS_MS = [1000, 2000];

/**
 * The worker's clocks: monotonic for deadlines, wall for provider deadlines and settle; `wait` sleeps, and ends early
 * (resolving) when its signal aborts.
 */
export type PushClock = Readonly<{
  now: () => number;
  wallNow: () => number;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
}>;

export const SYSTEM_CLOCK: PushClock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  wait: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    }),
};

/** What became of one row in a round: its acknowledgement, and what the guard and the breaker need to know. */
export type Attempted = Readonly<{
  outcome: AckOutcome;
  code: string | null;
  /** Requests written for the row, in total. */
  attempts: number;
  /** The provider gave an answer (the mass-invalid guard counts these). */
  answered: boolean;
  /** An invalid-token answer the guard counts (plan § Review 4). */
  ambiguous: boolean;
}>;

export type SendContext = Readonly<{
  clock: PushClock;
  targets: TargetState;
  /** The round's deadline on the monotonic clock: the claim's moment plus the lease minus 2 s. */
  deadline: number;
}>;

const TIMED_OUT: PushResult = { kind: "unknown", code: "timeout" };

/** The provider's answer, or `unknown` (`timeout`) when it does not answer within the attempt's limit. */
async function sendWithin(
  context: SendContext,
  provider: PushProvider,
  message: PushMessage,
): Promise<PushResult> {
  const limit = Math.min(ATTEMPT_MS, context.deadline - context.clock.now());
  const deadline = new Date(context.clock.wallNow() + limit);
  const stop = new AbortController();
  const timer = context.clock.wait(limit, stop.signal).then(() => TIMED_OUT);
  try {
    return await Promise.race([
      provider.send(message, deadline).catch((): PushResult => TIMED_OUT),
      timer,
    ]);
  } finally {
    stop.abort();
  }
}

const done = (
  outcome: AckOutcome,
  code: string | null,
  attempts: number,
  answered = true,
  ambiguous = false,
): Attempted => ({ outcome, code, attempts, answered, ambiguous });

/** One answer as the row's end, or null for a definite 5xx that may be tried again in this lease. */
function settleResult(
  context: SendContext,
  provider: PushProvider,
  result: PushResult,
  attempts: number,
): Attempted | null {
  const { target } = provider;
  switch (result.kind) {
    case "sent":
      context.targets.success(target);
      return done("sent", null, attempts + 1);
    case "unknown":
      context.targets.failure(target);
      return done("unknown", result.code, attempts + 1, false);
    case "failed":
      return done("failed", result.code, attempts + 1);
    case "invalid_token":
      return done("invalid", result.code, attempts + 1, true, result.ambiguous);
    case "hold":
      context.targets.hold(target, result.holdMs, result.code);
      return done("requeue", result.code, attempts);
    case "requeue":
      context.targets.failure(target);
      return result.written ? null : done("requeue", result.code, attempts, false);
  }
}

/**
 * Sends one row within its lease (plan § Review 3): an attempt starts only when it can end before the deadline, else
 * the row is requeued untried; a definite 5xx is tried again after 1 s and 2 s (or the provider's Retry-After when it
 * fits), at most `min(3, 8 − attempts)` tries, then requeued with each try counted; a held target requeues the row
 * with no attempt. Never throws.
 */
export async function sendRow(
  context: SendContext,
  provider: PushProvider,
  message: PushMessage,
  attemptsBefore: number,
): Promise<Attempted> {
  const cap = Math.min(TRIES_PER_LEASE, MAX_ATTEMPTS - attemptsBefore);
  let attempts = attemptsBefore;
  let pause = 0;
  let code = "deadline";
  for (let tries = 0; tries < cap; tries += 1) {
    if (context.clock.now() + pause + ATTEMPT_MS > context.deadline) break;
    const result = await tryOnce(context, provider, message, pause);
    if (result === null) return done("requeue", "hold", attempts, false);
    const end = settleResult(context, provider, result, attempts);
    if (end !== null) return end;
    attempts += 1;
    code = result.kind === "requeue" ? result.code : code;
    pause = nextPause(result, tries);
  }
  return done("requeue", code, attempts, attempts > attemptsBefore);
}

/** One try after `pause`: the provider's answer, or null when the target was held meanwhile. */
async function tryOnce(
  context: SendContext,
  provider: PushProvider,
  message: PushMessage,
  pause: number,
): Promise<PushResult | null> {
  if (pause > 0) await context.clock.wait(pause);
  if (context.targets.held(provider.target)) return null;
  return sendWithin(context, provider, message);
}

/** The wait before the next in-lease try: the provider's Retry-After, else 1 s then 2 s. */
const nextPause = (result: PushResult, tries: number): number =>
  (result.kind === "requeue" ? result.retryAfterMs : undefined) ?? RETRY_WAITS_MS[tries] ?? 2000;
