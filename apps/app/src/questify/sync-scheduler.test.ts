import { describe, expect, it, vi } from "vitest";
import {
  COMPLETION_DEBOUNCE_MS,
  FOREGROUND_GAP_MS,
  LIMITED_PAUSE_MS,
  createSyncScheduler,
  type RunOutcome,
} from "#src/questify/sync-scheduler.ts";

/** A hand-driven clock and timers, and a `run` whose calls the test finishes itself. */
function harness(first: RunOutcome = { kind: "done" }) {
  let clock = 1_000_000;
  const timers = new Map<number, { at: number; work: () => void }>();
  let nextTimer = 1;
  const finishers: Array<(outcome: RunOutcome) => void> = [];
  const run = vi.fn(
    () =>
      new Promise<RunOutcome>((resolve) => {
        finishers.push(resolve);
      }),
  );
  const scheduler = createSyncScheduler({
    run,
    now: () => clock,
    setTimer: (work, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, work });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  return {
    scheduler,
    run,
    /** Finishes the oldest call that is still running. */
    finish: async (outcome: RunOutcome = first) => {
      finishers.shift()?.(outcome);
      await Promise.resolve();
      await Promise.resolve();
    },
    advance: (ms: number) => {
      clock += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.work();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe("the sync scheduler", () => {
  it("syncs at once when a screen gains focus", () => {
    const h = harness();
    h.scheduler.focus();
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("never runs two calls at once: a trigger during a call makes exactly one more after it", async () => {
    const h = harness();
    h.scheduler.focus();
    h.scheduler.focus();
    h.scheduler.focus();
    expect(h.run).toHaveBeenCalledTimes(1);
    await h.finish();
    expect(h.run).toHaveBeenCalledTimes(2);
    await h.finish();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("waits 15 seconds after the last completion and covers several with one call", () => {
    const h = harness();
    h.scheduler.completion();
    h.advance(COMPLETION_DEBOUNCE_MS - 1);
    expect(h.run).not.toHaveBeenCalled();
    h.scheduler.completion();
    h.advance(COMPLETION_DEBOUNCE_MS - 1);
    expect(h.run).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.pending()).toBe(0);
  });

  it("syncs on the foreground only when five minutes have passed since the last call", async () => {
    const h = harness();
    h.scheduler.foreground();
    expect(h.run).toHaveBeenCalledTimes(1);
    await h.finish();
    h.advance(FOREGROUND_GAP_MS - 1);
    h.scheduler.foreground();
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.scheduler.foreground();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("stays quiet after a 429 for the wait the server named, then syncs again", async () => {
    const h = harness();
    h.scheduler.focus();
    await h.finish({ kind: "limited", retryAfterSeconds: 30 });
    h.scheduler.focus();
    h.advance(29_999);
    h.scheduler.focus();
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.scheduler.focus();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("pauses a minute after a 429 that names no wait, and drops the call it had queued", async () => {
    const h = harness();
    h.scheduler.focus();
    h.scheduler.focus();
    await h.finish({ kind: "limited", retryAfterSeconds: null });
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(LIMITED_PAUSE_MS - 1);
    h.scheduler.focus();
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.scheduler.focus();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("does not let a completion's call through while paused", async () => {
    const h = harness();
    h.scheduler.focus();
    await h.finish({ kind: "limited", retryAfterSeconds: 120 });
    h.scheduler.completion();
    h.advance(COMPLETION_DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("treats a rejected call as done, so the next trigger still syncs", async () => {
    const run = vi
      .fn<() => Promise<RunOutcome>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ kind: "done" });
    const scheduler = createSyncScheduler({
      run,
      now: () => 1_000_000,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    scheduler.focus();
    await Promise.resolve();
    await Promise.resolve();
    scheduler.focus();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a waiting completion and every later trigger once stopped", () => {
    const h = harness();
    h.scheduler.completion();
    h.scheduler.stop();
    expect(h.pending()).toBe(0);
    h.scheduler.focus();
    h.scheduler.foreground();
    h.scheduler.completion();
    h.advance(COMPLETION_DEBOUNCE_MS);
    expect(h.run).not.toHaveBeenCalled();
  });
});
