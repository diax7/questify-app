"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { useConfirmation } from "#src/components/useConfirmation.tsx";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import styles from "#src/ui/shell.module.css";

/**
 * Ends the session. An icon in the top bar and in the phone menu, named and explained by a tooltip (ADR-370). A failure
 * shows as a notice under the bar, so the dark bar never has to hold a sentence.
 */
export function SignOutButton({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const confirmation = useConfirmation(language);

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
      <IconButton
        icon="signOut"
        mirror
        label={t("staff.signOut")}
        onClick={() =>
          confirmation.ask({
            title: t("confirm.signOut.title"),
            body: t("confirm.signOut.body"),
            confirmLabel: t("staff.signOut"),
            run: signOut,
          })
        }
        disabled={busy}
      />
      {confirmation.dialog}
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
