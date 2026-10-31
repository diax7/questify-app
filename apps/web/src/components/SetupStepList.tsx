"use client";

import { SETUP_STEPS, type SetupProgress } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";
import { stepNameKey } from "#src/lib/setup.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Row, Rows, SubHeading } from "#src/ui/Section.tsx";

/** The progress and how to open one of its steps: what the list of steps and the review need. */
export type StepFlow = Readonly<{
  progress: SetupProgress;
  busy: boolean;
  /** Opens a step by its number, 1 to 10. */
  open: (number: number) => void;
}>;

const TONE = { open: "neutral", done: "success", skipped: "info" } as const;

/** The steps in order, each with what became of it and a way to open it (FR-1846: ten steps, each can be opened). */
export function StepList({
  t,
  flow,
  lastStep = SETUP_STEPS.length,
}: Readonly<{ t: Translate; flow: StepFlow; lastStep?: number }>) {
  return (
    <Rows>
      {SETUP_STEPS.slice(0, lastStep).map((step, index) => {
        const name = t(stepNameKey(step));
        const state = flow.progress.steps[index] ?? "open";
        return (
          <Row
            key={step}
            main={
              <>
                <SubHeading>
                  {index + 1} · {name}
                </SubHeading>
                <Badge tone={TONE[state]}>{t(`setup.state.${state}`)}</Badge>
              </>
            }
          >
            <Button
              variant="secondary"
              disabled={flow.busy}
              aria-label={t("setup.openNamed", { name })}
              onClick={() => flow.open(index + 1)}
            >
              {t("setup.open")}
            </Button>
          </Row>
        );
      })}
    </Rows>
  );
}
