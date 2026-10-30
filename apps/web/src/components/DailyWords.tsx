"use client";

import {
  DAILY_LANGUAGES,
  formatNumber,
  type DailyConsole,
  type DailyLanguage,
  type Language,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { RemoveDialog } from "#src/components/DailyCommon.tsx";
import { LANGUAGE_NAME_KEY, formatPeriod, hasStarted } from "#src/lib/console-daily.ts";
import { wordBodyOf } from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import type { DailyConsoleState } from "#src/lib/use-daily-console.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

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
    <Form onSubmit={submit}>
      <Field label={t("console.daily.wordField", { language: t(LANGUAGE_NAME_KEY[wordLanguage]) })}>
        <Input
          dir={wordLanguage === "ar" ? "rtl" : "ltr"}
          lang={wordLanguage}
          maxLength={40}
          value={text}
          disabled={busy}
          onChange={(event) => change(event.target.value)}
        />
      </Field>
      <Toolbar>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("console.daily.saveWord")}
        </Button>
      </Toolbar>
    </Form>
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
    <Toolbar>
      <Button variant="quiet" disabled={busy} onClick={() => edit(word ?? "")}>
        {t(word === null ? "console.daily.setWord" : "console.daily.edit")}
      </Button>
      {word === null ? null : (
        <Button variant="quiet" disabled={busy} onClick={clear}>
          {t("console.daily.remove")}
        </Button>
      )}
    </Toolbar>
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
      <Toolbar>
        <span>{t(LANGUAGE_NAME_KEY[wordLanguage])}</span>
        {word === null ? (
          <Muted as="span">{t("console.daily.noWord")}</Muted>
        ) : (
          <strong dir={wordLanguage === "ar" ? "rtl" : "ltr"} lang={wordLanguage}>
            {word.word}
          </strong>
        )}
      </Toolbar>
      {word === null || word.finishes === 0 ? null : (
        <Muted>
          {t("console.daily.finishes", { count: formatNumber(word.finishes, language) })}
        </Muted>
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
  const [removing, setRemoving] = useState<string | null>(null);
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
    <Stack as="section" aria-labelledby="daily-words">
      <SubHeading as="h2" id="daily-words">
        {t("console.daily.words")}
      </SubHeading>
      {removing === null ? null : (
        <RemoveDialog
          language={language}
          path={removing}
          busy={state.busy}
          write={state.write}
          close={() => setRemoving(null)}
        />
      )}
      <CardList>
        {periods.map((period) => {
          const started = hasStarted(period.startsOn, state.today);
          return (
            <Card as="li" key={period.startsOn} data-testid="daily-word-period">
              <Toolbar>
                <strong>{formatPeriod(period.startsOn, period.endsOn, language)}</strong>
                {started ? <Badge>{t("console.daily.started")}</Badge> : null}
              </Toolbar>
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
                    clear={() => setRemoving(`/words/${wordLanguage}/${period.startsOn}`)}
                  />
                ),
              )}
            </Card>
          );
        })}
      </CardList>
    </Stack>
  );
}
