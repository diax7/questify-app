/**
 * Work that runs after the answer has gone (T-020: the reset request answers before it looks anything up). Tasks
 * catch and log their own expected failures; anything else they throw goes to `onError`, never into silence.
 * `idle()` waits for what is still running, so shutdown and tests can drain it.
 */
export type Deferred = Readonly<{
  defer: (task: () => Promise<void>) => void;
  idle: () => Promise<void>;
  /** How many tasks are still running. */
  pending: () => number;
}>;

export function createDeferred(onError: (error: unknown) => void): Deferred {
  const running = new Set<Promise<void>>();
  return {
    defer: (task) => {
      const promise = Promise.resolve()
        .then(task)
        .catch(onError)
        .finally(() => running.delete(promise));
      running.add(promise);
    },
    idle: async () => {
      while (running.size > 0) {
        await Promise.all(running);
      }
    },
    pending: () => running.size,
  };
}
