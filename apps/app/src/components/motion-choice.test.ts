import { describe, expect, it } from "vitest";
import { mayAnimate, modalAnimation, timerFraction } from "#src/components/motion-choice.ts";

describe("modalAnimation", () => {
  it("slides only when the phone says motion is allowed", () => {
    expect(modalAnimation(false)).toBe("slide");
  });
  it("fades under Reduce Motion and shows at once while the setting is unknown", () => {
    expect(modalAnimation(true)).toBe("fade");
    expect(modalAnimation(undefined)).toBe("none");
  });
});

describe("mayAnimate", () => {
  it("is true only for an explicit false", () => {
    expect(mayAnimate(false)).toBe(true);
    expect(mayAnimate(true)).toBe(false);
    expect(mayAnimate(undefined)).toBe(false);
  });
});

describe("timerFraction", () => {
  it("follows the time smoothly when animated", () => {
    expect(timerFraction(0, 10_000, true)).toBe(1);
    expect(timerFraction(2_500, 10_000, true)).toBeCloseTo(0.75);
    expect(timerFraction(10_000, 10_000, true)).toBe(0);
  });
  it("drops in whole seconds when not animated, still showing the time", () => {
    expect(timerFraction(0, 10_000, false)).toBe(1);
    expect(timerFraction(999, 10_000, false)).toBe(1);
    expect(timerFraction(1_000, 10_000, false)).toBeCloseTo(0.9);
    expect(timerFraction(2_500, 10_000, false)).toBeCloseTo(0.8);
    expect(timerFraction(10_000, 10_000, false)).toBe(0);
  });
  it("stays within 0 to 1 whatever the clock says, and is empty without a span", () => {
    expect(timerFraction(-5, 10_000, true)).toBe(1);
    expect(timerFraction(99_000, 10_000, false)).toBe(0);
    expect(timerFraction(0, 0, true)).toBe(0);
  });
});
