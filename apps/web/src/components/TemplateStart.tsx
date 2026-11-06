"use client";

import type { Language, TemplateView } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { TemplatePicker } from "#src/components/TemplatePicker.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Toolbar } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** Whether the quest builder's answer shows an event with no quest in any category: the only event a template may start. */
function hasNoQuests(body: unknown): boolean {
  const categories = (body as { categories?: { quests?: unknown[] }[] } | undefined)?.categories;
  return Array.isArray(categories) && categories.every((one) => (one.quests?.length ?? 0) === 0);
}

/** Whether the event has no quest yet, read once when the step opens. */
function useHasNoQuests(base: string): boolean {
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    let current = true;
    void requestJson("GET", `${base}/quests`).then((result) => {
      if (current) {
        setEmpty(result.ok && hasNoQuests(result.body));
      }
    });
    return () => {
      current = false;
    };
  }, [base]);
  return empty;
}

type Applying = Readonly<{
  busy: boolean;
  problem: string | null;
  /** The name of the template that was applied, once it was. */
  started: string | null;
  apply: (template: TemplateView) => Promise<boolean>;
  forget: () => void;
}>;

/** Applies a template to the event. One Idempotency-Key per template, so a double click fills the event once. */
function useApplyTemplate(language: Language, base: string, t: Translate): Applying {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const key = useRef<{ template: string; key: string } | null>(null);
  const apply = async (template: TemplateView): Promise<boolean> => {
    if (key.current?.template !== template.key) {
      key.current = { template: template.key, key: crypto.randomUUID() };
    }
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "POST",
      `${base}/template`,
      { template: template.key },
      { "idempotency-key": key.current.key },
    );
    setBusy(false);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
    } else if (result.ok) {
      setStarted(template.name[language]);
    } else {
      setProblem(describeProblem(result.body, language, t).text);
    }
    return result.ok;
  };
  return { busy, problem, started, apply, forget: () => setProblem(null) };
}

/** The confirmation before a template is applied: what is added, Cancel and the action; a refusal shows inside it. */
function TemplateConfirm({
  language,
  template,
  applying,
  cancel,
}: Readonly<{
  language: Language;
  template: TemplateView;
  applying: Applying;
  cancel: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <ConfirmDialog
      language={language}
      title={t("templates.confirm.title", { name: template.name[language] })}
      body={t("templates.confirm.body")}
      confirmLabel={t("templates.confirm.action")}
      noteLabel={null}
      busy={applying.busy}
      problem={applying.problem ?? undefined}
      cancel={cancel}
      confirm={() => void applying.apply(template)}
    />
  );
}

/**
 * "Start from" inside the guided setup's first step (FR-1015, FR-1752): while the draft has no quest, the same picker as the
 * new-event page, then a confirmation that names what is added. Skipping it leaves the event as it is, so the step keeps its
 * "empty" default. The picker shows only for a draft (a scheduled or live event would get `event_not_empty`); the API
 * refuses anything but an empty draft, so a template never replaces an organizer's work.
 */
export function TemplateStart({
  language,
  organizerId,
  eventId,
  draft,
}: Readonly<{ language: Language; organizerId: string; eventId: string; draft: boolean }>) {
  const t = useTranslator(language);
  const empty = useHasNoQuests(`/v1/organizers/${organizerId}/events/${eventId}`);
  const applying = useApplyTemplate(language, `/v1/organizers/${organizerId}/events/${eventId}`, t);
  const [chosen, setChosen] = useState<TemplateView | null>(null);
  const [asking, setAsking] = useState(false);

  if (applying.started !== null) {
    return (
      <Notice tone="success" role="status">
        {t("templates.done", { name: applying.started })}
      </Notice>
    );
  }
  if (!empty || !draft) {
    return null;
  }
  const stopAsking = () => {
    setAsking(false);
    applying.forget();
  };
  return (
    <>
      <TemplatePicker
        language={language}
        organizerId={organizerId}
        value={chosen?.key ?? null}
        onChange={setChosen}
        disabled={applying.busy}
      />
      <Toolbar align="end">
        <Button
          variant="primary"
          disabled={chosen === null || applying.busy}
          onClick={() => setAsking(true)}
        >
          {t("templates.use")}
        </Button>
      </Toolbar>
      {asking && chosen !== null ? (
        <TemplateConfirm
          language={language}
          template={chosen}
          applying={applying}
          cancel={stopAsking}
        />
      ) : null}
    </>
  );
}
