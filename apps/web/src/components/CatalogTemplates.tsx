"use client";

import type { Language, TemplateAdmin, TemplateDoc } from "@questify/shared";
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
  TEMPLATES_API,
  checkTemplate,
  isTemplateDirty,
  isTemplateKey,
  newTemplateDraft,
  readTemplates,
  storedBodyIssues,
  templateCounts,
  templateDraftOf,
  type Checked,
  type TemplateDraft,
} from "#src/lib/console-catalog.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Badge, Notice } from "#src/ui/Feedback.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Checkbox, Field, Input, Textarea } from "#src/ui/Field.tsx";
import { Stack } from "#src/ui/Section.tsx";

type EditorProps = Readonly<{
  language: Language;
  catalog: Catalog<TemplateAdmin[]>;
  draft: TemplateDraft;
  row: TemplateAdmin | undefined;
  onChange: (next: TemplateDraft) => void;
  onDone: () => void;
}>;

type TextsProps = Readonly<{
  language: Language;
  draft: TemplateDraft;
  isNew: boolean;
  wrong: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: TemplateDraft) => void;
}>;

/** The key (new templates only), the name and description in both languages, and whether organizers are offered it. */
function TemplateTexts({ language, draft, isNew, wrong, disabled, onChange }: TextsProps) {
  const t = translatorFor(language);
  return (
    <>
      {isNew ? (
        <Field
          label={t("console.catalog.templates.key")}
          help={t("console.catalog.templates.keyHelp")}
          error={
            draft.key !== "" && !isTemplateKey(draft.key) ? t("console.catalog.invalid") : undefined
          }
        >
          <Input
            dir="ltr"
            value={draft.key}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, key: event.target.value.trim() })}
          />
        </Field>
      ) : null}
      <PairInputs
        language={language}
        label={t("console.catalog.templates.name")}
        field="name"
        value={draft.name}
        invalid={wrong}
        disabled={disabled}
        onChange={(name) => onChange({ ...draft, name })}
      />
      <PairInputs
        language={language}
        label={t("console.catalog.templates.description")}
        field="description"
        value={draft.description}
        invalid={wrong}
        disabled={disabled}
        onChange={(description) => onChange({ ...draft, description })}
      />
      <Checkbox
        label={t("console.catalog.templates.enabled")}
        checked={draft.enabled}
        disabled={disabled}
        onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
      />
    </>
  );
}

/** The setup as JSON, and the lines that say what is wrong with it once the admin has changed something. */
function TemplateSetup({
  language,
  draft,
  checked,
  shown,
  disabled,
  onChange,
}: Readonly<{
  language: Language;
  draft: TemplateDraft;
  checked: Checked<TemplateDoc>;
  shown: boolean;
  disabled: boolean;
  onChange: (next: TemplateDraft) => void;
}>) {
  const t = translatorFor(language);
  const wrong = checked.ok ? [] : [...checked.fields];
  return (
    <>
      <Field
        label={t("console.catalog.templates.setup")}
        error={
          wrong.some((field) => field.startsWith("body")) ? t("console.catalog.invalid") : undefined
        }
      >
        <Textarea
          className={styles.setup}
          dir="ltr"
          lang="en"
          rows={14}
          spellCheck={false}
          value={draft.body}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, body: event.target.value })}
        />
      </Field>
      {checked.ok || !shown ? null : (
        <Notice tone="warning" as="div">
          {t("console.catalog.templates.issues")}
          <ul className={styles.issues} dir="ltr">
            {checked.messages.slice(0, 8).map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      )}
    </>
  );
}

/** The boxes of one template and Save and Discard. */
function TemplateEditor({ language, catalog, draft, row, onChange, onDone }: EditorProps) {
  const checked = checkTemplate(draft);
  const keyOk = row !== undefined || isTemplateKey(draft.key);
  const dirty =
    row === undefined ? draft.key !== "" || draft.name.en !== "" : isTemplateDirty(row, draft);
  const submit = async (): Promise<void> => {
    if (checked.ok && (await catalog.save(draft.key, checked.doc))) {
      onDone();
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack>
        <TemplateTexts
          language={language}
          draft={draft}
          isNew={row === undefined}
          wrong={checked.ok ? new Set<string>() : checked.fields}
          disabled={catalog.busy}
          onChange={onChange}
        />
        <TemplateSetup
          language={language}
          draft={draft}
          checked={checked}
          shown={dirty}
          disabled={catalog.busy}
          onChange={onChange}
        />
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={checked.ok && keyOk && dirty}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

function TemplateCard({
  language,
  catalog,
  row,
  editing,
  onEdit,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<TemplateAdmin[]>;
  row: TemplateAdmin;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<TemplateDraft>(() => templateDraftOf(row));
  const counts = templateCounts(row);
  const broken = storedBodyIssues(row).length > 0;
  return (
    <li
      className={styles.card}
      data-testid="template-card"
      data-key={row.key}
      data-editing={editing}
    >
      <div className={styles.head}>
        <span className={styles.name}>
          <code className={styles.code} dir="ltr">
            {row.key}
          </code>
          {row.enabled ? null : <Badge>{t("console.catalog.templates.off")}</Badge>}
          {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <RowTools
          language={language}
          name={row.name[language]}
          busy={catalog.busy}
          open={editing}
          revertible={row.revertible}
          onEdit={() => {
            setDraft(templateDraftOf(row));
            onEdit();
          }}
          onRevert={() => void catalog.revert(row.key)}
        />
      </div>
      {editing ? (
        <TemplateEditor
          language={language}
          catalog={catalog}
          draft={draft}
          row={row}
          onChange={setDraft}
          onDone={onDone}
        />
      ) : (
        <>
          <PairCells language={language} value={row.name} />
          <PairCells language={language} value={row.description} />
          {broken ? <Notice tone="warning">{t("console.catalog.templates.broken")}</Notice> : null}
          {counts === undefined ? null : (
            <p className={styles.facts}>{t("console.catalog.templates.counts", counts)}</p>
          )}
        </>
      )}
    </li>
  );
}

/**
 * The event templates (T-709b, FR-1403): every template as an equal card with its name and description in both
 * languages, edited in place. The setup is JSON, checked by the template schema before it saves; a change applies to
 * events made afterwards and every earlier event keeps what it got.
 */
export function CatalogTemplates({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, TEMPLATES_API, readTemplates);
  const [open, setOpen] = useState<string | null>(null);
  const [fresh, setFresh] = useState<TemplateDraft | null>(null);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(rows) => (
          <>
            <ul className={styles.cards}>
              {rows.map((row) => (
                <TemplateCard
                  key={row.key}
                  language={language}
                  catalog={catalog}
                  row={row}
                  editing={open === row.key}
                  onEdit={() => setOpen(row.key)}
                  onDone={() => setOpen(null)}
                />
              ))}
            </ul>
            {fresh === null ? (
              <div>
                <Button variant="secondary" onClick={() => setFresh(newTemplateDraft(rows[0]))}>
                  {t("console.catalog.templates.new")}
                </Button>
              </div>
            ) : (
              <section className={styles.card} aria-label={t("console.catalog.templates.new")}>
                <TemplateEditor
                  language={language}
                  catalog={catalog}
                  draft={fresh}
                  row={undefined}
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
