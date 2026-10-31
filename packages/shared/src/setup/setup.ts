import { z } from "zod";

/** The guided setup's steps in order (FR-1846): the ten steps are fixed; the words for each are texts an admin may edit. */
export const SETUP_STEPS = [
  "basics",
  "join",
  "quests",
  "rewards",
  "sponsors",
  "screens",
  "look",
  "messages",
  "addons",
  "review",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const SETUP_STEP_COUNT = SETUP_STEPS.length;

export const SETUP_STEP_STATES = ["open", "done", "skipped"] as const;
export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

/**
 * Where an event's guided setup stands (T-605, FR-1754): the step it will open at (1 to 10), what became of each step,
 * and whether the interview was finished or skipped as a whole. It holds progress only: every choice is saved by the
 * same operation the dashboard page for it uses.
 */
export const setupSchema = z.strictObject({
  currentStep: z.number().int().min(1).max(SETUP_STEP_COUNT),
  steps: z.array(z.enum(SETUP_STEP_STATES)).length(SETUP_STEP_COUNT),
  finished: z.boolean(),
});
export type SetupProgress = z.infer<typeof setupSchema>;

/** The answer of `GET …/setup`: the progress and when it was last saved (null for an event never opened in setup). */
export const setupReadSchema = z.object({
  setup: setupSchema.extend({ updatedAt: z.string().nullable() }),
});
export type SetupRead = z.infer<typeof setupReadSchema>;

/** A new event's setup: step 1, nothing decided, not finished. */
export const FRESH_SETUP: SetupProgress = {
  currentStep: 1,
  steps: Array.from({ length: SETUP_STEP_COUNT }, () => "open" as const),
  finished: false,
};

/** The step's number, 1 to 10. */
export const stepNumber = (step: SetupStep): number => SETUP_STEPS.indexOf(step) + 1;

/** The step at a number from 1 to 10, or undefined outside it. */
export const stepAt = (number: number): SetupStep | undefined => SETUP_STEPS[number - 1];

/** Moves to a step without deciding the one left. */
export function goToStep(progress: SetupProgress, number: number): SetupProgress {
  const clamped = Math.min(Math.max(Math.trunc(number), 1), SETUP_STEP_COUNT);
  return { ...progress, currentStep: clamped };
}

/** Marks the open step done or skipped and opens the next one; the last step stays open on itself. */
export function decideStep(
  progress: SetupProgress,
  state: Exclude<SetupStepState, "open">,
): SetupProgress {
  const steps = progress.steps.map((was, index): SetupStepState =>
    index === progress.currentStep - 1 ? state : was,
  );
  return { ...progress, steps, currentStep: Math.min(progress.currentStep + 1, SETUP_STEP_COUNT) };
}

/** Skipping the whole interview: every step still open is skipped, the rest keep their state, and setup is finished. */
export function skipAll(progress: SetupProgress): SetupProgress {
  const steps = progress.steps.map((was): SetupStepState => (was === "open" ? "skipped" : was));
  return { currentStep: SETUP_STEP_COUNT, steps, finished: true };
}

/** The review step's finish: it is done, the interview is finished, and any step still open stays open. */
export function finishSetup(progress: SetupProgress): SetupProgress {
  const steps = progress.steps.map((was, index): SetupStepState =>
    index === SETUP_STEP_COUNT - 1 ? "done" : was,
  );
  return { ...progress, steps, finished: true };
}

/** Running it again: the first step, nothing finished; what each step decided before is kept as a mark. */
export function restartSetup(progress: SetupProgress): SetupProgress {
  return { ...progress, currentStep: 1, finished: false };
}

/** How many steps are decided (done or skipped). */
export const decidedSteps = (progress: SetupProgress): number =>
  progress.steps.filter((state) => state !== "open").length;
