import { describe, expect, it } from "vitest";
import { GateBusyError, createVerifyGate } from "#src/auth/verify-gate";

const later = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; release: () => void } {
  const handle: { release: () => void } = { release: () => undefined };
  const promise = new Promise<void>((resolve) => {
    handle.release = resolve;
  });
  return { promise, release: () => handle.release() };
}

describe("createVerifyGate", () => {
  it("returns the work's result", async () => {
    const gate = createVerifyGate({ limit: 2, waitMs: 50 });
    expect(await gate.run(async () => 42)).toBe(42);
  });

  it("never runs more than the limit at once", async () => {
    const gate = createVerifyGate({ limit: 2, waitMs: 1000 });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gate.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await later(5);
          running -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("starts a waiting job as soon as a place frees up", async () => {
    const gate = createVerifyGate({ limit: 1, waitMs: 1000 });
    const first = deferred();
    const order: string[] = [];
    const a = gate.run(async () => {
      await first.promise;
      order.push("a");
    });
    const b = gate.run(async () => {
      order.push("b");
    });
    await later(10);
    expect(order).toEqual([]);
    first.release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("gives up with GateBusyError after waiting too long, and does not start that job later", async () => {
    const gate = createVerifyGate({ limit: 1, waitMs: 20 });
    const first = deferred();
    let started = false;
    const a = gate.run(() => first.promise);
    await expect(
      gate.run(async () => {
        started = true;
      }),
    ).rejects.toBeInstanceOf(GateBusyError);
    first.release();
    await a;
    await later(5);
    expect(started).toBe(false);
  });

  it("keeps counting correctly after waiting jobs have run, so a late arrival still waits", async () => {
    const gate = createVerifyGate({ limit: 1, waitMs: 1000 });
    const firstRelease = deferred();
    const secondRelease = deferred();
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push("first start");
      await firstRelease.promise;
    });
    const second = gate.run(async () => {
      order.push("second start");
      await secondRelease.promise;
      order.push("second end");
    });
    await later(5);
    firstRelease.release();
    await first;
    await later(5);
    const third = gate.run(async () => {
      order.push("third start");
    });
    await later(10);
    expect(order).toEqual(["first start", "second start"]);
    secondRelease.release();
    await Promise.all([second, third]);
    expect(order).toEqual(["first start", "second start", "second end", "third start"]);
  });

  it("serves waiting jobs in the order they arrived", async () => {
    const gate = createVerifyGate({ limit: 1, waitMs: 1000 });
    const hold = deferred();
    const order: number[] = [];
    const first = gate.run(() => hold.promise);
    const rest = [1, 2, 3].map((n) =>
      gate.run(async () => {
        order.push(n);
      }),
    );
    await later(5);
    hold.release();
    await Promise.all([first, ...rest]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("names the busy error clearly", () => {
    const error = new GateBusyError();
    expect(error.name).toBe("GateBusyError");
    expect(error.message).toMatch(/Too many password checks/);
  });

  it("frees the place when the work throws", async () => {
    const gate = createVerifyGate({ limit: 1, waitMs: 50 });
    await expect(
      gate.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await gate.run(async () => "ok")).toBe("ok");
  });
});
