"use client";

import {
  SETUP_STEPS,
  SETUP_STEP_COUNT,
  decideStep,
  finishSetup,
  goToStep,
  restartSetup,
  skipAll,
  stepNumber,
  type Language,
  type SetupProgress,
  type SetupStep,
} from "@questify/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StepBody } from "#src/components/SetupSteps.tsx";
import { StepList, type StepFlow } from "#src/components/SetupStepList.tsx";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import { nameFor, type EventView } from "#src/lib/events.ts";
import type { Translate } from "#src/lib/language.ts";
import { stepNameKey, stepTitleKey } from "#src/lib/setup.ts";
import { useSetupWizard, type SetupWizardState } from "#src/lib/use-setup-wizard.ts";
import { Button, ButtonLink } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Meter, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
  /** The step the address names; the wizard opens there instead of at the saved step. */
  startAt?: SetupStep | undefined;
  /** Shows the one step alone, for a page's "Explain this" (FR-1756): nothing about the interview is saved. */
  only?: boolean | undefined;
  /** The page "Done" returns to in single-step mode (an event page's address after the event's own). */
  from?: string | undefined;
}>;

/**
 * The guided setup (T-605, FR-1751 to FR-1757, FR-1846): ten steps, one question each, every one skippable and the whole
 * interview too, saved at each move so it resumes at the same step (FR-1754). A step only shows the panels, switches and
 * doors the event's own pages have, so a choice is saved by the same operation as on its page and stays changeable there.
 */
export function SetupWizard(props: Props) {
  const wizard = useSetupWizard(props.language, props.organizerId, props.eventId);
  const { progress, event, t, show } = wizard;
  const placed = useRef(false);
  const { startAt, only } = props;

  useEffect(() => {
    if (progress === null || placed.current) {
      return;
    }
    placed.current = true;
    if (startAt !== undefined && only !== true) {
      const moved = goToStep(progress, stepNumber(startAt));
      show(progress.finished ? restartSetup(moved) : moved);
    }
  }, [progress, startAt, only, show]);

  if (wizard.loadFailed) {
    return (
      <Notice tone="danger" role="alert">
        {t("setup.loadFailed")}
      </Notice>
    );
  }
  if (progress === null || event === null) {
    return <Muted>{t("common.loading")}</Muted>;
  }
  return <SetupScreen {...props} wizard={wizard} progress={progress} event={event} />;
}

type ScreenProps = Props &
  Readonly<{ wizard: SetupWizardState; progress: SetupProgress; event: EventView }>;

/** One step of a loaded setup: its header, progress, question, body and the buttons that move on. */
function SetupScreen({ wizard, progress, event, ...props }: ScreenProps) {
  const { language, organizerId, eventId, only } = props;
  const router = useRouter();
  const { t, busy, save } = wizard;
  const confirmation = useConfirmation(language);
  const [listing, setListing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const overview = `/${language}/organizers/${organizerId}/events/${eventId}`;
  const number = only === true ? stepNumber(props.startAt ?? "basics") : progress.currentStep;
  const step = SETUP_STEPS[number - 1] ?? "basics";

  useEffect(() => {
    heading.current?.focus();
  }, [number]);

  const move = (next: SetupProgress) => void save(next);
  const leave = async (next: SetupProgress) => {
    if (await save(next)) {
      router.push(overview);
    }
  };
  const flow: StepFlow = {
    progress,
    busy,
    open: (target) => {
      setListing(false);
      move(goToStep(progress, target));
    },
  };
  const skipEverything = () =>
    confirmation.ask({
      title: t("setup.skipAll.title"),
      body: t("setup.skipAll.body"),
      confirmLabel: t("setup.skipAll.confirm"),
      run: () => leave(skipAll(progress)),
    });

  return (
    <Stack>
      <SetupTop
        t={t}
        alone={only === true}
        step={step}
        number={number}
        back={{ href: overview, label: nameFor(event, language) }}
        busy={busy}
        onList={() => setListing(true)}
        onSkipAll={skipEverything}
      />
      <SubHeading as="h2" ref={heading} tabIndex={-1}>
        {t(stepTitleKey(step))}
      </SubHeading>
      {wizard.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {wizard.problem}
        </Notice>
      )}
      <StepBody
        step={step}
        flow={flow}
        language={language}
        organizerId={organizerId}
        eventId={eventId}
        myRole={props.myRole}
        event={event}
        addons={wizard.addons}
        t={t}
      />
      <Toolbar align="between">
        {only === true ? (
          <ButtonLink
            variant="primary"
            href={`${overview}${props.from === undefined ? "" : `/${props.from}`}`}
          >
            {t("setup.done")}
          </ButtonLink>
        ) : (
          <StepButtons
            t={t}
            number={number}
            busy={busy}
            onBack={() => move(goToStep(progress, number - 1))}
            onSkip={() => move(decideStep(progress, "skipped"))}
            onNext={() =>
              number === SETUP_STEP_COUNT
                ? void leave(finishSetup(progress))
                : move(decideStep(progress, "done"))
            }
          />
        )}
      </Toolbar>
      {confirmation.dialog}
      {listing ? <StepsDialog t={t} flow={flow} close={() => setListing(false)} /> : null}
    </Stack>
  );
}

