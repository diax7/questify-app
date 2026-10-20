"use client";

import { toWesternDigits, type Language, type MessageKey } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isolate, translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { RESEND_SPACING_SECONDS, describeProblem, formatWait } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

/** Seconds until another code may be asked for, counted down once a second. */
function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(RESEND_SPACING_SECONDS);
  useEffect(() => {
    if (left <= 0) {
      return undefined;
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return [left, setLeft];
}

/** Where the code and its resend go: staff sign-in by default, or the organizer sign-up. */
export type CodePaths = Readonly<{ code: string; resend: string }>;

const SIGN_IN_PATHS: CodePaths = { code: "/v1/staff/auth/code", resend: "/v1/staff/auth/resend" };
export const SIGN_UP_PATHS: CodePaths = {
  code: "/v1/staff/auth/sign-up/code",
  resend: "/v1/staff/auth/sign-up/resend",
};

/**
 * Step 2: the six-digit code from the email. Arabic-Indic digits typed on an Arabic keyboard become 0-9. After a right
 * code the person goes home, unless the page has something to finish first (accepting an invite).
 */
export function CodeStep({
  language,
  email,
  challengeToken,
  onRestart,
  paths = SIGN_IN_PATHS,
  submitLabel = "staff.signIn",
  onSignedIn,
}: Readonly<{
  language: Language;
  email: string;
  challengeToken: string;
  onRestart: (reason: string) => void;
  paths?: CodePaths;
  submitLabel?: MessageKey;
  onSignedIn?: () => Promise<void>;
}>) {
  const t = translatorFor(language);
  const field = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wait, setWait] = useCountdown();

  useEffect(() => field.current?.focus(), []);

  const fail = (body: unknown): void => {
    const described = describeProblem(body, language, t);
    if (described.resendWaitSeconds !== undefined) {
      setWait(described.resendWaitSeconds);
    }
    if (described.restart) {
      onRestart(described.text);
    } else {
      setProblem(described.text);
      field.current?.focus();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await postJson(paths.code, { challengeToken, code });
    if (result.ok) {
      if (onSignedIn === undefined) {
        window.location.assign(`/${language}`);
      } else {
        await onSignedIn();
      }
      return;
    }
    setBusy(false);
    fail(result.body);
  };

  const resend = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const result = await postJson(paths.resend, { challengeToken });
    setBusy(false);
    if (result.ok) {
      setNotice(t("staff.resent"));
      setWait(RESEND_SPACING_SECONDS);
      return;
    }
    fail(result.body);
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h1 id="sign-in-title" className={styles.title}>
        {t("staff.codeTitle")}
      </h1>
      <p className={styles.muted}>{t("staff.codeSent", { email: isolate(email) })}</p>
      <label className={styles.field}>
        <span>{t("staff.code")}</span>
        <input
          ref={field}
          className={`${styles.input} ${styles.code}`}
          name="code"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(toWesternDigits(event.target.value).replace(/[^0-9]/g, ""))}
          disabled={busy}
          aria-describedby={problem === null ? undefined : "code-problem"}
        />
      </label>
      {problem === null ? null : (
        <p id="code-problem" role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <button
        type="submit"
        className={styles.button}
        disabled={busy || code.length !== 6}
        aria-busy={busy}
      >
        {t(submitLabel)}
      </button>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => void resend()}
          disabled={busy || wait > 0}
        >
          {wait > 0 ? t("staff.resendIn", { time: formatWait(wait) }) : t("staff.resend")}
        </button>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => onRestart("")}
          disabled={busy}
        >
          {t("staff.otherAccount")}
        </button>
      </div>
    </form>
  );
}
