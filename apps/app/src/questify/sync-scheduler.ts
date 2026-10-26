/** Foreground syncs are at least this far apart (T-403 plan: "foreground, at most every 5 minutes"). */
export const FOREGROUND_GAP_MS = 5 * 60_000;
/** A completion waits this long for the next one before one sync covers them all (trailing debounce, MINOR-8). */
export const COMPLETION_DEBOUNCE_MS = 15_000;
/** How long syncing pauses after a 429 that names no wait. */
export const LIMITED_PAUSE_MS = 60_000;

/** What one call came to. A `limited` outcome (HTTP 429) pauses syncing and is never shown to the player. */
export type RunOutcome =
  | Readonly<{ kind: "done" }>
  | Readonly<{ kind: "limited"; retryAfterSeconds: number | null }>;

export type SchedulerDeps = Readonly<{
  /** Makes one sync call; it must resolve whatever the network does (a failure is `done`: the next trigger retries). */
  run: () => Promise<RunOutcome>;
  now: () => number;
  setTimer: (work: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}>;

export type SyncScheduler = Readonly<{
  /** Profile or Questify quests gained focus: sync now. */
  focus: () => void;
  /** The app came back to the foreground: sync unless one ran in the last five minutes. */
  foreground: () => void;
  /** A quest was completed: sync about 15 seconds after the last completion. */
  completion: () => void;
  /** Sign-out or unmount: drop what is waiting. */
  stop: () => void;
}>;

/**
 * When the phone asks the server to credit achievements and Questify quests. Calls never overlap: a trigger that
 * arrives while one runs makes exactly one more call after it. After a 429 nothing is sent until the wait is over.
 */
export function createSyncScheduler(deps: SchedulerDeps): SyncScheduler {
  let timer: unknown = null;
  let running = false;
  let again = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let pausedUntil = 0;
  let stopped = false;

  const start = async (): Promise<void> => {
    if (stopped || deps.now() < pausedUntil) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    lastStart = deps.now();
    const outcome = await deps.run();
    running = false;
    if (outcome.kind === "limited") {
      const wait =
        outcome.retryAfterSeconds === null ? LIMITED_PAUSE_MS : outcome.retryAfterSeconds * 1000;
      pausedUntil = deps.now() + wait;
      again = false;
      return;
    }
    if (again) {
      again = false;
      void start();
    }
  };

  const cancelTimer = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  return {
    focus: () => void start(),
    foreground: () => {
      if (deps.now() - lastStart >= FOREGROUND_GAP_MS) void start();
    },
    completion: () => {
      if (stopped) return;
      cancelTimer();
      timer = deps.setTimer(() => {
        timer = null;
        void start();
      }, COMPLETION_DEBOUNCE_MS);
    },
    stop: () => {
      stopped = true;
      again = false;
      cancelTimer();
    },
  };
}
