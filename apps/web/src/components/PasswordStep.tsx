"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Step 1: email and password. On success the API emails a code and answers with the challenge token. */
export function PasswordStep({
  language,
  onCodeSent,
}: Readonly<{ language: Language; onCodeSent: (email: string, challengeToken: string) => void }>) {
  const t = translatorFor(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setProblem(null);
    const result = await postJson("/v1/staff/auth/password", { email, password });
    setBusy(false);
    const token = isRecord(result.body) ? result.body["challengeToken"] : undefined;
    if (result.ok && typeof token === "string") {
      onCodeSent(email, token);
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate={false}>
      <h1 id="sign-in-title" className={styles.title}>
        {t("staff.signIn")}
      </h1>
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
          aria-describedby={problem === null ? undefined : "password-problem"}
        />
      </label>
      <label className={styles.field}>
        <span>{t("staff.password")}</span>
        <input
          className={styles.input}
          name="password"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          required
          disabled={busy}
          aria-describedby={problem === null ? undefined : "password-problem"}
        />
      </label>
      {problem === null ? null : (
        <p id="password-problem" role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
        {t("common.continue")}
      </button>
      <a className={styles.textLink} href={`/${language}/forgot-password`}>
        {t("staff.forgotPassword")}
      </a>
    </form>
  );
}
