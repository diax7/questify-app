"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { AcceptanceFields, acceptedFrom } from "#src/components/AcceptanceFields.tsx";
import { CodeStep, SIGN_UP_PATHS } from "#src/components/CodeStep.tsx";
import { NewPasswordFields, readNewPassword } from "#src/components/NewPasswordFields.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { postJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Step =
  | Readonly<{ kind: "form" }>
  | Readonly<{ kind: "code"; email: string; challengeToken: string }>;

/**
 * Organizer sign-up (FR-1401): email, password, the organizer's name and the three acceptances, then the emailed
 * code. The challenge token lives only here, in memory.
 */
export function SignUpForm({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = readNewPassword(form);
    if (password === undefined) {
      setProblem(t("staff.passwordsDiffer"));
      return;
    }
    const email = String(form.get("email") ?? "").trim();
    setBusy(true);
    setProblem(null);
    const result = await postJson("/v1/staff/auth/sign-up", {
      email,
      password,
      organizerName: String(form.get("organizerName") ?? ""),
      accept: acceptedFrom(form),
    });
    setBusy(false);
    const body = result.body as { challengeToken?: unknown } | undefined;
    if (result.ok && typeof body?.challengeToken === "string") {
      setStep({ kind: "code", email, challengeToken: body.challengeToken });
      return;
    }
    setProblem(describeProblem(result.body, language, t).text);
  };

  if (step.kind === "code") {
    return (
      <Card as="section" aria-labelledby="sign-in-title">
        <CodeStep
          language={language}
          email={step.email}
          challengeToken={step.challengeToken}
          paths={SIGN_UP_PATHS}
          submitLabel="staff.createAccount"
          onRestart={(reason) => {
            setProblem(reason === "" ? null : reason);
            setStep({ kind: "form" });
          }}
        />
      </Card>
    );
  }

  return (
    <Card as="section" aria-labelledby="sign-up-title">
      <Form onSubmit={(event) => void submit(event)}>
        <PageHeader titleId="sign-up-title" title={t("staff.signUpTitle")} />
        <Field label={t("staff.organizerName")} help={t("staff.organizerNameHint")}>
          <Input
            name="organizerName"
            autoComplete="organization"
            minLength={2}
            maxLength={80}
            required
            disabled={busy}
          />
        </Field>
        <Field label={t("staff.email")}>
          <Input
            name="email"
            type="email"
            dir="ltr"
            autoComplete="email"
            required
            disabled={busy}
          />
        </Field>
        <NewPasswordFields
          language={language}
          disabled={busy}
          problemId={problem === null ? undefined : "sign-up-problem"}
        />
        <AcceptanceFields language={language} disabled={busy} />
        {problem === null ? null : (
          <Notice id="sign-up-problem" tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {t("staff.createAccount")}
        </Button>
        <TextLink href={`/${language}/sign-in`}>{t("staff.signInLink")}</TextLink>
      </Form>
    </Card>
  );
}
