"use client";

import { formatNumber, type AdminDailyQuestion, type Language } from "@questify/shared";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { formatDay, hasStarted, textIn } from "#src/lib/console-daily.ts";
import {
  BLANK_QUESTION,
  MAX_OPTIONS,
  MIN_OPTIONS,
  questionBodyOf,
  questionDraftOf,
  type QuestionDraft,
} from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import type { DailyConsoleState } from "#src/lib/use-daily-console.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Select } from "#src/ui/Field.tsx";
import { Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

type Editing = Readonly<{ id: string | null; draft: QuestionDraft }>;

function OptionFields({
  language,
  draft,
  busy,
  change,
}: Readonly<{
  language: Language;
  draft: QuestionDraft;
  busy: boolean;
  change: (patch: Partial<QuestionDraft>) => void;
}>) {
  const t = translatorFor(language);
  const set = (index: number, part: "ar" | "en", value: string) =>
    change({
      options: draft.options.map((option, place) =>
        place === index ? { ...option, [part]: value } : option,
      ),
    });
  return (
    <>
      {draft.options.map((option, index) => {
        const n = formatNumber(index + 1, language);
        return (
          <Card key={String(index)}>
            <Field label={t("console.daily.field.optionAr", { n })}>
              <Input
                dir="rtl"
                lang="ar"
                maxLength={120}
                value={option.ar}
                disabled={busy}
                onChange={(event) => set(index, "ar", event.target.value)}
              />
            </Field>
            <Field label={t("console.daily.field.optionEn", { n })}>
              <Input
                dir="ltr"
                lang="en"
                maxLength={120}
                value={option.en}
                disabled={busy}
                onChange={(event) => set(index, "en", event.target.value)}
              />
            </Field>
            {draft.options.length > MIN_OPTIONS ? (
              <Button
                variant="quiet"
                disabled={busy}
                onClick={() => {
                  const kept = draft.options.filter((_, place) => place !== index);
                  const answer = Math.min(Number(draft.answer), kept.length);
                  change({ options: kept, answer: String(answer) });
                }}
              >
                {t("console.daily.removeOption", { n })}
              </Button>
            ) : null}
          </Card>
        );
      })}
      {draft.options.length < MAX_OPTIONS ? (
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => change({ options: [...draft.options, { ar: "", en: "" }] })}
        >
          {t("console.daily.addOption")}
        </Button>
      ) : null}
    </>
  );
}

function QuestionForm({
  language,
  draft,
  busy,
  change,
  cancel,
  submit,
}: Readonly<{
  language: Language;
  draft: QuestionDraft;
  busy: boolean;
  change: (patch: Partial<QuestionDraft>) => void;
  cancel: () => void;
  submit: (event: FormEvent) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Form card onSubmit={submit} data-testid="daily-question-form">
      <Field label={t("console.daily.field.promptAr")}>
        <Input
          dir="rtl"
          lang="ar"
          maxLength={300}
          value={draft.promptAr}
          disabled={busy}
          onChange={(event) => change({ promptAr: event.target.value })}
        />
      </Field>
      <Field label={t("console.daily.field.promptEn")}>
        <Input
          dir="ltr"
          lang="en"
          maxLength={300}
          value={draft.promptEn}
          disabled={busy}
          onChange={(event) => change({ promptEn: event.target.value })}
        />
      </Field>
      <OptionFields language={language} draft={draft} busy={busy} change={change} />
      <Field label={t("console.daily.field.answer")}>
        <Select
          value={draft.answer}
          disabled={busy}
          onChange={(event) => change({ answer: event.target.value })}
        >
          {draft.options.map((_, index) => (
            <option key={String(index)} value={String(index + 1)}>
              {t("console.daily.optionN", { n: formatNumber(index + 1, language) })}
            </option>
          ))}
        </Select>
      </Field>
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("console.daily.saveQuestion")}
        </Button>
      </Toolbar>
    </Form>
  );
}

