"use client";

import { useRef, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { announcementIssueKey } from "#src/lib/announcements.ts";
import type { Translate } from "#src/lib/language.ts";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import type { Language } from "@questify/shared";

/** Who an announcement would reach: the active members, or the rehearsal accounts before go-live. */
export type Audience = Readonly<{ members: number; phase: string }>;

export type AnnouncementConfirmation = Readonly<{
  path: string;
  body: unknown;
  title: string;
  text: string;
  label: string;
  success: string;
}>;

function announcementFailure(body: unknown, language: Language, t: Translate): string {
  const details = (body as { details?: { issue?: string } } | undefined)?.details;
  const issue = details?.issue;
  if (issue !== undefined && issue.startsWith("sendAt:")) return t(announcementIssueKey(issue));
  return describeProblem(body, language, t).text;
}

/**
 * Sends one confirmed announcement action (send now, schedule or cancel) with an Idempotency-Key kept until the answer is
 * final, so a dropped connection resends the same request once. `reload` runs after a success and `failed` receives the
 * problem to show (or undefined when a new press starts). Shared by the Announcements page and the control room.
 */
export function useAnnouncementPress(
  language: Language,
  reload: () => Promise<void>,
  failed: (problem: string | undefined) => void,
) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const key = useRef<string | null>(null);
  const t = useTranslator(language);
  const send = async (press: AnnouncementConfirmation): Promise<boolean> => {
    key.current ??= crypto.randomUUID();
    setBusy(true);
    failed(undefined);
    const answer = await requestJson("POST", press.path, press.body, {
      "Idempotency-Key": key.current,
    });
    setBusy(false);
    const transient = isTransientFailure(answer);
    setUncertain(transient);
    if (!transient) key.current = null;
    if (!answer.ok) {
      failed(announcementFailure(answer.body, language, t));
      if (["unauthenticated", "session_expired"].includes(errorCodeOf(answer.body) ?? ""))
        window.location.assign("/" + language + "/sign-in");
      return false;
    }
    await reload();
    return true;
  };
  return { send, busy, uncertain };
}
