"use client";

import {
  NO_OVERRIDES,
  readOverrides,
  type EventLayers,
  type Language,
  type Overrides,
  type SetupProgress,
} from "@questify/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import type { EventView } from "#src/lib/events.ts";
import type { Translate } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { readSetup, withOverrides } from "#src/lib/setup.ts";
import { useEventLayers } from "#src/lib/use-event-layers.ts";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

export type SetupWizardState = Readonly<{
  /** Null until read; `loadFailed` says the read did not work. */
  progress: SetupProgress | null;
  /** The event as last read; null until the first read. The header uses it, a step does not unless `fresh`. */
  event: EventView | null;
  /** Whether `event` was read since the last move: a step shows its switches only from such a read. */
  fresh: boolean;
  /**
   * The features the owner may see (FR-1826, FR-1827): the switches, and the add-ons locked or unlocked. Null until read and
   * when the read failed, so no switch and no add-on shows.
   */
  layers: EventLayers | null;
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

/** The event as read when the wizard held `at`; any other progress (every move makes one) means a stale read. */
type EventRead = Readonly<{ event: EventView; at: SetupProgress }>;

type Load = Readonly<{
  progress: SetupProgress;
  event: EventView;
  overrides: Overrides;
}>;

type Base = Readonly<{ progress: SetupProgress; event: EventView }>;

/** Whether any answer says the staff session ended, so the person must sign in again. */
function sessionEnded(...bodies: readonly unknown[]): boolean {
  return bodies.some((body) => SESSION_LOST.has(errorCodeOf(body) ?? ""));
}

/** The event out of the answer to `GET …/events/:id`, or undefined when the read did not work. */
function readEvent(found: PostResult): EventView | undefined {
  return found.ok ? (found.body as { event?: EventView } | undefined)?.event : undefined;
}

/** The progress and the event, or that the session ended, or that either could not be read. */
function readBase(setup: PostResult, found: PostResult): Base | "session_lost" | "failed" {
  const progress = setup.ok ? readSetup(setup.body) : undefined;
  const event = readEvent(found);
  if (progress !== undefined && event !== undefined) {
    return { progress, event };
  }
  return sessionEnded(setup.body, found.body) ? "session_lost" : "failed";
}

/** The texts an admin changed; a read that failed is no change, not a failure. */
function readExtras(texts: PostResult) {
  return { overrides: texts.ok ? readOverrides(texts.body) : NO_OVERRIDES };
}

/** What the three reads of the wizard add up to: the loaded data, that the session ended, or that it did not load. */
function readLoad(answers: readonly PostResult[]): Load | "session_lost" | "failed" {
  const [setup, found, texts] = answers as readonly [PostResult, PostResult, PostResult];
  const base = readBase(setup, found);
  return typeof base === "string" ? base : { ...base, ...readExtras(texts) };
}

/**
 * Everything the guided setup reads: its progress, the event (for the switches it shows), the features the owner may see
 * and the texts an admin changed (FR-1754, FR-1755, FR-1757, FR-1826). A text read that fails leaves the shipped texts; a
 * feature read that fails shows no switch; a failed progress or event read is the error state. Saving replaces the saved
 * progress (the last save wins).
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
  const [eventRead, setEventRead] = useState<EventRead | null>(null);
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = useRef(false);
  const { layers } = useEventLayers(organizerId, eventId);

  useEffect(() => {
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void Promise.all([
      requestJson("GET", `${base}/setup`),
      requestJson("GET", base),
      requestJson("GET", "/v1/translations"),
    ]).then((answers) => {
      const read = readLoad(answers);
      if (read === "session_lost") {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else if (read === "failed") {
        setLoadFailed(true);
      } else {
        setProgress(read.progress);
        setEventRead({ event: read.event, at: read.progress });
        setOverrides(read.overrides);
      }
    });
  }, [base, language]);

  useEffect(() => {
    if (progress === null || eventRead?.at === progress) {
      return;
    }
    let current = true;
    void requestJson("GET", base).then((found) => {
      const event = readEvent(found);
      if (!current) {
        return;
      }
      if (event !== undefined) {
        setEventRead({ event, at: progress });
      } else if (sessionEnded(found.body)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      current = false;
    };
  }, [base, language, progress, eventRead]);

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
    event: eventRead?.event ?? null,
    fresh: eventRead?.at === progress,
    layers,
    t,
    loadFailed,
    busy,
    problem,
    save,
    show: setProgress,
  };
}
