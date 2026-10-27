"use client";

import {
  DAILY_LANGUAGES,
  formatNumber,
  type DailyConsole,
  type DailyLanguage,
  type Language,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { LANGUAGE_NAME_KEY, formatPeriod, hasStarted } from "#src/lib/console-daily.ts";
import { wordBodyOf } from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import type { DailyConsoleState } from "#src/lib/use-daily-console.ts";
import styles from "#src/components/layout.module.css";

type Period = DailyConsole["periods"][number];
type Editing = Readonly<{ startsOn: string; language: DailyLanguage; text: string }>;

function WordForm({
  language,
  wordLanguage,
  text,
  busy,
  change,
  cancel,
  submit,
}: Readonly<{
  language: Language;
  wordLanguage: DailyLanguage;
  text: string;
  busy: boolean;
  change: (text: string) => void;
  cancel: () => void;
  submit: (event: FormEvent) => void;
}>) {
  const t = translatorFor(language);
  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        {t("console.daily.wordField", { language: t(LANGUAGE_NAME_KEY[wordLanguage]) })}
        <input
          className={styles.input}
          dir={wordLanguage === "ar" ? "rtl" : "ltr"}
          lang={wordLanguage}
          maxLength={40}
          value={text}
          disabled={busy}
          onChange={(event) => change(event.target.value)}
        />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("console.daily.saveWord")}
        </button>
      </div>
    </form>
  );
}

type WordRowProps = Readonly<{
  language: Language;
  wordLanguage: DailyLanguage;
  period: Period;
  started: boolean;
  busy: boolean;
  edit: (text: string) => void;
  clear: () => void;
}>;

function WordActions({
  language,
  word,
  busy,
  edit,
  clear,
}: Readonly<{
  language: Language;
  word: string | null;
  busy: boolean;
  edit: (text: string) => void;
  clear: () => void;
}>) {
  const t = translatorFor(language);
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy}
        onClick={() => edit(word ?? "")}
      >
        {t(word === null ? "console.daily.setWord" : "console.daily.edit")}
      </button>
      {word === null ? null : (
        <button type="button" className={styles.quiet} disabled={busy} onClick={clear}>
          {t("console.daily.remove")}
        </button>
      )}
    </div>
  );
}

type ScheduledWord = NonNullable<NonNullable<Period["words"]>[DailyLanguage]>;

function WordText({
  language,
  wordLanguage,
  word,
}: Readonly<{ language: Language; wordLanguage: DailyLanguage; word: ScheduledWord | null }>) {
  const t = translatorFor(language);
  return (
    <>
      <p className={styles.row}>
        <span>{t(LANGUAGE_NAME_KEY[wordLanguage])}</span>
        {word === null ? (
          <span className={styles.muted}>{t("console.daily.noWord")}</span>
        ) : (
          <strong dir={wordLanguage === "ar" ? "rtl" : "ltr"} lang={wordLanguage}>
            {word.word}
          </strong>
        )}
      </p>
      {word === null || word.finishes === 0 ? null : (
        <p className={styles.muted}>
          {t("console.daily.finishes", { count: formatNumber(word.finishes, language) })}
        </p>
      )}
    </>
  );
}

function WordRow({ language, wordLanguage, period, started, busy, edit, clear }: WordRowProps) {
  const word = period.words?.[wordLanguage] ?? null;
  return (
    <div data-testid={`daily-word-${wordLanguage}`}>
      <WordText language={language} wordLanguage={wordLanguage} word={word} />
      {started ? null : (
        <WordActions
          language={language}
          word={word?.word ?? null}
          busy={busy}
          edit={edit}
          clear={clear}
        />
      )}
    </div>
  );
}

/** The daily words by period, one per language (FR-1811): the empty ones marked, one word form open at a time. */
export function DailyWords({
  language,
  state,
  view,
}: Readonly<{ language: Language; state: DailyConsoleState; view: DailyConsole }>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState<Editing | null>(null);
  const periods = view.periods.filter((period) => period.kind === "word");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) {
      return;
    }
    const checked = wordBodyOf(editing.language, editing.text);
    if (!checked.ok) {
      state.setProblem(t("console.daily.invalid.word"));
      return;
    }
    const done = await state.write({
      method: "PUT",
      path: `/words/${editing.language}/${editing.startsOn}`,
      body: checked.body,
      done: t("console.daily.wordSaved"),
    });
    if (done !== null) {
      setEditing(null);
    }
  };
  return (
    <section aria-labelledby="daily-words" className={styles.stack}>
      <h2 id="daily-words" className={styles.subtitle}>
        {t("console.daily.words")}
      </h2>
      <ul className={styles.list}>
        {periods.map((period) => {
          const started = hasStarted(period.startsOn, state.today);
          return (
            <li key={period.startsOn} className={styles.formCard} data-testid="daily-word-period">
              <p className={styles.row}>
                <strong>{formatPeriod(period.startsOn, period.endsOn, language)}</strong>
                {started ? (
                  <span className={styles.badge}>{t("console.daily.started")}</span>
                ) : null}
              </p>
              {DAILY_LANGUAGES.map((wordLanguage) =>
                editing?.startsOn === period.startsOn && editing.language === wordLanguage ? (
                  <WordForm
                    key={wordLanguage}
                    language={language}
                    wordLanguage={wordLanguage}
                    text={editing.text}
                    busy={state.busy}
                    change={(text) => setEditing({ ...editing, text })}
                    cancel={() => setEditing(null)}
                    submit={(event) => void save(event)}
                  />
                ) : (
                  <WordRow
                    key={wordLanguage}
                    language={language}
                    wordLanguage={wordLanguage}
                    period={period}
                    started={started}
                    busy={state.busy}
                    edit={(text) =>
                      setEditing({ startsOn: period.startsOn, language: wordLanguage, text })
                    }
                    clear={() =>
                      void state.write({
                        method: "DELETE",
                        path: `/words/${wordLanguage}/${period.startsOn}`,
                        done: t("console.daily.removed"),
                      })
                    }
                  />
                ),
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
