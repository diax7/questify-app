"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { NewPasswordFields, readNewPassword } from "#src/components/NewPasswordFields.tsx";
import { PasswordInput } from "#src/components/PasswordInput.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** Changes the password of the person signed in. Their other sessions end; this one stays. */
export function ChangePasswordForm({
  language,
  email,
}: Readonly<{ language: Language; email: string }>) {
  const t = translatorFor(language);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = readNewPassword(data);
    if (newPassword === undefined) {
      setProblem(t("staff.passwordsDiffer"));
      return;
    }
    setBusy(true);
    setProblem(null);
    setChanged(false);
    const result = await postJson("/v1/staff/password", {
      currentPassword: String(data.get("currentPassword") ?? ""),
      newPassword,
    });
    setBusy(false);
    if (result.ok) {
      form.reset();
      setChanged(true);
      return;
    }
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  return (
    <section className={styles.panel} aria-labelledby="change-title">
      <h2 id="change-title" className={styles.subtitle}>
        {t("staff.changePassword")}
      </h2>
      {changed ? (
        <p role="status" className={styles.notice}>
          {t("staff.passwordChanged")}
        </p>
      ) : null}
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        {/* Lets a password manager file the new password under the right account. */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        <PasswordInput
          language={language}
          name="currentPassword"
          label={t("staff.currentPassword")}
          autoComplete="current-password"
          disabled={busy}
          describedBy={problem === null ? undefined : "change-problem"}
        />
        <NewPasswordFields
          language={language}
          disabled={busy}
          problemId={problem === null ? undefined : "change-problem"}
        />
        {problem === null ? null : (
          <p id="change-problem" role="alert" className={styles.alert}>
            {problem}
          </p>
        )}
        <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
          {t("staff.savePassword")}
        </button>
      </form>
    </section>
  );
}
