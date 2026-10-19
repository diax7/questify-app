"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { CodeStep } from "#src/components/CodeStep.tsx";
import { PasswordStep } from "#src/components/PasswordStep.tsx";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

/** The challenge token lives only here, in memory: never in the URL or browser storage (a refresh starts over). */
type Step =
  | Readonly<{ kind: "password" }>
  | Readonly<{ kind: "code"; email: string; challengeToken: string }>;

export function SignInForm({
  language,
  sessionEnded,
}: Readonly<{ language: Language; sessionEnded: boolean }>) {
  const t = translatorFor(language);
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [notice, setNotice] = useState<string | null>(
    sessionEnded ? t("staff.sessionEnded") : null,
  );

  return (
    <section className={styles.panel} aria-labelledby="sign-in-title">
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {step.kind === "password" ? (
        <PasswordStep
          language={language}
          onCodeSent={(email, challengeToken) => {
            setNotice(null);
            setStep({ kind: "code", email, challengeToken });
          }}
        />
      ) : (
        <CodeStep
          language={language}
          email={step.email}
          challengeToken={step.challengeToken}
          onRestart={(reason) => {
            setNotice(reason === "" ? null : reason);
            setStep({ kind: "password" });
          }}
        />
      )}
    </section>
  );
}
