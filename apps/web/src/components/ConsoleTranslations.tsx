"use client";

import { MATRIX_SHOWS, type Language, type Matrix, type MatrixShow } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { TranslationRow } from "#src/components/TranslationRow.tsx";
import styles from "#src/components/translations.module.css";
import { FIRST_VIEW, pagesOf, rangeOf, type MatrixView } from "#src/lib/console-translations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { useLeaveGuard } from "#src/lib/use-leave-guard.ts";
import { useTranslationEdit, type TranslationEdit } from "#src/lib/use-translation-edit.ts";
import { useTranslationMatrix, type MatrixRead } from "#src/lib/use-translation-matrix.ts";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SEARCH_DELAY_MS = 300;

/** The search box, the screen it is narrowed to and the filter; a change goes through `change`. */
function Filters({
  language,
  view,
  areas,
  change,
}: Readonly<{
  language: Language;
  view: MatrixView;
  areas: Matrix["areas"];
  change: (next: Partial<MatrixView>) => void;
}>) {
  const t = translatorFor(language);
  const [typed, setTyped] = useState(view.q);
  const latest = useRef(change);
  latest.current = change;
  useEffect(() => {
    if (typed.trim() === view.q.trim()) {
      return;
    }
    const timer = setTimeout(() => latest.current({ q: typed }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, view.q]);
  return (
    <>
      <div className={styles.filters}>
        <div className={styles.search}>
          <Field label={t("console.translations.search")}>
            <Input type="search" value={typed} onChange={(event) => setTyped(event.target.value)} />
          </Field>
        </div>
        <div className={styles.area}>
          <Field label={t("console.translations.area")}>
            <Select value={view.area} onChange={(event) => change({ area: event.target.value })}>
              <option value="">{t("console.translations.areaAll")}</option>
              {areas.map((entry) => (
                <option key={entry.area} value={entry.area}>
                  {t("console.translations.areaOption", { area: entry.area, count: entry.count })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Tabs
        label={t("console.translations.show")}
        items={MATRIX_SHOWS.map((show: MatrixShow) => ({
          key: show,
          label: t(`console.translations.show.${show}`),
          current: view.show === show,
          select: () => change({ show }),
        }))}
      />
    </>
  );
}

function Pager({
  language,
  view,
  matrix,
  change,
}: Readonly<{
  language: Language;
  view: MatrixView;
  matrix: Matrix;
  change: (next: Partial<MatrixView>) => void;
}>) {
  const t = translatorFor(language);
  const { from, to } = rangeOf(view.page, matrix.rows.length);
  return (
    <nav className={styles.pager} aria-label={t("console.translations.pages")}>
      <Button
        variant="secondary"
        disabled={view.page === 0}
        onClick={() => change({ page: view.page - 1 })}
      >
        {t("console.translations.previous")}
      </Button>
      <Muted as="span">{t("console.translations.range", { from, to, total: matrix.total })}</Muted>
      <Button
        variant="secondary"
        disabled={view.page + 1 >= pagesOf(matrix.total)}
        onClick={() => change({ page: view.page + 1 })}
      >
        {t("console.translations.next")}
      </Button>
    </nav>
  );
}

/** "Save or discard?" for a step away from an edit that is not saved (FR-1757). */
function LeaveDialog({ language, edit }: Readonly<{ language: Language; edit: TranslationEdit }>) {
  const t = translatorFor(language);
  return (
    <Dialog
      titleId="leave-title"
      describedById="leave-body"
      title={t("console.translations.leaveTitle")}
      busy={edit.busy}
      cancel={() => void edit.answer("keep")}
      actions={
        <>
          <Button variant="secondary" onClick={() => void edit.answer("keep")}>
            {t("console.translations.keepEditing")}
          </Button>
          <Button variant="secondary" onClick={() => void edit.answer("discard")}>
            {t("console.translations.leaveDiscard")}
          </Button>
          <Button variant="primary" onClick={() => void edit.answer("save")}>
            {t("console.translations.save")}
          </Button>
        </>
      }
    >
      <p id="leave-body">
        {t("console.translations.leaveBody", { key: edit.editing?.row.key ?? "" })}
      </p>
    </Dialog>
  );
}

/** What was just done, a failed read, or the wait for the first page. */
function Notices({
  language,
  read,
  edit,
}: Readonly<{ language: Language; read: MatrixRead; edit: TranslationEdit }>) {
  const t = translatorFor(language);
  if (read.failure !== null) {
    return (
      <Notice tone="danger" role="alert">
        {describeProblem(read.failure, language, t).text}
      </Notice>
    );
  }
  if (edit.done !== null) {
    return (
      <Notice tone="success" role="status">
        {t(`console.translations.${edit.done.kind}`, { key: edit.done.key })}
      </Notice>
    );
  }
  return read.matrix === null ? <Muted role="status">{t("common.loading")}</Muted> : null;
}

/** The rows of one page. Reverting the key that is open needs no question: its edit goes with it. */
function RowList({
  language,
  rows,
  loading,
  edit,
}: Readonly<{
  language: Language;
  rows: Matrix["rows"];
  loading: boolean;
  edit: TranslationEdit;
}>) {
  const t = translatorFor(language);
  return (
    <ul className={styles.list} aria-busy={loading} aria-label={t("console.translations.title")}>
      {rows.map((row) => (
        <TranslationRow
          key={row.key}
          uiLanguage={language}
          row={row}
          editing={edit.editing}
          busy={edit.busy}
          problem={edit.problem}
          onEdit={() => edit.guard(() => edit.start(row))}
          onRevert={() =>
            edit.editing?.row.key === row.key
              ? void edit.revert(row)
              : edit.guard(() => void edit.revert(row))
          }
          onType={edit.type}
          onSave={() => void edit.save()}
          onDiscard={edit.discard}
        />
      ))}
    </ul>
  );
}

/**
 * The console's App texts (T-702, FR-1765, FR-1766): every text of the app as a row of key, English and Arabic with the
 * shipped text kept in view for a changed one, searchable, narrowed by screen and by what is missing, edited one row at
 * a time and reverted to the shipped text. A change reaches installed apps within a minute. Leaving with an edit that is
 * not saved asks whether to save or discard it. Legal and consent texts are shown read-only.
 */
export function ConsoleTranslations({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [view, setView] = useState<MatrixView>(FIRST_VIEW);
  const read = useTranslationMatrix(view);
  const edit = useTranslationEdit(language, read.replace);
  const change = (next: Partial<MatrixView>): void =>
    edit.guard(() => setView((now) => ({ ...now, page: 0, ...next })));
  useLeaveGuard(edit.dirty, edit.guard);
  const { matrix } = read;
  return (
    <Stack as="section" aria-labelledby="console-translations-title">
      <PageHeader
        titleId="console-translations-title"
        title={t("console.translations.title")}
        info={infoTip(t, "console.translations.intro")}
      />
      <Filters language={language} view={view} areas={matrix?.areas ?? []} change={change} />
      <Notices language={language} read={read} edit={edit} />
      {matrix === null ? null : (
        <>
          {matrix.rows.length === 0 ? <Muted>{t("console.translations.empty")}</Muted> : null}
          <RowList language={language} rows={matrix.rows} loading={read.loading} edit={edit} />
          <Pager language={language} view={view} matrix={matrix} change={change} />
        </>
      )}
      {edit.waiting === null ? null : <LeaveDialog language={language} edit={edit} />}
    </Stack>
  );
}
