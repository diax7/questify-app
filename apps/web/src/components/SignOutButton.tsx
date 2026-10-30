"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import styles from "#src/ui/shell.module.css";

/**
 * Ends the session. Its look comes from the shell (it sits in the top bar and the phone menu); a failure shows as a
 * notice under the bar, so the dark bar never has to hold a sentence.
 */
export function SignOutButton({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const signOut = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/v1/staff/auth/sign-out", { method: "POST" });
      if (response.ok || response.status === 401) {
        window.location.assign(`/${language}/sign-in`);
        return;
      }
      setProblem(describeProblem(await response.json().catch(() => undefined), language, t).text);
    } catch {
      setProblem(t("error.network"));
    }
    setBusy(false);
  };

  return (
    <>
      <button type="button" onClick={() => void signOut()} disabled={busy}>
        {t("staff.signOut")}
      </button>
      {problem === null ? null : (
        <div className={styles.signOutProblem}>
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        </div>
      )}
    </>
  );
}
