"use client";

import { NO_OVERRIDES, type Language, type Overrides, type SetupProgress } from "@questify/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import { readActivation, type ActivationView } from "#src/lib/activation.ts";
import type { EventView } from "#src/lib/events.ts";
import type { Translate } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { readOverrides, readSetup, withOverrides } from "#src/lib/setup.ts";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

export type SetupWizardState = Readonly<{
  /** Null until read; `loadFailed` says the read did not work. */
  progress: SetupProgress | null;
  event: EventView | null;
  /** The add-ons Questify unlocked for the event; empty when they could not be read, so nothing shows unlocked. */
  addons: readonly string[];
  /** The wizard's words: the shipped texts with what an admin changed laid over them. */
  t: Translate;
  loadFailed: boolean;
  busy: boolean;
  problem: string | null;
  /** Saves the progress as given; true when it was saved. */
  save: (next: SetupProgress) => Promise<boolean>;
  /** Shows other progress without saving it (a re-run starts only when the first step is decided). */
  show: (next: SetupProgress) => void;
}>;

type Load = Readonly<{
  progress: SetupProgress;
  event: EventView;
  activation: ActivationView | null;
  overrides: Overrides;
}>;

type Base = Readonly<{ progress: SetupProgress; event: EventView }>;

/** Whether any answer says the staff session ended, so the person must sign in again. */
function sessionEnded(...bodies: readonly unknown[]): boolean {
  return bodies.some((body) => SESSION_LOST.has(errorCodeOf(body) ?? ""));
}

/** The progress and the event, or that the session ended, or that either could not be read. */
function readBase(setup: PostResult, found: PostResult): Base | "session_lost" | "failed" {
  const progress = setup.ok ? readSetup(setup.body) : undefined;
  const event = found.ok ? (found.body as { event?: EventView } | undefined)?.event : undefined;
  if (progress !== undefined && event !== undefined) {
    return { progress, event };
  }
  return sessionEnded(setup.body, found.body) ? "session_lost" : "failed";
}

/** The unlocked add-ons and the changed texts; a read that failed is no add-on and no change, not a failure. */
function readExtras(activated: PostResult, texts: PostResult) {
  const activation = activated.ok
    ? readActivation((activated.body as { activation?: unknown } | undefined)?.activation)
    : undefined;
  return {
    activation: activation ?? null,
    overrides: texts.ok ? readOverrides(texts.body) : NO_OVERRIDES,
  };
}

/** What the four reads of the wizard add up to: the loaded data, that the session ended, or that it did not load. */
function readLoad(answers: readonly PostResult[]): Load | "session_lost" | "failed" {
  const [setup, found, activated, texts] = answers as readonly [
    PostResult,
    PostResult,
    PostResult,
    PostResult,
  ];
  const base = readBase(setup, found);
  return typeof base === "string" ? base : { ...base, ...readExtras(activated, texts) };
}

/**
 * Everything the guided setup reads: its progress, the event (for the switches it shows), the unlocked add-ons and the
 * texts an admin changed (FR-1754, FR-1755, FR-1757). A text or add-on read that fails leaves the shipped texts and a
 * locked card; a failed progress or event read is the error state. Saving replaces the saved progress (the last save wins).
 */
export function useSetupWizard(
  language: Language,
  organizerId: string,
  eventId: string,
): SetupWizardState {
  const base = `/v1/organizers/${organizerId}/events/${eventId}`;
  const terms = useEventTerms();
  const shipped = useTranslator(language);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [event, setEvent] = useState<EventView | null>(null);
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void Promise.all([
      requestJson("GET", `${base}/setup`),
      requestJson("GET", base),
      requestJson("GET", `${base}/activation`),
      requestJson("GET", "/v1/translations"),
    ]).then((answers) => {
      const read = readLoad(answers);
      if (read === "session_lost") {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else if (read === "failed") {
        setLoadFailed(true);
      } else {
        setProgress(read.progress);
        setEvent(read.event);
        setActivation(read.activation);
        setOverrides(read.overrides);
      }
    });
  }, [base, language]);

  const t = useMemo(
    () => withOverrides(shipped, language, terms, overrides),
    [shipped, language, terms, overrides],
  );

  const save = useCallback(
    async (next: SetupProgress): Promise<boolean> => {
      setBusy(true);
      setProblem(null);
      const result = await requestJson("PUT", `${base}/setup`, next);
      setBusy(false);
      const saved = result.ok ? readSetup(result.body) : undefined;
      if (saved === undefined) {
        if (sessionEnded(result.body)) {
          window.location.assign(`/${language}/sign-in?ended=1`);
        } else {
          setProblem(t("setup.saveFailed"));
        }
        return false;
      }
      setProgress(saved);
      return true;
    },
    [base, language, t],
  );

  return {
    progress,
    event,
    addons: activation?.addons ?? [],
    t,
    loadFailed,
    busy,
    problem,
    save,
    show: setProgress,
  };
}
