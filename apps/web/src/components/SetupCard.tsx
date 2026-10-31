"use client";

import {
  SETUP_STEP_COUNT,
  decidedSteps,
  type Language,
  type MessageKey,
  type SetupProgress,
} from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { readSetup, setupPath } from "#src/lib/setup.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Meter, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/**
 * The event page's way into the guided setup (FR-1756): Start before it was opened, Continue at the saved step while
 * it is under way, and Run setup again once it is finished or skipped, which opens it at the first step with the
 * event's current choices.
 */
export function SetupCard({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [failed, setFailed] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/setup`).then(
      (result) => {
        const read = result.ok ? readSetup(result.body) : undefined;
        if (read === undefined) {
          setFailed(true);
          return;
        }
        setProgress(read);
      },
    );
  }, [organizerId, eventId]);

  if (failed) {
    return (
      <Notice tone="danger" role="alert">
        {t("setup.loadFailed")}
      </Notice>
    );
  }
  if (progress === null) {
    return null;
  }
  const base = { language, organizerId, eventId };
  const started = progress.currentStep > 1 || decidedSteps(progress) > 0;
  return (
    <Section titleId="setup-card-title" title={t("setup.title")}>
      {progress.finished ? (
        <Muted>{t("setup.finished")}</Muted>
      ) : (
        started && <Where t={t} step={progress.currentStep} />
      )}
      <Toolbar>
        <ButtonLink
          variant={progress.finished ? "secondary" : "primary"}
          href={setupPath(base, progress.finished ? { step: "basics" } : undefined)}
        >
          {t(entryLabel(progress.finished, started))}
        </ButtonLink>
      </Toolbar>
    </Section>
  );
}

/** What the card's button says: Run setup again once finished, Continue once started, else Start. */
function entryLabel(finished: boolean, started: boolean): MessageKey {
  if (finished) {
    return "setup.rerun";
  }
  return started ? "setup.resume" : "setup.start";
}

/** The bar and the words for the saved step. */
function Where({ t, step }: Readonly<{ t: Translate; step: number }>) {
  const where = t("setup.stepOf", { step, total: SETUP_STEP_COUNT });
  return (
    <>
      <Meter
        share={step / SETUP_STEP_COUNT}
        reading={{
          label: t("setup.progressLabel"),
          now: step,
          max: SETUP_STEP_COUNT,
          text: where,
        }}
      />
      <Muted>{where}</Muted>
    </>
  );
}
