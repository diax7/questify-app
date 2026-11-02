"use client";

import type { HelpAdmin, Language } from "@questify/shared";
import { useState } from "react";
import {
  CatalogState,
  EditorButtons,
  PairCells,
  PairInputs,
  RowTools,
  useCatalog,
  type Catalog,
} from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import {
  HELP_API,
  checkHelp,
  helpDraftOf,
  isHelpDirty,
  newHelpDraft,
  readHelp,
  type HelpDraft,
} from "#src/lib/console-legal.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Input, Textarea } from "#src/ui/Field.tsx";
import { Stack } from "#src/ui/Section.tsx";

function ArticleEditor({
  language,
  catalog,
  row,
  draft,
  onChange,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<HelpAdmin[]>;
  /** The article being edited; undefined for a new one. */
  row: HelpAdmin | undefined;
  draft: HelpDraft;
  onChange: (next: HelpDraft) => void;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const checked = checkHelp(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const idOk = row !== undefined || /^[a-z][a-z0-9-]{0,63}$/.test(draft.id);
  const invalid = (field: string) => (wrong.has(field) ? t("console.catalog.invalid") : undefined);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (checked.ok && idOk) {
          void catalog
            .save(draft.id, checked.doc)
            .then((saved) => (saved ? onDone() : undefined));
        }
      }}
    >
      <Stack>
        {row === undefined ? (
          <Field
            label={t("console.help.id")}
            error={idOk ? undefined : t("console.catalog.invalid")}
          >
            <Input
              dir="ltr"
              value={draft.id}
              disabled={catalog.busy}
              onChange={(event) => onChange({ ...draft, id: event.target.value })}
            />
          </Field>
        ) : null}
        <PairInputs
          language={language}
          label={t("console.help.question")}
          field="question"
          value={{ ar: draft.questionAr, en: draft.questionEn }}
          invalid={wrong}
          disabled={catalog.busy}
          onChange={(pair) => onChange({ ...draft, questionAr: pair.ar, questionEn: pair.en })}
        />
        <div className={styles.pair}>
          {(["en", "ar"] as const).map((code) => {
            const field = code === "ar" ? "answerAr" : "answerEn";
            return (
              <Field
                key={code}
                label={`${t("console.help.answer")} · ${t(`texts.language.${code}`)}`}
                error={invalid(`answer.${code}`)}
              >
                <Textarea
                  lang={code}
                  dir={directionOf(code)}
                  rows={5}
                  value={draft[field]}
                  disabled={catalog.busy}
                  onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
                />
              </Field>
            );
          })}
        </div>
        <Field label={t("console.help.position")} error={invalid("position")}>
          <Input
            inputMode="numeric"
            dir="ltr"
            value={draft.position}
            disabled={catalog.busy}
            onChange={(event) => onChange({ ...draft, position: event.target.value })}
          />
        </Field>
        <Checkbox
          label={t("console.help.published")}
          checked={draft.published}
          disabled={catalog.busy}
          onChange={(event) => onChange({ ...draft, published: event.target.checked })}
        />
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && idOk && (row === undefined || isHelpDirty(row, draft))}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

function ArticleCard({
  language,
  catalog,
  row,
}: Readonly<{ language: Language; catalog: Catalog<HelpAdmin[]>; row: HelpAdmin }>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<HelpDraft | null>(null);
  const name = row.question[language] === "" ? row.question.en || row.question.ar : row.question[language];
  return (
    <li
      className={styles.card}
      data-testid="help-card"
      data-id={row.id}
      data-editing={draft !== null}
    >
      <div className={styles.head}>
        <span className={styles.name}>
          <span className={styles.code} dir="ltr">
            {row.id}
          </span>
          <Badge tone={row.published ? "success" : "neutral"}>
            {t(row.published ? "console.help.shown" : "console.help.hidden")}
          </Badge>
          {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <RowTools
          language={language}
          name={name}
          busy={catalog.busy}
          open={draft !== null}
          revertible={row.revertible}
          onEdit={() => setDraft(helpDraftOf(row))}
          onRevert={() => void catalog.revert(row.id)}
        />
      </div>
      {draft === null ? (
        <>
          <PairCells language={language} value={row.question} />
          <PairCells language={language} value={row.answer} />
        </>
      ) : (
        <ArticleEditor
          language={language}
          catalog={catalog}
          row={row}
          draft={draft}
          onChange={setDraft}
          onDone={() => setDraft(null)}
        />
      )}
    </li>
  );
}

/**
 * The help and FAQ articles (T-707, FR-1782): each with its question and answer in Arabic and English, either language
 * alone allowed; a reader of the other language is shown the one that exists. An article is hidden until it is ready.
 */
export function HelpArticles({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, HELP_API, readHelp);
  const [fresh, setFresh] = useState<HelpDraft | null>(null);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(rows) => (
          <>
            <ul className={styles.cards}>
              {rows.map((row) => (
                <ArticleCard key={row.id} language={language} catalog={catalog} row={row} />
              ))}
            </ul>
            {fresh === null ? (
              <div>
                <Button variant="secondary" onClick={() => setFresh(newHelpDraft(rows))}>
                  {t("console.help.new")}
                </Button>
              </div>
            ) : (
              <section className={styles.card} aria-label={t("console.help.new")}>
                <ArticleEditor
                  language={language}
                  catalog={catalog}
                  row={undefined}
                  draft={fresh}
                  onChange={setFresh}
                  onDone={() => setFresh(null)}
                />
              </section>
            )}
          </>
        )}
      </CatalogState>
    </Stack>
  );
}
