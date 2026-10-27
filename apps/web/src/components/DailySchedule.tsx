"use client";

import {
  formatNumber,
  type AdminDailyQuestion,
  type DailyConsole,
  type Language,
} from "@questify/shared";
import { useState, type FormEvent } from "react";
import { ChallengeEditor } from "#src/components/DailyChallengeEditor.tsx";
import { RemoveDialog } from "#src/components/DailyCommon.tsx";
import { formatPeriod, hasStarted, textIn } from "#src/lib/console-daily.ts";
import {
  BLANK_CHALLENGE,
  challengeBodyOf,
  challengeDraftOf,
  type ChallengeDraft,
} from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import type { DailyConsoleState } from "#src/lib/use-daily-console.ts";
import styles from "#src/components/layout.module.css";

type Period = DailyConsole["periods"][number];
type Editing = Readonly<{ startsOn: string; endsOn: string; draft: ChallengeDraft }>;

function ChallengeSummary({
  language,
  challenge,
  questions,
}: Readonly<{
  language: Language;
  challenge: NonNullable<Period["challenge"]>;
  questions: readonly AdminDailyQuestion[];
}>) {
  const t = translatorFor(language);
  return (
    <>
      <ol>
        {challenge.questions.map((id) => {
          const question = questions.find((candidate) => candidate.id === id);
          return (
            <li key={id} dir="auto">
              {question === undefined ? "-" : textIn(question.prompt, language)}
            </li>
          );
        })}
      </ol>
      {challenge.sponsor === null ? null : (
        <p className={styles.muted}>
          {t("console.daily.sponsorLine", { name: textIn(challenge.sponsor, language) })}
        </p>
      )}
      {challenge.finishes === 0 ? null : (
        <p className={styles.muted}>
          {t("console.daily.finishes", { count: formatNumber(challenge.finishes, language) })}
        </p>
      )}
    </>
  );
}

function PeriodCard({
  language,
  period,
  today,
  questions,
  busy,
  edit,
  clear,
}: Readonly<{
  language: Language;
  period: Period;
  today: string;
  questions: readonly AdminDailyQuestion[];
  busy: boolean;
  edit: () => void;
  clear: () => void;
}>) {
  const t = translatorFor(language);
  const started = hasStarted(period.startsOn, today);
  const challenge = period.challenge ?? null;
  const button = (label: string, onClick: () => void) => (
    <button type="button" className={styles.quiet} disabled={busy} onClick={onClick}>
      {label}
    </button>
  );
  return (
    <li className={styles.formCard} data-testid="daily-period">
      <p className={styles.row}>
        <strong>{formatPeriod(period.startsOn, period.endsOn, language)}</strong>
        {started ? <span className={styles.badge}>{t("console.daily.started")}</span> : null}
      </p>
      {challenge === null ? (
        <p className={styles.muted}>
          {t(
            period.startsOn === period.endsOn
              ? "console.daily.emptyDay"
              : "console.daily.emptyWeek",
          )}
        </p>
      ) : (
        <ChallengeSummary language={language} challenge={challenge} questions={questions} />
      )}
      {started ? null : (
        <div className={styles.actions}>
          {button(
            t(challenge === null ? "console.daily.setChallenge" : "console.daily.edit"),
            edit,
          )}
          {challenge === null ? null : button(t("console.daily.remove"), clear)}
        </div>
      )}
    </li>
  );
}

function draftOf(period: Period): ChallengeDraft {
  const challenge = period.challenge ?? null;
  return challenge === null
    ? BLANK_CHALLENGE
    : challengeDraftOf(challenge.questions, challenge.sponsor);
}

/** The challenge schedule by period (FR-732, FR-1733): the empty periods marked, one editor open at a time. */
export function DailySchedule({
  language,
  state,
  view,
  questions,
}: Readonly<{
  language: Language;
  state: DailyConsoleState;
  view: DailyConsole;
  questions: readonly AdminDailyQuestion[];
}>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const periods = view.periods.filter((period) => period.kind === "challenge");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (editing === null) {
      return;
    }
    const checked = challengeBodyOf(editing.draft);
    if (!checked.ok) {
      state.setProblem(t(`console.daily.invalid.${checked.field}`));
      return;
    }
    const done = await state.write({
      method: "PUT",
      path: `/challenges/${editing.startsOn}`,
      body: checked.body,
      done: t("console.daily.challengeSaved"),
    });
    if (done !== null) {
      setEditing(null);
    }
  };
  return (
    <section aria-labelledby="daily-schedule" className={styles.stack}>
      <h2 id="daily-schedule" className={styles.subtitle}>
        {t("console.daily.schedule")}
      </h2>
      {editing === null ? null : (
        <ChallengeEditor
          language={language}
          startsOn={editing.startsOn}
          endsOn={editing.endsOn}
          draft={editing.draft}
          questions={questions}
          busy={state.busy}
          change={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })}
          cancel={() => setEditing(null)}
          submit={(event) => void save(event)}
        />
      )}
      {removing === null ? null : (
        <RemoveDialog
          language={language}
          path={removing}
          busy={state.busy}
          write={state.write}
          close={() => setRemoving(null)}
        />
      )}
      <ul className={styles.list}>
        {periods.map((period) => (
          <PeriodCard
            key={period.startsOn}
            language={language}
            period={period}
            today={state.today}
            questions={questions}
            busy={state.busy}
            edit={() =>
              setEditing({
                startsOn: period.startsOn,
                endsOn: period.endsOn,
                draft: draftOf(period),
              })
            }
            clear={() => setRemoving(`/challenges/${period.startsOn}`)}
          />
        ))}
      </ul>
    </section>
  );
}
