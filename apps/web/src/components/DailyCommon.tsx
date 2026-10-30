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
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import {
  LANGUAGE_NAME_KEY,
  formatDay,
  readCadenceChange,
  warningsOf,
  type CadenceState,
} from "#src/lib/console-daily.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import type { DailyWrite } from "#src/lib/use-daily-console.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Select } from "#src/ui/Field.tsx";
import { Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

/** The confirmation before a scheduled challenge, word or stranded item is deleted for good. */
export function RemoveDialog({
  language,
  path,
  busy,
  write,
  close,
}: Readonly<{
  language: Language;
  /** The DELETE path under the daily API, e.g. `/challenges/2026-11-01`. */
  path: string;
  busy: boolean;
  write: DailyWrite;
  close: () => void;
}>) {
  const t = translatorFor(language);
  const remove = async () => {
    await write({ method: "DELETE", path, done: t("console.daily.removed") });
    close();
  };
  return (
    <ConfirmDialog
      language={language}
      title={t("console.daily.removeTitle")}
      body={t("console.daily.removeBody")}
      confirmLabel={t("console.daily.remove")}
      noteLabel={null}
      busy={busy}
      cancel={close}
      confirm={() => void remove()}
    />
  );
}

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
        <Notice
          tone="warning"
          key={warning.language ?? "challenge"}
          role="status"
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
        </Notice>
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
    <Form card onSubmit={(event) => void save(event)}>
      <Field label={t(`console.daily.cadence.label.${kind}`)}>
        <Select
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value as DailyCadence)}
        >
          {DAILY_CADENCES.map((cadence) => (
            <option key={cadence} value={cadence}>
              {t(`console.daily.cadence.${cadence}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Muted>{t("console.daily.cadence.note")}</Muted>
      {state.next === null ? null : (
        <Muted data-testid="daily-cadence-pending">
          {t("console.daily.cadence.pending", {
            date: formatDay(state.next.from, language),
            cadence: t(`console.daily.cadence.${state.next.cadence}`),
          })}
        </Muted>
      )}
      <Toolbar>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("console.daily.cadence.save")}
        </Button>
      </Toolbar>
    </Form>
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
  const [removing, setRemoving] = useState<string | null>(null);
  const rows = unused.filter((row) => row.kind === kind);
  if (rows.length === 0) {
    return null;
  }
  return (
    <Stack as="section" aria-labelledby={`daily-unused-${kind}`}>
      <SubHeading as="h2" id={`daily-unused-${kind}`}>
        {t("console.daily.unused")}
      </SubHeading>
      <Muted>{t("console.daily.unusedBody")}</Muted>
      {removing === null ? null : (
        <RemoveDialog
          language={language}
          path={removing}
          busy={busy}
          write={write}
          close={() => setRemoving(null)}
        />
      )}
      <CardList>
        {rows.map((row) => (
          <Card as="li" key={`${row.language ?? ""}${row.startsOn}`} data-testid="daily-unused">
            <span>
              {row.language === null
                ? t("console.daily.unusedChallenge", { date: formatDay(row.startsOn, language) })
                : t("console.daily.unusedWord", {
                    language: t(LANGUAGE_NAME_KEY[row.language]),
                    date: formatDay(row.startsOn, language),
                  })}
            </span>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                setRemoving(
                  row.language === null
                    ? `/challenges/${row.startsOn}`
                    : `/words/${row.language}/${row.startsOn}`,
                )
              }
            >
              {t("console.daily.remove")}
            </Button>
          </Card>
        ))}
      </CardList>
    </Stack>
  );
}
