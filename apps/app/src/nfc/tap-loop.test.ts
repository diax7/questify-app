import { describe, expect, it, vi } from "vitest";
import type { TagRead } from "#src/nfc/native.ts";
import { tapLoop, type ActiveWait } from "#src/nfc/tap-loop.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(reads: TagRead[]) {
  const offs: boolean[] = [];
  const got: TagRead[] = [];
  const waits: Array<{ resolve: () => void; cancelled: boolean }> = [];
  const stopReading = vi.fn();
  const read = vi.fn(async () => reads.shift() ?? { kind: "failed" as const });
  const stop = tapLoop({
    read,
    onRead: (tag) => got.push(tag),
    onOff: (off) => offs.push(off),
    untilActive: (): ActiveWait => {
      const wait = { resolve: () => undefined as void, cancelled: false };
      const done = new Promise<void>((resolve) => {
        wait.resolve = resolve;
      });
      waits.push(wait);
      return {
        done,
        cancel: () => {
          wait.cancelled = true;
          wait.resolve();
        },
      };
    },
    pause: async () => undefined,
    stopReading,
  });
  return { offs, got, waits, read, stop, stopReading };
}

describe("the scanner's tap loop", () => {
  it("reads again once the app is back with NFC switched on", async () => {
    const tag: TagRead = { kind: "read", url: "https://questify.nafes.com/t/x", uid: null };
    const loop = harness([{ kind: "off" }, tag]);
    await settle();
    expect(loop.offs).toEqual([true]);
    expect(loop.read).toHaveBeenCalledTimes(1);
    loop.waits[0]?.resolve();
    await settle();
    await settle();
    expect(loop.offs).toEqual([true, false]);
    expect(loop.got).toEqual([tag]);
  });

  it("stops waiting for the app when the screen stops", async () => {
    const loop = harness([{ kind: "off" }]);
    await settle();
    loop.stop();
    await settle();
    expect(loop.waits[0]?.cancelled).toBe(true);
    expect(loop.offs).toEqual([true]);
    expect(loop.read).toHaveBeenCalledTimes(1);
    expect(loop.stopReading).toHaveBeenCalledTimes(1);
  });

  it("tries again after a failed read and ends on unsupported", async () => {
    const loop = harness([{ kind: "failed" }, { kind: "unsupported" }]);
    await settle();
    await settle();
    expect(loop.read).toHaveBeenCalledTimes(2);
    expect(loop.got).toEqual([]);
  });
});
