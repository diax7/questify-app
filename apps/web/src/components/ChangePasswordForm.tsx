"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { NewPasswordFields, readNewPassword } from "#src/components/NewPasswordFields.tsx";
import { PasswordInput } from "#src/components/PasswordInput.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Form } from "#src/ui/Field.tsx";
import { Section } from "#src/ui/Section.tsx";

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
    <Section title={t("staff.changePassword")} titleId="change-title">
      {changed ? (
        <Notice tone="success" role="status">
          {t("staff.passwordChanged")}
        </Notice>
      ) : null}
      <Form onSubmit={(event) => void submit(event)}>
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
          <Notice id="change-problem" tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {t("staff.savePassword")}
        </Button>
      </Form>
    </Section>
  );
}
