"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

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
    <Card as="section" aria-labelledby="forgot-title">
      <PageHeader titleId="forgot-title" title={t("staff.forgotTitle")} />
      {sent ? (
        <Notice tone="success" role="status">
          {t("staff.linkSent")}
        </Notice>
      ) : (
        <Form onSubmit={(event) => void submit(event)}>
          <Field label={t("staff.email")}>
            <Input
              name="email"
              type="email"
              dir="ltr"
              autoComplete="email"
              required
              disabled={busy}
              aria-describedby={problem === null ? undefined : "forgot-problem"}
            />
          </Field>
          {problem === null ? null : (
            <Notice id="forgot-problem" tone="danger" role="alert">
              {problem}
            </Notice>
          )}
          <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
            {t("staff.sendLink")}
          </Button>
        </Form>
      )}
      <TextLink href={`/${language}/sign-in`}>{t("staff.backToSignIn")}</TextLink>
    </Card>
  );
}
