"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

/** Asks for a reset link. The answer is the same for every email, so the page says "if an account uses it". */
export function ForgotPasswordForm({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setBusy(true);
    setProblem(null);
    const result = await postJson("/v1/staff/auth/reset/request", { email, lang: language });
    setBusy(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  return (
    <section className={styles.panel} aria-labelledby="forgot-title">
      <h1 id="forgot-title" className={styles.title}>
        {t("staff.forgotTitle")}
      </h1>
      {sent ? (
        <p role="status" className={styles.notice}>
          {t("staff.linkSent")}
        </p>
      ) : (
        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <p className={styles.muted}>{t("staff.forgotHint")}</p>
          <label className={styles.field}>
            <span>{t("staff.email")}</span>
            <input
              className={styles.input}
              name="email"
              type="email"
              dir="ltr"
              autoComplete="email"
              required
              disabled={busy}
              aria-describedby={problem === null ? undefined : "forgot-problem"}
            />
          </label>
          {problem === null ? null : (
            <p id="forgot-problem" role="alert" className={styles.alert}>
              {problem}
            </p>
          )}
          <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
            {t("staff.sendLink")}
          </button>
        </form>
      )}
      <a className={styles.textLink} href={`/${language}/sign-in`}>
        {t("staff.backToSignIn")}
      </a>
    </section>
  );
}
