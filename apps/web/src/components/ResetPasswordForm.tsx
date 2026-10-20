"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { NewPasswordFields, readNewPassword } from "#src/components/NewPasswordFields.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const TOKEN_IN_FRAGMENT = /(?:^#|&)token=([A-Za-z0-9_-]{43})(?:&|$)/;

/**
 * The link's token is read from the URL fragment once, kept in memory only, and removed from the address bar at
 * once, so it is not left in history or shown on screen. A refresh therefore asks for the email link again.
 */
type State =
  | Readonly<{ kind: "reading" }>
  | Readonly<{ kind: "ready"; token: string }>
  | Readonly<{ kind: "no_link"; message: string | null }>
  | Readonly<{ kind: "done" }>;

export function ResetPasswordForm({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [state, setState] = useState<State>({ kind: "reading" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Read once per page: React runs effects twice in development (Strict Mode), and the second run would find the
  // fragment already removed. A ref keeps what the first run read.
  const taken = useRef<{ token: string | undefined } | null>(null);

  useEffect(() => {
    if (taken.current === null) {
      taken.current = { token: TOKEN_IN_FRAGMENT.exec(window.location.hash)?.[1] };
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const { token } = taken.current;
    setState(token === undefined ? { kind: "no_link", message: null } : { kind: "ready", token });
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>, token: string): Promise<void> => {
    event.preventDefault();
    const newPassword = readNewPassword(new FormData(event.currentTarget));
    if (newPassword === undefined) {
      setProblem(t("staff.passwordsDiffer"));
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await postJson("/v1/staff/auth/reset/confirm", { token, newPassword });
    setBusy(false);
    if (result.ok) {
      setState({ kind: "done" });
      return;
    }
    const described = describeProblem(result.body, language, t).text;
    const code = errorCodeOf(result.body);
    if (code === "reset_link_invalid") {
      setState({ kind: "no_link", message: described });
      return;
    }
    setProblem(described);
  };

  return (
    <section className={styles.panel} aria-labelledby="reset-title">
      <h1 id="reset-title" className={styles.title}>
        {t("staff.newPasswordTitle")}
      </h1>
      {state.kind === "done" ? (
        <>
          <p role="status" className={styles.notice}>
            {t("staff.passwordReset")}
          </p>
          <a className={styles.button} href={`/${language}/sign-in`}>
            {t("staff.signIn")}
          </a>
        </>
      ) : null}
      {state.kind === "no_link" ? (
        <>
          <p role="alert" className={styles.alert}>
            {state.message ?? t("staff.linkMissing")}
          </p>
          <a className={styles.button} href={`/${language}/forgot-password`}>
            {t("staff.requestNewLink")}
          </a>
        </>
      ) : null}
      {state.kind === "ready" ? (
        <form className={styles.form} onSubmit={(event) => void submit(event, state.token)}>
          <NewPasswordFields
            language={language}
            disabled={busy}
            problemId={problem === null ? undefined : "reset-problem"}
          />
          {problem === null ? null : (
            <p id="reset-problem" role="alert" className={styles.alert}>
              {problem}
            </p>
          )}
          <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
            {t("staff.savePassword")}
          </button>
        </form>
      ) : null}
      {state.kind === "reading" ? <p className={styles.muted}>{t("common.loading")}</p> : null}
    </section>
  );
}
