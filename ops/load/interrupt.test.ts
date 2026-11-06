import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { exitOnSignals, INTERRUPT_SIGNALS } from "./interrupt.mjs";

const setup = (onInterrupt: () => void = () => {}) => {
  const target = new EventEmitter();
  const exit = vi.fn();
  const report = vi.fn();
  const stop = exitOnSignals(onInterrupt, { target, exit, report });
  return { target, exit, report, stop };
};

describe("exitOnSignals", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])("cleans up and exits %s with code %i", (signal, code) => {
    const onInterrupt = vi.fn();
    const { target, exit } = setup(onInterrupt);
    target.emit(signal);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
  });

  it("covers exactly the three signals a run can be ended by", () => {
    expect(Object.keys(INTERRUPT_SIGNALS).toSorted()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
  });

  it("prints a clean-up that throws and still exits with the signal's code", () => {
    const failure = new Error("clean-up failed");
    const { target, exit, report } = setup(() => {
      throw failure;
    });
    target.emit("SIGTERM");
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  it("does nothing after the run took its handlers off", () => {
    const onInterrupt = vi.fn();
    const { target, exit, stop } = setup(onInterrupt);
    stop();
    for (const signal of Object.keys(INTERRUPT_SIGNALS)) {
      expect(target.listenerCount(signal)).toBe(0);
      target.emit(signal);
    }
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("runs the clean-up once for a signal that arrives twice", () => {
    const onInterrupt = vi.fn();
    const { target } = setup(onInterrupt);
    target.emit("SIGINT");
    target.emit("SIGINT");
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