function QuestionRow({
  language,
  question,
  today,
  busy,
  edit,
  retire,
}: Readonly<{
  language: Language;
  question: AdminDailyQuestion;
  today: string;
  busy: boolean;
  edit: () => void;
  retire: () => void;
}>) {
  const t = translatorFor(language);
  const scheduled = question.scheduledOn;
  const frozen = scheduled !== null && hasStarted(scheduled, today);
  return (
    <Card as="li" data-testid="daily-question">
      <Toolbar>
        <strong dir="auto">{textIn(question.prompt, language)}</strong>
        <Badge>{t(`console.daily.status.${question.status}`)}</Badge>
      </Toolbar>
      <ol>
        {question.options.map((option, index) => (
          <li key={String(index)} dir="auto">
            {textIn(option, language)}
            {index + 1 === question.answer ? ` (${t("console.daily.rightAnswer")})` : ""}
          </li>
        ))}
      </ol>
      {scheduled === null ? null : (
        <Muted>{t("console.daily.scheduledFor", { date: formatDay(scheduled, language) })}</Muted>
      )}
      {question.status === "retired" || frozen ? null : (
        <Toolbar>
          <Button variant="quiet" disabled={busy} onClick={edit}>
            {t("console.daily.edit")}
          </Button>
          {scheduled === null ? (
            <Button variant="quiet" disabled={busy} onClick={retire}>
              {t("console.daily.retire")}
            </Button>
          ) : null}
        </Toolbar>
      )}
    </Card>
  );
}

/** The question bank (FR-1733): both languages, two to four options, the right one chosen; retired for good. */
export function DailyQuestionBank({
  language,
  state,
  questions,
}: Readonly<{
  language: Language;
  state: DailyConsoleState;
  questions: readonly AdminDailyQuestion[];
}>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [retiring, setRetiring] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) {
      return;
    }
    const checked = questionBodyOf(editing.draft);
    if (!checked.ok) {
      state.setProblem(t(`console.daily.invalid.${checked.field}`));
      return;
    }
    const done = await state.write({
      method: editing.id === null ? "POST" : "PUT",
      path: editing.id === null ? "/questions" : `/questions/${editing.id}`,
      body: checked.body,
      done: t("console.daily.questionSaved"),
    });
    if (done !== null) {
      setEditing(null);
    }
  };
  const retire = async (id: string) => {
    await state.write({
      method: "POST",
      path: `/questions/${id}/retire`,
      done: t("console.daily.questionRetired"),
    });
    setRetiring(null);
  };
  return (
    <Stack as="section" aria-labelledby="daily-bank">
      <SubHeading as="h2" id="daily-bank">
        {t("console.daily.bank")}
      </SubHeading>
      {retiring === null ? null : (
        <ConfirmDialog
          language={language}
          title={t("console.daily.retireTitle")}
          body={t("console.daily.retireBody")}
          confirmLabel={t("console.daily.retire")}
          noteLabel={null}
          busy={state.busy}
          cancel={() => setRetiring(null)}
          confirm={() => void retire(retiring)}
        />
      )}
      {editing === null ? (
        <Toolbar>
          <Button
            variant="primary"
            disabled={state.busy}
            onClick={() => setEditing({ id: null, draft: BLANK_QUESTION })}
          >
            {t("console.daily.newQuestion")}
          </Button>
        </Toolbar>
      ) : (
        <QuestionForm
          language={language}
          draft={editing.draft}
          busy={state.busy}
          change={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
          cancel={() => setEditing(null)}
          submit={(event) => void save(event)}
        />
      )}
      {questions.length === 0 ? <Muted>{t("console.daily.noQuestions")}</Muted> : null}
      <CardList>
        {questions.map((question) => (
          <QuestionRow
            key={question.id}
            language={language}
            question={question}
            today={state.today}
            busy={state.busy}
            edit={() => setEditing({ id: question.id, draft: questionDraftOf(question) })}
            retire={() => setRetiring(question.id)}
          />
        ))}
      </CardList>
    </Stack>
  );
}
