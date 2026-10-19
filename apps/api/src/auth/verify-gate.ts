/** Thrown when a password check could not start within the allowed wait. */
export class GateBusyError extends Error {
  constructor() {
    super("Too many password checks are running; try again in a moment.");
    this.name = "GateBusyError";
  }
}

export type VerifyGate = Readonly<{
  /** Runs `work` once a place is free, or throws GateBusyError after waiting `waitMs`. */
  run: <T>(work: () => Promise<T>) => Promise<T>;
}>;

/**
 * Lets at most `limit` password checks run at the same time. Hashing is memory hungry and runs on the
 * shared thread pool, and sign-in is open to anyone, so the rest wait briefly and then give up.
 */
export function createVerifyGate(options: { limit: number; waitMs: number }): VerifyGate {
  let running = 0;
  const waiting = new Set<() => void>();

  const acquire = (): Promise<void> => {
    if (running < options.limit) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const take = (): void => {
        clearTimeout(timer);
        running += 1;
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.delete(take);
        reject(new GateBusyError());
      }, options.waitMs);
      waiting.add(take);
    });
  };

  const release = (): void => {
    running -= 1;
    const [next] = waiting;
    if (next !== undefined) {
      waiting.delete(next);
      next();
    }
  };

  return {
    run: async (work) => {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
