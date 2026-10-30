"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { AcceptanceFields, acceptedFrom } from "#src/components/AcceptanceFields.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";

/**
 * A signed-in person creates another organizer they own. One Idempotency-Key per page view, so a double click or a
 * retry after a dropped connection never makes two organizers.
 */
export function NewOrganizerForm({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [key] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "POST",
      "/v1/staff/organizers",
      { name: String(form.get("name") ?? ""), accept: acceptedFrom(form) },
      { "idempotency-key": key },
    );
    if (result.ok) {
      window.location.assign(`/${language}`);
      return;
    }
    setBusy(false);
    setProblem(describeProblem(result.body, language, t).text);
  };

  return (
    <Card as="section" aria-labelledby="new-organizer-title">
      <Form onSubmit={(event) => void submit(event)}>
        <PageHeader titleId="new-organizer-title" title={t("staff.newOrganizer")} />
        <Field label={t("staff.organizerName")} help={t("staff.organizerNameHint")}>
          <Input
            name="name"
            autoComplete="organization"
            minLength={2}
            maxLength={80}
            required
            disabled={busy}
          />
        </Field>
        <AcceptanceFields language={language} disabled={busy} />
        {problem === null ? null : (
          <Notice tone="danger" role="alert">
            {problem}
          </Notice>
        )}
        <Button type="submit" variant="primary" disabled={busy} aria-busy={busy}>
          {t("staff.create")}
        </Button>
      </Form>
    </Card>
  );
}
