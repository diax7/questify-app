"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { DailyCadenceControl, DailyUnused, DailyWarnings } from "#src/components/DailyCommon.tsx";
import { DailyQuestionBank } from "#src/components/DailyQuestionBank.tsx";
import { DailySchedule } from "#src/components/DailySchedule.tsx";
import { DailyWordList } from "#src/components/DailyWordList.tsx";
import { DailyWords } from "#src/components/DailyWords.tsx";
import {
  API,
  hasWarning,
  questifyDayOf,
  readDailyConsole,
  warningsOf,
} from "#src/lib/console-daily.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useDailyConsole, type DailyConsoleState } from "#src/lib/use-daily-console.ts";
import styles from "#src/components/layout.module.css";

type Tab = "daily" | "words";

function ChallengeTab({
  language,
  state,
}: Readonly<{ language: Language; state: DailyConsoleState }>) {
  const { view, questions } = state;
  if (view === null || questions === null) {
    return null;
  }
  return (
    <>
      <DailyWarnings language={language} status={view.status} kind="challenge" />
      <DailyCadenceControl
        language={language}
        kind="challenge"
        state={view.status.challenge}
        busy={state.busy}
        write={state.write}
        setNotice={state.setNotice}
      />
      <DailySchedule language={language} state={state} view={view} questions={questions} />
      <DailyUnused
        language={language}
        kind="challenge"
        unused={view.unused}
        busy={state.busy}
        write={state.write}
      />
      <DailyQuestionBank language={language} state={state} questions={questions} />
    </>
  );
}

function WordsTab({ language, state }: Readonly<{ language: Language; state: DailyConsoleState }>) {
  const { view } = state;
  if (view === null) {
    return null;
  }
  return (
    <>
      <DailyWarnings language={language} status={view.status} kind="word" />
      <DailyCadenceControl
        language={language}
        kind="word"
        state={view.status.word}
        busy={state.busy}
        write={state.write}
        setNotice={state.setNotice}
      />
      <DailyWords language={language} state={state} view={view} />
      <DailyUnused
        language={language}
        kind="word"
        unused={view.unused}
        busy={state.busy}
        write={state.write}
      />
      <DailyWordList language={language} />
    </>
  );
}

/**
 * The console's Content page (T-406c, FR-732, FR-1733, FR-1811, FR-1814): the daily challenge's schedule, sponsor name
 * and question bank; the daily words and the guess list; the period of each. A tab shows a mark while its content
 * is running low. Every write carries an Idempotency-Key and the page reads again after it.
 */
export function ConsoleContent({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const state = useDailyConsole(language);
  const [tab, setTab] = useState<Tab>("daily");
  const warned = state.view === null ? [] : warningsOf(state.view.status);
  const needs = (kind: "challenge" | "word") => warned.some((warning) => warning.kind === kind);
  const tabs: ReadonlyArray<Readonly<{ id: Tab; kind: "challenge" | "word" }>> = [
    { id: "daily", kind: "challenge" },
    { id: "words", kind: "word" },
  ];
  return (
    <section className={styles.stack} aria-labelledby="console-content-title">
      <h1 id="console-content-title" className={styles.title}>
        {t("console.content.title")}
      </h1>
      <div className={styles.tabs} role="group" aria-label={t("console.content.sections")}>
        {tabs.map(({ id, kind }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            className={`${styles.tab} ${tab === id ? styles.tabCurrent : ""}`}
            onClick={() => setTab(id)}
          >
            {t(`console.content.tab.${id}`)}
            {needs(kind) ? (
              <span className={styles.badge}>
                <span aria-hidden="true">!</span>
                <span className={styles.srOnly}>{t("console.content.needsAttention")}</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {state.problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {state.problem}
        </p>
      )}
      {state.notice === null ? null : (
        <p role="status" className={styles.notice}>
          {state.notice}
        </p>
      )}
      {state.view === null ? (
        state.problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : tab === "daily" ? (
        <ChallengeTab language={language} state={state} />
      ) : (
        <WordsTab language={language} state={state} />
      )}
    </section>
  );
}

/** The console home's link to this page, with a mark while any daily content is running low (UX 4: alerts as badges). */
export function ConsoleContentLink({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [warn, setWarn] = useState(false);
  useEffect(() => {
    let current = true;
    const today = questifyDayOf(new Date());
    void requestJson("GET", `${API}?from=${today}&to=${today}`).then((result) => {
      const read = result.ok ? readDailyConsole(result.body) : undefined;
      if (current && read !== undefined) {
        setWarn(hasWarning(read.status));
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return (
    <p>
      <a className={styles.textLink} href={`/${language}/console/content`}>
        {t("console.content.title")}
      </a>
      {warn ? (
        <>
          {" "}
          <span className={styles.badge} data-testid="content-badge">
            {t("console.content.needsAttention")}
          </span>
        </>
      ) : null}
    </p>
  );
}
