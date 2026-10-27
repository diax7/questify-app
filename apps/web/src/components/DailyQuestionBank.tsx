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
import styles from "#src/components/layout.module.css";

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
          <div key={String(index)} className={styles.formCard}>
            <label className={styles.field}>
              {t("console.daily.field.optionAr", { n })}
              <input
                className={styles.input}
                dir="rtl"
                lang="ar"
                maxLength={120}
                value={option.ar}
                disabled={busy}
                onChange={(event) => set(index, "ar", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t("console.daily.field.optionEn", { n })}
              <input
                className={styles.input}
                dir="ltr"
                lang="en"
                maxLength={120}
                value={option.en}
                disabled={busy}
                onChange={(event) => set(index, "en", event.target.value)}
              />
            </label>
            {draft.options.length > MIN_OPTIONS ? (
              <button
                type="button"
                className={styles.quiet}
                disabled={busy}
                onClick={() => {
                  const kept = draft.options.filter((_, place) => place !== index);
                  const answer = Math.min(Number(draft.answer), kept.length);
                  change({ options: kept, answer: String(answer) });
                }}
              >
                {t("console.daily.removeOption", { n })}
              </button>
            ) : null}
          </div>
        );
      })}
      {draft.options.length < MAX_OPTIONS ? (
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => change({ options: [...draft.options, { ar: "", en: "" }] })}
        >
          {t("console.daily.addOption")}
        </button>
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
    <form className={styles.formCard} onSubmit={submit} data-testid="daily-question-form">
      <label className={styles.field}>
        {t("console.daily.field.promptAr")}
        <input
          className={styles.input}
          dir="rtl"
          lang="ar"
          maxLength={300}
          value={draft.promptAr}
          disabled={busy}
          onChange={(event) => change({ promptAr: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        {t("console.daily.field.promptEn")}
        <input
          className={styles.input}
          dir="ltr"
          lang="en"
          maxLength={300}
          value={draft.promptEn}
          disabled={busy}
          onChange={(event) => change({ promptEn: event.target.value })}
        />
      </label>
      <OptionFields language={language} draft={draft} busy={busy} change={change} />
      <label className={styles.field}>
        {t("console.daily.field.answer")}
        <select
          className={styles.input}
          value={draft.answer}
          disabled={busy}
          onChange={(event) => change({ answer: event.target.value })}
        >
          {draft.options.map((_, index) => (
            <option key={String(index)} value={String(index + 1)}>
              {t("console.daily.optionN", { n: formatNumber(index + 1, language) })}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("console.daily.saveQuestion")}
        </button>
      </div>
    </form>
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
    <li className={styles.formCard} data-testid="daily-question">
      <p className={styles.row}>
        <strong dir="auto">{textIn(question.prompt, language)}</strong>
        <span className={styles.badge}>{t(`console.daily.status.${question.status}`)}</span>
      </p>
      <ol>
        {question.options.map((option, index) => (
          <li key={String(index)} dir="auto">
            {textIn(option, language)}
            {index + 1 === question.answer ? ` (${t("console.daily.rightAnswer")})` : ""}
          </li>
        ))}
      </ol>
      {scheduled === null ? null : (
        <p className={styles.muted}>
          {t("console.daily.scheduledFor", { date: formatDay(scheduled, language) })}
        </p>
      )}
      {question.status === "retired" || frozen ? null : (
        <div className={styles.actions}>
          <button type="button" className={styles.quiet} disabled={busy} onClick={edit}>
            {t("console.daily.edit")}
          </button>
          {scheduled === null ? (
            <button type="button" className={styles.quiet} disabled={busy} onClick={retire}>
              {t("console.daily.retire")}
            </button>
          ) : null}
        </div>
      )}
    </li>
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
    <section aria-labelledby="daily-bank" className={styles.stack}>
      <h2 id="daily-bank" className={styles.subtitle}>
        {t("console.daily.bank")}
      </h2>
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
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={state.busy}
            onClick={() => setEditing({ id: null, draft: BLANK_QUESTION })}
          >
            {t("console.daily.newQuestion")}
          </button>
        </div>
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
      {questions.length === 0 ? (
        <p className={styles.muted}>{t("console.daily.noQuestions")}</p>
      ) : null}
      <ul className={styles.list}>
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
      </ul>
    </section>
  );
}
