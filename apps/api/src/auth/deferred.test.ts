import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "#src/auth/deferred";

describe("createDeferred", () => {
  it("runs a task after the caller moves on, and idle() waits for it", async () => {
    const deferred = createDeferred(() => undefined);
    const done: string[] = [];
    deferred.defer(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done.push("task");
    });
    done.push("caller");
    await deferred.idle();
    expect(done).toEqual(["caller", "task"]);
  });

  it("waits for tasks that other tasks start", async () => {
    const deferred = createDeferred(() => undefined);
    const done: string[] = [];
    deferred.defer(async () => {
      deferred.defer(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        done.push("inner");
      });
      done.push("outer");
    });
    await deferred.idle();
    expect(done).toEqual(["outer", "inner"]);
  });

  it("hands a failing task's error to onError, and idle() still settles", async () => {
    const onError = vi.fn();
    const deferred = createDeferred(onError);
    const boom = new Error("boom");
    deferred.defer(() => Promise.reject(boom));
    await expect(deferred.idle()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("counts the tasks still running", async () => {
    const deferred = createDeferred(() => undefined);
    let open: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    deferred.defer(() => gate);
    expect(deferred.pending()).toBe(1);
    open?.();
    await deferred.idle();
    expect(deferred.pending()).toBe(0);
  });

  it("answers idle() at once when nothing is running", async () => {
    await expect(createDeferred(() => undefined).idle()).resolves.toBeUndefined();
  });
});
