"use client";

import { toLocalInput, type Language } from "@questify/shared";
import { useRef, useState, type FormEvent } from "react";
import { nameFor, type EventView } from "#src/lib/events.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const FIELDS = new Set(["name", "startsAt", "endsAt"]);

type Draft = Readonly<{ nameAr: string; nameEn: string; startsAt: string; endsAt: string }>;

const marked = (language: Language, name: string | null): string =>
  name === null ? "" : translatorFor(language)("events.copyOf", { name });

/** The copy starts with the source's name marked as a copy, in each language the source has one; its times are the source's. */
function draftOf(event: EventView): Draft {
  return {
    nameAr: marked("ar", event.name.ar),
    nameEn: marked("en", event.name.en),
    startsAt: toLocalInput(new Date(event.startsAt), event.timezone),
    endsAt: toLocalInput(new Date(event.endsAt), event.timezone),
  };
}

/** The field to fix for `invalid_event`, the API's own message otherwise. */
function problemText(body: unknown, language: Language, t: Translate): string {
  const field = (body as { details?: { field?: unknown } } | undefined)?.details?.field;
  if (errorCodeOf(body) === "invalid_event" && typeof field === "string" && FIELDS.has(field)) {
    return t(`events.invalid.${field}` as "events.invalid.name");
  }
  return describeProblem(body, language, t).text;
}

/** The new name in both languages and the new times, each field named by its label. */
function DuplicateFields({
  language,
  draft,
  busy,
  change,
}: Readonly<{
  language: Language;
  draft: Draft;
  busy: boolean;
  change: (patch: Partial<Draft>) => void;
}>) {
  const t = translatorFor(language);
  return (
    <>
      <FieldGroup layout="columns">
        <Field label={t("events.field.nameAr")}>
          <Input
            dir="rtl"
            lang="ar"
            maxLength={120}
            value={draft.nameAr}
            disabled={busy}
            onChange={(changed) => change({ nameAr: changed.target.value })}
          />
        </Field>
        <Field label={t("events.field.nameEn")}>
          <Input
            dir="ltr"
            lang="en"
            maxLength={120}
            value={draft.nameEn}
            disabled={busy}
            onChange={(changed) => change({ nameEn: changed.target.value })}
          />
        </Field>
      </FieldGroup>
      <FieldGroup layout="columns">
        <Field label={t("events.field.startsAt")}>
          <Input
            type="datetime-local"
            dir="ltr"
            required
            value={draft.startsAt}
            disabled={busy}
            onChange={(changed) => change({ startsAt: changed.target.value })}
          />
        </Field>
        <Field label={t("events.field.endsAt")}>
          <Input
            type="datetime-local"
            dir="ltr"
            required
            value={draft.endsAt}
            disabled={busy}
            onChange={(changed) => change({ endsAt: changed.target.value })}
          />
        </Field>
      </FieldGroup>
    </>
  );
}

/**
 * Duplicates an event into a new draft (FR-1016): the name and times are asked for here, the rest of the setup is the
 * source's, and the copy never holds a player, a point, a prize handed over or a code. One Idempotency-Key per distinct
 * body, so a double click makes one copy.
 */
export function DuplicateEvent({
  language,
  organizerId,
  event,
}: Readonly<{ language: Language; organizerId: string; event: EventView }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(event));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sent = useRef<{ body: string; key: string } | null>(null);

  const start = () => {
    setDraft(draftOf(event));
    setProblem(null);
    setOpen(true);
  };
  const submit = async (submitted: FormEvent<HTMLFormElement>) => {
    submitted.preventDefault();
    const body = {
      name: { ar: draft.nameAr, en: draft.nameEn },
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
    };
    const text = JSON.stringify(body);
    if (sent.current?.body !== text) {
      sent.current = { body: text, key: crypto.randomUUID() };
    }
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "POST",
      `/v1/organizers/${organizerId}/events/${event.id}/duplicate`,
      body,
      { "idempotency-key": sent.current.key },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
    } else if (result.ok) {
      const made = (result.body as { event: EventView }).event;
      window.location.assign(`/${language}/organizers/${organizerId}/events/${made.id}`);
    } else {
      setProblem(problemText(result.body, language, t));
    }
  };
  const change = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const name = nameFor(event, language);
  const formId = `duplicate-${event.id}`;

  return (
    <>
      <IconButton
        icon="copy"
        label={t("events.duplicateNamed", { name })}
        onClick={start}
        disabled={busy}
      />
      {open ? (
        <Dialog
          role="dialog"
          titleId={`${formId}-title`}
          title={t("events.duplicateNamed", { name })}
          busy={busy}
          cancel={() => setOpen(false)}
          actions={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" form={formId} variant="primary" disabled={busy}>
                {t("events.duplicate")}
              </Button>
            </>
          }
        >
          {problem === null ? null : (
            <Notice tone="danger" role="alert">
              {problem}
            </Notice>
          )}
          <Form id={formId} onSubmit={(submitted) => void submit(submitted)}>
            <DuplicateFields language={language} draft={draft} busy={busy} change={change} />
          </Form>
        </Dialog>
      ) : null}
    </>
  );
}