/** The header and, outside single-step mode, the bar showing where the organizer is among the ten steps. */
function SetupTop({
  t,
  alone,
  step,
  number,
  back,
  busy,
  onList,
  onSkipAll,
}: Readonly<{
  t: Translate;
  alone: boolean;
  step: SetupStep;
  number: number;
  back: Readonly<{ href: string; label: string }>;
  busy: boolean;
  onList: () => void;
  onSkipAll: () => void;
}>) {
  return (
    <>
      <SetupHeader
        t={t}
        only={alone}
        back={back}
        title={alone ? t(stepNameKey(step)) : t("setup.title")}
        busy={busy}
        onList={onList}
        onSkipAll={onSkipAll}
      />
      {alone ? null : <StepProgress t={t} number={number} step={step} />}
    </>
  );
}

/** The page's title, its way back, and (outside single-step mode) the list of steps and skipping the whole setup. */
function SetupHeader({
  t,
  only,
  back,
  title,
  busy,
  onList,
  onSkipAll,
}: Readonly<{
  t: Translate;
  only: boolean;
  back: Readonly<{ href: string; label: string }>;
  title: string;
  busy: boolean;
  onList: () => void;
  onSkipAll: () => void;
}>) {
  return (
    <PageHeader
      back={back}
      titleId="setup-title"
      title={title}
      actions={
        only ? null : (
          <>
            <Button variant="secondary" onClick={onList}>
              {t("setup.allSteps")}
            </Button>
            <Button variant="quiet" disabled={busy} onClick={onSkipAll}>
              {t("setup.skipAll")}
            </Button>
          </>
        )
      }
    />
  );
}

/** The ten steps in a sheet, each openable (FR-1846). */
function StepsDialog({
  t,
  flow,
  close,
}: Readonly<{ t: Translate; flow: StepFlow; close: () => void }>) {
  return (
    <Dialog
      role="dialog"
      title={t("setup.stepsList")}
      cancel={close}
      actions={
        <Button variant="secondary" onClick={close}>
          {t("common.close")}
        </Button>
      }
    >
      <StepList t={t} flow={flow} />
    </Dialog>
  );
}

/** The bar and the line under it: where the organizer is among the ten steps. */
function StepProgress({
  t,
  number,
  step,
}: Readonly<{ t: Translate; number: number; step: SetupStep }>) {
  const where = t("setup.stepOf", { step: number, total: SETUP_STEP_COUNT });
  return (
    <>
      <Meter
        share={number / SETUP_STEP_COUNT}
        reading={{
          label: t("setup.progressLabel"),
          now: number,
          max: SETUP_STEP_COUNT,
          text: where,
        }}
      />
      <Muted>
        {where} · {t(stepNameKey(step))}
      </Muted>
    </>
  );
}

/** Back, Skip this step and Continue (Finish setup on the last step); Back is out on the first, Skip on the last. */
function StepButtons({
  t,
  number,
  busy,
  onBack,
  onSkip,
  onNext,
}: Readonly<{
  t: Translate;
  number: number;
  busy: boolean;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
}>) {
  return (
    <>
      <Button variant="secondary" disabled={busy || number === 1} onClick={onBack}>
        {t("common.back")}
      </Button>
      {number === SETUP_STEP_COUNT ? null : (
        <Button variant="quiet" disabled={busy} onClick={onSkip}>
          {t("setup.skipStep")}
        </Button>
      )}
      <Button variant="primary" disabled={busy} onClick={onNext}>
        {number === SETUP_STEP_COUNT ? t("setup.finish") : t("common.continue")}
      </Button>
    </>
  );
}
