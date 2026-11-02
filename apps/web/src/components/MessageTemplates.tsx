"use client";

import {
  MESSAGE_TEMPLATE_KEYS,
  TEMPLATE_RULES,
  fillSamples,
  smsParts,
  type Language,
  type MessageTemplateAdmin,
  type MessageTemplateKey,
} from "@questify/shared";
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
  TEMPLATE_NAMES,
  checkTemplate,
  hasTitle,
  isTemplateDirty,
  placeholdersOf,
  readTemplates,
  templateDraftOf,
  type TemplateDraft,
} from "#src/lib/console-messaging.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Field, Textarea } from "#src/ui/Field.tsx";
import { Stack } from "#src/ui/Section.tsx";

const LANGUAGES = ["en", "ar"] as const satisfies readonly Language[];

function TemplateEditor({
  language,
  catalog,
  row,
  draft,
  onChange,
  onDone,
}: Readonly<{
  language: Language;
  catalog: Catalog<MessageTemplateAdmin[]>;
  row: MessageTemplateAdmin;
  draft: TemplateDraft;
  onChange: (next: TemplateDraft) => void;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const key: MessageTemplateKey = row.key;
  const check = checkTemplate(key, draft);
  const wrong = check.ok ? new Set<string>() : check.fields;
  const reasons = (field: string): string | undefined => {
    const codes = check.problems.get(field);
    return codes === undefined
      ? wrong.has(field)
        ? t("console.catalog.invalid")
        : undefined
      : codes.map((code) => t(`console.messages.issue.${code}`)).join(" ");
  };
  const taken = placeholdersOf(key);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (check.ok) {
          void catalog.save(key, check.doc).then((saved) => (saved ? onDone() : undefined));
        }
      }}
    >
      <Stack>
        {hasTitle(key) ? (
          <PairInputs
            language={language}
            label={t("console.messages.subject")}
            field="title"
            value={{ ar: draft.titleAr, en: draft.titleEn }}
            invalid={wrong}
            disabled={catalog.busy}
            onChange={(pair) => onChange({ ...draft, titleAr: pair.ar, titleEn: pair.en })}
          />
        ) : null}
        <div className={styles.pair}>
          {LANGUAGES.map((code) => {
            const field = code === "ar" ? "bodyAr" : "bodyEn";
            return (
              <Field
                key={code}
                label={`${t("console.messages.text")} · ${t(`texts.language.${code}`)}`}
                error={reasons(`body.${code}`)}
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
        <Muted>
          {taken.length === 0
            ? t("console.messages.noPlaceholders")
            : t("console.messages.placeholders", {
                names: taken.map((name) => `{${name}}`).join(" "),
              })}
        </Muted>
        <EditorButtons
          language={language}
          busy={catalog.busy}
          canSave={check.ok && isTemplateDirty(row, draft)}
          onDiscard={onDone}
        />
      </Stack>
    </form>
  );
}

/** For an SMS, how many parts each language's text takes once its placeholders are filled (the limit is 3). */
function SmsParts({ language, row }: Readonly<{ language: Language; row: MessageTemplateAdmin }>) {
  const t = translatorFor(language);
  if (TEMPLATE_RULES[row.key].channel !== "sms") {
    return null;
  }
  return (
    <Muted data-testid="sms-parts">
      {t("console.messages.parts", {
        ar: smsParts(fillSamples(row.body.ar, "ar")),
        en: smsParts(fillSamples(row.body.en, "en")),
      })}
    </Muted>
  );
}

function TemplateCard({
  language,
  catalog,
  row,
}: Readonly<{
  language: Language;
  catalog: Catalog<MessageTemplateAdmin[]>;
  row: MessageTemplateAdmin;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const name = t(TEMPLATE_NAMES[row.key]);
  return (
    <li
      className={styles.card}
      data-testid="template-card"
      data-id={row.key}
      data-editing={draft !== null}
    >
      <div className={styles.head}>
        <span className={styles.name}>
          <span>{name}</span>
          <Badge tone="neutral">
            {t(`console.messages.channel.${TEMPLATE_RULES[row.key].channel}`)}
          </Badge>
          {row.revertible ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <RowTools
          language={language}
          name={name}
          busy={catalog.busy}
          open={draft !== null}
          revertible={row.revertible}
          onEdit={() => setDraft(templateDraftOf(row))}
          onRevert={() => void catalog.revert(row.key)}
        />
      </div>
      {draft === null ? (
        <>
          {row.title === null ? null : (
            <PairCells
              language={language}
              value={row.title}
              label={t("console.messages.subject")}
            />
          )}
          <PairCells language={language} value={row.body} />
          <SmsParts language={language} row={row} />
        </>
      ) : (
        <TemplateEditor
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
 * The login-code SMS and the promotional SMS, email and push (T-706, FR-1780). A text that breaks a CST rule is marked with
 * its reason and cannot be saved: an SMS names Questify, a login code says what it is, a promotional SMS or email carries
 * the opt-out link, and an SMS stays within 3 parts.
 */
export function MessageTemplates({ language }: Readonly<{ language: Language }>) {
  const catalog = useCatalog(language, TEMPLATES_API, readTemplates);
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(rows) => (
          <ul className={styles.cards}>
            {MESSAGE_TEMPLATE_KEYS.flatMap((key) => rows.filter((row) => row.key === key)).map(
              (row) => (
                <TemplateCard key={row.key} language={language} catalog={catalog} row={row} />
              ),
            )}
          </ul>
        )}
      </CatalogState>
    </Stack>
  );
}
