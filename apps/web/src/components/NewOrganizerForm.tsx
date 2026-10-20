"use client";

import type { Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { AcceptanceFields, acceptedFrom } from "#src/components/AcceptanceFields.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

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
    <section className={styles.panel} aria-labelledby="new-organizer-title">
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <h1 id="new-organizer-title" className={styles.title}>
          {t("staff.newOrganizer")}
        </h1>
        <label className={styles.field}>
          <span>{t("staff.organizerName")}</span>
          <input
            className={styles.input}
            name="name"
            autoComplete="organization"
            minLength={2}
            maxLength={80}
            required
            disabled={busy}
            aria-describedby="new-organizer-hint"
          />
        </label>
        <p id="new-organizer-hint" className={styles.muted}>
          {t("staff.organizerNameHint")}
        </p>
        <AcceptanceFields language={language} disabled={busy} />
        {problem === null ? null : (
          <p role="alert" className={styles.alert}>
            {problem}
          </p>
        )}
        <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
          {t("staff.create")}
        </button>
      </form>
    </section>
  );
}
