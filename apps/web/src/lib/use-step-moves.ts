"use client";

import {
  SETUP_STEP_COUNT,
  decideStep,
  finishSetup,
  goToStep,
  skipAll,
  type Language,
  type SetupProgress,
} from "@questify/shared";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { StepFlow } from "#src/components/SetupStepList.tsx";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import type { SetupWizardState } from "#src/lib/use-setup-wizard.ts";

type Input = Readonly<{
  wizard: SetupWizardState;
  progress: SetupProgress;
  language: Language;
  /** Where leaving the wizard goes. */
  leaveTo: string;
  /** Whether the open step holds edits it has not saved: a move then asks before it drops them. */
  unsaved: boolean;
  /** Single-step mode: the address of another step's single-step view, so opening it saves nothing. */
  alone: ((step: number) => string) | undefined;
}>;

export type StepMoves = Readonly<{
  /** The list of steps and how to open one of them. */
  flow: StepFlow;
  listing: boolean;
  setListing: (listing: boolean) => void;
  back: () => void;
  skip: () => void;
  next: () => void;
  skipEverything: () => void;
  /** The confirmation being asked, to render once in the page. */
  dialog: ReactNode;
}>;

/**
 * Every way the guided setup moves: back, skip, continue (finish on the last step), opening a step from the list, and
 * skipping the whole setup. A move that would drop edits the open step has not saved asks first (FR-1752).
 */
export function useStepMoves(input: Input): StepMoves {
  const { wizard, progress, language, leaveTo, unsaved, alone } = input;
  const { t, busy, save } = wizard;
  const router = useRouter();
  const confirmation = useConfirmation(language);
  const [listing, setListing] = useState(false);

  const leave = async (next: SetupProgress) => {
    if (await save(next)) {
      router.push(leaveTo);
    }
  };
  const move = (next: SetupProgress) => {
    const run = () => void save(next);
    if (!unsaved) {
      run();
      return;
    }
    confirmation.ask({
      title: t("setup.unsaved.title"),
      body: t("setup.unsaved.body"),
      confirmLabel: t("setup.unsaved.confirm"),
      run,
    });
  };
  const open = (target: number) => {
    setListing(false);
    if (alone === undefined) {
      move(goToStep(progress, target));
    } else {
      router.push(alone(target));
    }
  };

  return {
    flow: { progress, busy, open },
    listing,
    setListing,
    back: () => move(goToStep(progress, progress.currentStep - 1)),
    skip: () => move(decideStep(progress, "skipped")),
    next: () =>
      progress.currentStep === SETUP_STEP_COUNT
        ? void leave(finishSetup(progress))
        : move(decideStep(progress, "done")),
    skipEverything: () =>
      confirmation.ask({
        title: t("setup.skipAll.title"),
        body: t("setup.skipAll.body"),
        confirmLabel: t("setup.skipAll.confirm"),
        run: () => leave(skipAll(progress)),
      }),
    dialog: confirmation.dialog,
  };
}
