"use client";

import type {
  DailyCadence,
  DailyCadenceChange,
  DailyConsole,
  DailyKind,
  Language,
} from "@questify/shared";
import { DAILY_CADENCES } from "@questify/shared";
import { useState, type FormEvent } from "react";
import {
  LANGUAGE_NAME_KEY,
  formatDay,
  readCadenceChange,
  warningsOf,
  type CadenceState,
} from "#src/lib/console-daily.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import type { DailyWrite } from "#src/lib/use-daily-console.ts";
import styles from "#src/components/layout.module.css";

/** The warnings for one kind: the challenge, or the words (each language that runs low, on its own). */
export function DailyWarnings({
  language,
  status,
  kind,
}: Readonly<{ language: Language; status: DailyConsole["status"]; kind: DailyKind }>) {
  const t = translatorFor(language);
  const found = warningsOf(status).filter((warning) => warning.kind === kind);
  return (
    <>
      {found.map((warning) => (
        <p
          key={warning.language ?? "challenge"}
          role="status"
          className={styles.warning}
          data-testid="daily-warning"
        >
          {warning.language === null
            ? t("console.daily.warn.challenge", {
                days: warning.coveredDays,
                periods: warning.coveredPeriods,
              })
            : t("console.daily.warn.word", {
                language: t(LANGUAGE_NAME_KEY[warning.language]),
                periods: warning.coveredPeriods,
              })}
        </p>
      ))}
    </>
  );
}

/** What to tell the admin after a cadence change: when it applies, and the content it left on non-start days. */
function cadenceNotice(change: DailyCadenceChange, language: Language, t: Translate): string {
  const first =
    change.from === undefined
      ? t("console.daily.cadence.unchanged")
      : t("console.daily.cadence.saved", { date: formatDay(change.from, language) });
  return change.unused === 0
    ? first
    : `${first} ${t("console.daily.cadence.unused", { count: change.unused })}`;
}

/** The period control of one kind: every day or every week, from tomorrow (FR-1814). */
export function DailyCadenceControl({
  language,
  kind,
  state,
  busy,
  write,
  setNotice,
}: Readonly<{
  language: Language;
  kind: DailyKind;
  state: CadenceState;
  busy: boolean;
  write: DailyWrite;
  setNotice: (notice: string) => void;
}>) {
  const t = translatorFor(language);
  const [choice, setChoice] = useState<DailyCadence>(state.next?.cadence ?? state.cadence);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const done = await write({ method: "PUT", path: "/cadence", body: { kind, cadence: choice } });
    const change = done === null ? undefined : readCadenceChange(done.body);
    if (change !== undefined) {
      setNotice(cadenceNotice(change, language, t));
    }
  };
  return (
    <form className={styles.formCard} onSubmit={(event) => void save(event)}>
      <label className={styles.field}>
        {t(`console.daily.cadence.label.${kind}`)}
        <select
          className={styles.input}
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value as DailyCadence)}
        >
          {DAILY_CADENCES.map((cadence) => (
            <option key={cadence} value={cadence}>
              {t(`console.daily.cadence.${cadence}`)}
            </option>
          ))}
        </select>
      </label>
      <p className={styles.muted}>{t("console.daily.cadence.note")}</p>
      {state.next === null ? null : (
        <p className={styles.muted} data-testid="daily-cadence-pending">
          {t("console.daily.cadence.pending", {
            date: formatDay(state.next.from, language),
            cadence: t(`console.daily.cadence.${state.next.cadence}`),
          })}
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("console.daily.cadence.save")}
        </button>
      </div>
    </form>
  );
}

/** Content saved on a day that no longer starts a period: players never see it, and it can be removed (MINOR-7). */
export function DailyUnused({
  language,
  kind,
  unused,
  busy,
  write,
}: Readonly<{
  language: Language;
  kind: DailyKind;
  unused: DailyConsole["unused"];
  busy: boolean;
  write: DailyWrite;
}>) {
  const t = translatorFor(language);
  const rows = unused.filter((row) => row.kind === kind);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={`daily-unused-${kind}`} className={styles.stack}>
      <h2 id={`daily-unused-${kind}`} className={styles.subtitle}>
        {t("console.daily.unused")}
      </h2>
      <p className={styles.muted}>{t("console.daily.unusedBody")}</p>
      <ul className={styles.list}>
        {rows.map((row) => (
          <li
            key={`${row.language ?? ""}${row.startsOn}`}
            className={styles.card}
            data-testid="daily-unused"
          >
            <span>
              {row.language === null
                ? t("console.daily.unusedChallenge", { date: formatDay(row.startsOn, language) })
                : t("console.daily.unusedWord", {
                    language: t(LANGUAGE_NAME_KEY[row.language]),
                    date: formatDay(row.startsOn, language),
                  })}
            </span>
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() =>
                void write({
                  method: "DELETE",
                  path:
                    row.language === null
                      ? `/challenges/${row.startsOn}`
                      : `/words/${row.language}/${row.startsOn}`,
                  done: t("console.daily.removed"),
                })
              }
            >
              {t("console.daily.remove")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
