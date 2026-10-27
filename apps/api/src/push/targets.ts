import type { PushTarget } from "#src/push/provider";

/** Consecutive 5xx answers or timeouts that trip a target's breaker (ADR-345 (5)). */
export const BREAKER_FAILURES = 10;
/** The first trip holds the target this long; each consecutive trip doubles it, up to the cap. */
export const BREAKER_FIRST_HOLD_MS = 30_000;
export const BREAKER_MAX_HOLD_MS = 15 * 60_000;

export type HoldLog = (
  fields: Readonly<{ event: string; target: PushTarget; code: string }>,
) => void;

/**
 * Each target's hold and breaker, in memory per worker (ADR-345 (5)): an account or quota refusal, a tripped breaker
 * or the mass-invalid guard holds a target, and the claim leaves it out until the hold ends. Holds are per target, so a
 * sandbox fault never stops production pushes. Times are the worker's monotonic clock.
 */
export type TargetState = Readonly<{
  held: (target: PushTarget) => boolean;
  /** The targets of `from` that are not held now. */
  available: (from: readonly PushTarget[]) => PushTarget[];
  hold: (target: PushTarget, ms: number, code: string) => void;
  /** A 5xx answer, a timeout or a connection that failed: counted towards the breaker. */
  failure: (target: PushTarget) => void;
  /** A message the provider accepted: the breaker starts again from nothing. */
  success: (target: PushTarget) => void;
}>;

export function createTargetState(now: () => number, log: HoldLog): TargetState {
  const until = new Map<PushTarget, number>();
  const failures = new Map<PushTarget, number>();
  const trips = new Map<PushTarget, number>();
  const held = (target: PushTarget): boolean => (until.get(target) ?? 0) > now();
  const hold = (target: PushTarget, ms: number, code: string): void => {
    until.set(target, Math.max(until.get(target) ?? 0, now() + ms));
    log({ event: "push.provider_hold", target, code });
  };
  return {
    held,
    available: (from) => from.filter((target) => !held(target)),
    hold,
    failure: (target) => {
      const count = (failures.get(target) ?? 0) + 1;
      if (count < BREAKER_FAILURES) {
        failures.set(target, count);
        return;
      }
      const tripped = trips.get(target) ?? 0;
      failures.set(target, 0);
      trips.set(target, tripped + 1);
      hold(target, Math.min(BREAKER_FIRST_HOLD_MS * 2 ** tripped, BREAKER_MAX_HOLD_MS), "breaker");
    },
    success: (target) => {
      failures.set(target, 0);
      trips.set(target, 0);
    },
  };
}
