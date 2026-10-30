"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { AppLink } from "#src/ui/AppLink.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Toolbar } from "#src/ui/Section.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";

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

  const describedBy = problem === null ? undefined : "password-problem";
  return (
    <Form onSubmit={(event) => void submit(event)} noValidate={false}>
      <PageHeader titleId="sign-in-title" title={t("staff.signIn")} />
      <Field label={t("staff.email")}>
        <Input
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          required
          disabled={busy}
          aria-describedby={describedBy}
        />
      </Field>
      <Field label={t("staff.password")}>
        <Input
          name="password"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          required
          disabled={busy}
          aria-describedby={describedBy}
        />
      </Field>
      {problem === null ? null : (
        <Notice id="password-problem" role="alert" tone="danger">
          {problem}
        </Notice>
      )}
      <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
        {t("common.continue")}
      </Button>
      <Toolbar align="between">
        <AppLink href={`/${language}/forgot-password`}>{t("staff.forgotPassword")}</AppLink>
        <AppLink href={`/${language}/sign-up`}>{t("staff.signUpLink")}</AppLink>
      </Toolbar>
    </Form>
  );
}
