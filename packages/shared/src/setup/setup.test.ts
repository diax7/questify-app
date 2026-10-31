import { describe, expect, it } from "vitest";
import {
  FRESH_SETUP,
  SETUP_STEPS,
  decideStep,
  decidedSteps,
  finishSetup,
  goToStep,
  restartSetup,
  setupReadSchema,
  setupSchema,
  skipAll,
  stepAt,
  stepNumber,
} from "./setup";

describe("guided setup steps", () => {
  it("has the ten steps of FR-1846 in order, each with a number", () => {
    expect(SETUP_STEPS).toHaveLength(10);
    expect(SETUP_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(stepAt(4)).toBe("rewards");
    expect(stepAt(0)).toBeUndefined();
    expect(stepAt(11)).toBeUndefined();
  });

  it("starts at step 1 with nothing decided", () => {
    expect(FRESH_SETUP.currentStep).toBe(1);
    expect(decidedSteps(FRESH_SETUP)).toBe(0);
    expect(FRESH_SETUP.finished).toBe(false);
  });

  it("keeps a skipped step open for the template's defaults and moves on", () => {
    const moved = decideStep(goToStep(FRESH_SETUP, 4), "skipped");
    expect(moved.steps[3]).toBe("skipped");
    expect(moved.currentStep).toBe(5);
    expect(moved.steps.filter((state) => state === "open")).toHaveLength(9);
  });

  it("marks a step done and stays on the last step after deciding it", () => {
    const last = decideStep(goToStep(FRESH_SETUP, 10), "done");
    expect(last.steps[9]).toBe("done");
    expect(last.currentStep).toBe(10);
  });

  it("clamps a step outside 1 to 10 and cuts a fraction", () => {
    expect(goToStep(FRESH_SETUP, 0).currentStep).toBe(1);
    expect(goToStep(FRESH_SETUP, 99).currentStep).toBe(10);
    expect(goToStep(FRESH_SETUP, 3.9).currentStep).toBe(3);
  });

  it("skips the whole interview without touching a step already done", () => {
    const started = decideStep(FRESH_SETUP, "done");
    const skipped = skipAll(started);
    expect(skipped.finished).toBe(true);
    expect(skipped.steps[0]).toBe("done");
    expect(skipped.steps.slice(1).every((state) => state === "skipped")).toBe(true);
  });

  it("finishes at review and leaves earlier open steps open", () => {
    const done = finishSetup(goToStep(FRESH_SETUP, 10));
    expect(done.finished).toBe(true);
    expect(done.steps[9]).toBe("done");
    expect(done.steps[0]).toBe("open");
  });

  it("restarts at step 1, unfinished, keeping what each step decided", () => {
    const again = restartSetup(skipAll(FRESH_SETUP));
    expect(again.currentStep).toBe(1);
    expect(again.finished).toBe(false);
    expect(again.steps.every((state) => state === "skipped")).toBe(true);
  });

  it("refuses a body with the wrong number of steps, an unknown state or an extra field", () => {
    expect(setupSchema.safeParse(FRESH_SETUP).success).toBe(true);
    expect(setupSchema.safeParse({ ...FRESH_SETUP, steps: ["open"] }).success).toBe(false);
    expect(
      setupSchema.safeParse({ ...FRESH_SETUP, steps: [...FRESH_SETUP.steps.slice(1), "maybe"] })
        .success,
    ).toBe(false);
    expect(setupSchema.safeParse({ ...FRESH_SETUP, currentStep: 0 }).success).toBe(false);
    expect(setupSchema.safeParse({ ...FRESH_SETUP, currentStep: 11 }).success).toBe(false);
    expect(setupSchema.safeParse({ ...FRESH_SETUP, currentStep: 2.5 }).success).toBe(false);
    expect(setupSchema.safeParse({ ...FRESH_SETUP, extra: true }).success).toBe(false);
  });

  it("reads the API answer with its save time", () => {
    const read = setupReadSchema.safeParse({ setup: { ...FRESH_SETUP, updatedAt: null } });
    expect(read.success).toBe(true);
  });
});
