"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { DailyCadenceControl, DailyUnused, DailyWarnings } from "#src/components/DailyCommon.tsx";
import { DailyQuestionBank } from "#src/components/DailyQuestionBank.tsx";
import { DailySchedule } from "#src/components/DailySchedule.tsx";
import { DailyWordList } from "#src/components/DailyWordList.tsx";
import { DailyWords } from "#src/components/DailyWords.tsx";
import { warningsOf } from "#src/lib/console-daily.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useDailyConsole, type DailyConsoleState } from "#src/lib/use-daily-console.ts";
import { Badge, Muted, Notice, ScreenReaderOnly } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";

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
    <Stack as="section" aria-labelledby="console-content-title">
      <PageHeader titleId="console-content-title" title={t("console.content.title")} />
      <Tabs
        label={t("console.content.sections")}
        items={tabs.map(({ id, kind }) => ({
          key: id,
          label: (
            <>
              {t(`console.content.tab.${id}`)}
              {needs(kind) ? (
                <Badge>
                  <span aria-hidden="true">!</span>
                  <ScreenReaderOnly>{t("console.content.needsAttention")}</ScreenReaderOnly>
                </Badge>
              ) : null}
            </>
          ),
          current: tab === id,
          select: () => setTab(id),
        }))}
      />
      {state.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {state.problem}
        </Notice>
      )}
      {state.notice === null ? null : (
        <Notice tone="info" role="status">
          {state.notice}
        </Notice>
      )}
      {state.view === null ? (
        state.problem === null ? (
          <Muted>{t("common.loading")}</Muted>
        ) : null
      ) : tab === "daily" ? (
        <ChallengeTab language={language} state={state} />
      ) : (
        <WordsTab language={language} state={state} />
      )}
    </Stack>
  );
}
