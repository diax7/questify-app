"use client";

import { toWesternDigits, type Language, type MessageKey } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isolate, translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { RESEND_SPACING_SECONDS, describeProblem, formatWait } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, codeInputClass } from "#src/ui/Field.tsx";
import { Toolbar } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";

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
    <Form onSubmit={(event) => void submit(event)}>
      <PageHeader
        titleId="sign-in-title"
        title={t("staff.codeTitle")}
        description={t("staff.codeSent", { email: isolate(email) })}
      />
      <Field label={t("staff.code")}>
        <Input
          ref={field}
          className={codeInputClass}
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
      </Field>
      {problem === null ? null : (
        <Notice id="code-problem" role="alert" tone="danger">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice role="status" tone="success">
          {notice}
        </Notice>
      )}
      <Button type="submit" variant="primary" disabled={busy || code.length !== 6} aria-busy={busy}>
        {t(submitLabel)}
      </Button>
      <Toolbar align="between">
        <Button variant="quiet" onClick={() => void resend()} disabled={busy || wait > 0}>
          {wait > 0 ? t("staff.resendIn", { time: formatWait(wait) }) : t("staff.resend")}
        </Button>
        <Button variant="quiet" onClick={() => onRestart("")} disabled={busy}>
          {t("staff.otherAccount")}
        </Button>
      </Toolbar>
    </Form>
  );
}
